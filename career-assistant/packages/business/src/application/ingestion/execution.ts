import {
  SourceTaskEntity,
  newSourceTask,
} from '../../domain/ingestion/task.js';
import { SourceVersionEntity } from '../../domain/ingestion/evidence.js';
import { IngestionError } from '../../domain/ingestion/errors.js';
import { INGESTION_POLICY as policy } from '../../domain/ingestion/policy.js';
import type {
  IngestionDependencies,
  IngestionRepository,
  FetchedEvidence,
  FetchedList,
} from './ports.js';
import {
  ensureResource,
  saveTask,
  saveResource,
  ingestionOperation,
} from './support.js';

/** 外部执行与提交分开，实体的租约判断是所有成功/失败写入的前置条件。 */
export class SourceExecutionService {
  private claims = 0;
  constructor(private readonly d: IngestionDependencies) {}
  async claim(): Promise<SourceTaskEntity | null> {
    return ingestionOperation(() =>
      this.d.unitOfWork.run(async (c) => {
        const repo = this.d.repositories(c);
        const now = await repo.now();
        await repo.reapExpired(now, 100);
        const candidate =
          (await repo.claimCandidate(now, (this.claims + 1) % 10 === 0)) ??
          (await repo.claimCandidate(now, false));
        if (!candidate) return null;
        this.claims++;
        const previous = candidate.snapshot();
        const current = candidate.claim(now);
        await saveTask(repo, current, previous.fencingToken);
        if (previous.status === 'running' && previous.attempt > 0) {
          const attempt = await repo.getAttempt(previous.id, previous.attempt);
          await repo.endAttempt({
            ...attempt,
            endedAt: now,
            resultCode: 'LEASE_EXPIRED',
          });
        }
        await repo.insertAttempt({
          id: this.d.id(),
          taskId: previous.id,
          attempt: current.snapshot().attempt,
          token: current.snapshot().fencingToken,
          startedAt: now,
          endedAt: null,
          resultCode: null,
          nextRetryAt: null,
        });
        return current;
      }),
    );
  }
  async renew(task: SourceTaskEntity): Promise<void> {
    await this.d.unitOfWork.run(async (c) => {
      const repo = this.d.repositories(c);
      const current = await repo.getTask(task.snapshot().id, true);
      if (!current) throw new IngestionError('TASK_VERSION_CONFLICT');
      const renewed = current.renew(
        task.snapshot().fencingToken,
        await repo.now(),
      );
      await saveTask(repo, renewed);
    });
  }
  async runOne(): Promise<boolean> {
    const task = await this.claim();
    if (!task) return false;
    await this.execute(task);
    return true;
  }
  async execute(task: SourceTaskEntity): Promise<void> {
    let heartbeatFailure = false;
    let renewing: Promise<void> | null = null;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = this.renew(task)
        .catch(() => {
          heartbeatFailure = true;
        })
        .finally(() => {
          renewing = null;
        });
    }, policy.heartbeatMs);
    timer.unref();
    try {
      const target = task.snapshot().target;
      if (target.kind === 'discover') {
        const page = await this.d.source.list(target.page);
        if (heartbeatFailure) throw new IngestionError('TASK_VERSION_CONFLICT');
        await this.commitDiscovery(task, page);
      } else {
        const resource = await this.d.unitOfWork.run((c) =>
          this.d.repositories(c).getResource(target.resourceId),
        );
        if (!resource) throw new IngestionError('INGESTION_NOT_FOUND');
        await this.d.unitOfWork.run(async (c) => {
          const repo = this.d.repositories(c);
          await repo.lockStream('new');
          const current = await repo.getResource(target.resourceId, true);
          const live = await repo.getTask(task.snapshot().id, true);
          if (!current || !live)
            throw new IngestionError('TASK_VERSION_CONFLICT');
          const now = await repo.now();
          live.assertLease(task.snapshot().fencingToken, now);
          await saveResource(
            repo,
            current.attempt(now),
            current.snapshot().stateVersion,
          );
        });
        const observation = await this.d.source.evidence(
          resource.snapshot().kind,
          resource.snapshot().sourceId,
        );
        if (heartbeatFailure) throw new IngestionError('TASK_VERSION_CONFLICT');
        const content = JSON.stringify({
          format: 'sanitized-text-v1',
          parserVersion: observation.body.parserVersion,
          blocks: observation.body.blocks,
        });
        const snapshotId = this.d.id();
        await this.d.files.put(snapshotId, new TextEncoder().encode(content));
        await this.commitEvidence(task, observation, snapshotId, content);
      }
    } catch (error) {
      const failure =
        error instanceof IngestionError
          ? error
          : Object.assign(new IngestionError('INGESTION_STORAGE_UNAVAILABLE'), {
              cause: error,
            });
      if (failure.code !== 'TASK_VERSION_CONFLICT')
        await this.fail(task, failure);
    } finally {
      clearInterval(timer);
      if (renewing) await renewing;
    }
  }
  private async commitDiscovery(task: SourceTaskEntity, page: FetchedList) {
    await this.d.unitOfWork.run(async (c) => {
      const repo = this.d.repositories(c);
      const target = task.snapshot().target;
      if (target.kind !== 'discover')
        throw new IngestionError('TASK_VERSION_CONFLICT');
      const stream = await repo.lockStream(target.streamKey);
      const live = await repo.getTask(task.snapshot().id, true);
      const now = await repo.now();
      if (!live) throw new IngestionError('TASK_VERSION_CONFLICT');
      live.assertLease(task.snapshot().fencingToken, now);
      if (
        stream.snapshot().generation !== target.generation ||
        stream.snapshot().checkpointVersion !== target.checkpointVersion
      )
        throw new IngestionError('TASK_VERSION_CONFLICT');
      for (const id of page.jobIds) {
        const resource = await ensureResource(repo, this.d, 'job', id, now);
        await repo.insertTaskIfAbsent(
          newSourceTask(
            this.d.id(),
            `discovered:${target.generation}:${resource.snapshot().id}:${this.d.id()}`,
            `fetch:${resource.snapshot().id}`,
            { kind: 'fetch', resourceId: resource.snapshot().id },
            now,
          ),
        );
      }
      const nextPage = page.nextPage ?? target.page + 1;
      const nextStream = stream.advance(
        target.checkpointVersion,
        target.generation,
        nextPage,
      );
      if (
        !(await repo.updateStream(nextStream, stream.snapshot().stateVersion))
      )
        throw new IngestionError('TASK_VERSION_CONFLICT');
      await this.complete(repo, live, now);
      if (page.nextPage !== null && target.remaining > 1) {
        await repo.insertTaskIfAbsent(
          newSourceTask(
            this.d.id(),
            `discover-page:${target.streamKey}:${target.generation}:${nextPage}`,
            `discover:${target.streamKey}`,
            {
              ...target,
              page: nextPage,
              remaining: target.remaining - 1,
              checkpointVersion: nextStream.snapshot().checkpointVersion,
            },
            now,
            4,
          ),
        );
      }
    });
  }
  private async commitEvidence(
    task: SourceTaskEntity,
    observation: FetchedEvidence,
    snapshotId: string,
    content: string,
  ) {
    await this.d.unitOfWork.run(async (c) => {
      const repo = this.d.repositories(c);
      await repo.lockStream('new');
      const target = task.snapshot().target;
      if (target.kind !== 'fetch')
        throw new IngestionError('TASK_VERSION_CONFLICT');
      const resource = await repo.getResource(target.resourceId, true);
      const live = await repo.getTask(task.snapshot().id, true);
      const now = await repo.now();
      if (!resource || !live) throw new IngestionError('TASK_VERSION_CONFLICT');
      live.assertLease(task.snapshot().fencingToken, now);
      const hash = this.d.digest(JSON.stringify(observation.body));
      let version = await repo.findVersion(target.resourceId, hash);
      if (!version) {
        await repo.lockFile(snapshotId);
        if (!(await this.d.files.exists(snapshotId)))
          throw new IngestionError('INGESTION_STORAGE_UNAVAILABLE');
        await repo.insertSnapshot({
          id: snapshotId,
          sanitizedDigest: this.d.digest(content),
          byteLength: new TextEncoder().encode(content).length,
          format: 'sanitized-text-v1',
          createdAt: now,
        });
        version = new SourceVersionEntity({
          id: this.d.id(),
          resourceId: target.resourceId,
          materialHash: hash,
          body: observation.body,
          parserVersion: observation.body.parserVersion,
          snapshotId,
          createdAt: now,
        });
        await repo.insertVersion(version);
      }
      const attempt = await repo.getAttempt(
        live.snapshot().id,
        live.snapshot().attempt,
      );
      await repo.insertObservation({
        id: this.d.id(),
        resourceId: target.resourceId,
        versionId: version.snapshot().id,
        attemptId: attempt.id,
        httpStatus: observation.httpStatus,
        fetchedAt: observation.fetchedAt,
        rawDigest: observation.rawDigest,
        parserVersion: observation.body.parserVersion,
      });
      const changed =
        resource.snapshot().currentVersionId !== version.snapshot().id;
      await saveResource(
        repo,
        resource.observe(
          version.snapshot().id,
          observation.fetchedAt,
          observation.body,
        ),
        resource.snapshot().stateVersion,
      );
      if (resource.snapshot().kind === 'job') {
        const job = await repo.getJobByResource(target.resourceId);
        if (!job) throw new IngestionError('INGESTION_NOT_FOUND');
        const links = [];
        for (const link of observation.body.links) {
          if (link.kind === 'job') continue;
          let linkedId: string | null = null;
          if (link.kind === 'announcement' && link.sourceId) {
            const linked = await ensureResource(
              repo,
              this.d,
              'announcement',
              link.sourceId,
              now,
            );
            linkedId = linked.snapshot().id;
            await repo.insertTaskIfAbsent(
              newSourceTask(
                this.d.id(),
                `association:${this.d.id()}`,
                `fetch:${linkedId}`,
                { kind: 'fetch', resourceId: linkedId },
                now,
                2,
              ),
            );
          }
          links.push({
            id: this.d.id(),
            jobId: job.id,
            resourceId: linkedId,
            url: link.url,
            relationKind: link.kind,
            associationVersion: version.snapshot().id,
            associationStatus: 'discovered',
          });
        }
        await repo.replaceLinks(job.id, version.snapshot().id, links);
        await repo.insertDraft(
          target.resourceId,
          version.snapshot().id,
          observation.body,
        );
      } else {
        // 公告变化使所有关联岗位核验失效；双向关系只由实际正文链接证实。
        for (const job of await repo.listJobsLinkedTo(target.resourceId)) {
          const owner = await repo.getResource(job.resourceId, true);
          if (owner && changed)
            await saveResource(
              repo,
              owner.invalidate(),
              owner.snapshot().stateVersion,
            );
        }
      }
      await this.complete(repo, live, now);
    });
  }
  private async complete(
    repo: IngestionRepository,
    live: SourceTaskEntity,
    now: Date,
  ) {
    const state = live.snapshot();
    const successorId =
      live.needsSuccessor() && state.target.kind === 'fetch'
        ? this.d.id()
        : null;
    await saveTask(repo, live.finish(state.fencingToken, now, successorId));
    const attempt = await repo.getAttempt(state.id, state.attempt);
    await repo.endAttempt({
      ...attempt,
      endedAt: now,
      resultCode: 'SUCCEEDED',
    });
    if (successorId) {
      const next = await repo.insertTaskIfAbsent(
        newSourceTask(
          successorId,
          `successor:${state.id}:${state.fencingToken}`,
          state.dedupeKey,
          state.target,
          now,
          0,
        ),
      );
      await repo.copyRequesters(state.id, next.snapshot().id);
    }
  }
  private async fail(task: SourceTaskEntity, error: IngestionError) {
    await ingestionOperation(() =>
      this.d.unitOfWork.run(async (c) => {
        const repo = this.d.repositories(c);
        const target = task.snapshot().target;
        const stream = await repo.lockStream(
          target.kind === 'discover' ? target.streamKey : 'new',
        );
        const current = await repo.getTask(task.snapshot().id, true);
        if (!current) return;
        const now = await repo.now();
        try {
          current.assertLease(task.snapshot().fencingToken, now);
        } catch {
          return;
        }
        const failed = current.fail(
          task.snapshot().fencingToken,
          now,
          error,
          this.d.jitter(),
        );
        await saveTask(repo, failed);
        const attempt = await repo.getAttempt(
          current.snapshot().id,
          current.snapshot().attempt,
        );
        await repo.endAttempt({
          ...attempt,
          endedAt: now,
          resultCode: error.code,
          nextRetryAt:
            failed.snapshot().status === 'retry_wait'
              ? failed.snapshot().availableAt
              : null,
        });
        if (failed.snapshot().status === 'paused')
          await repo.updateStream(
            stream.pause(error.code),
            stream.snapshot().stateVersion,
          );
      }),
    );
  }
}
