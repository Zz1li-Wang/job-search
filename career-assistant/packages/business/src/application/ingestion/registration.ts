import type {
  DiscoverInputDto,
  DiscoverResultDto,
  ActorDto,
  RetryInputDto,
  TaskDto,
} from '@career/contracts';
import { RefreshQuotaEntity } from '../../domain/ingestion/refresh.js';
import { newSourceTask } from '../../domain/ingestion/task.js';
import { IngestionError } from '../../domain/ingestion/errors.js';
import { INGESTION_POLICY } from '../../domain/ingestion/policy.js';
import type { IngestionDependencies } from './ports.js';
import {
  ingestionOperation,
  taskDto,
  assertActor,
  originalReference,
  remember,
  saveTask,
} from './support.js';
export class DiscoveryService {
  constructor(private readonly d: IngestionDependencies) {}
  execute(input: DiscoverInputDto): Promise<DiscoverResultDto> {
    return ingestionOperation(() =>
      this.d.unitOfWork.run(async (c) => {
        const repo = this.d.repositories(c);
        const now = await repo.now();
        const current = await repo.lockStream(input.stream);
        const hash = this.d.digest(JSON.stringify(input));
        const existing = await originalReference(
          repo,
          'operator:discover',
          input.runId,
          hash,
        );
        if (existing) {
          const original = await repo.getTask(existing);
          if (!original || original.snapshot().target.kind !== 'discover')
            throw new IngestionError('TASK_VERSION_CONFLICT');
          const target = original.snapshot().target;
          return {
            taskId: existing,
            generation: target.kind === 'discover' ? target.generation : 0,
            checkpointVersion:
              target.kind === 'discover' ? target.checkpointVersion : 0,
          };
        }
        const active = await repo.findActive(`discover:${input.stream}`);
        if (active) {
          await remember(
            repo,
            'operator:discover',
            input.runId,
            hash,
            active.snapshot().id,
            now,
          );
          return {
            taskId: active.snapshot().id,
            generation: current.snapshot().generation,
            checkpointVersion: current.snapshot().checkpointVersion,
          };
        }
        const next = current.start(
          now,
          input.checkpoint,
          input.expectedCheckpointVersion,
        );
        if (!(await repo.updateStream(next, current.snapshot().stateVersion)))
          throw new IngestionError('TASK_VERSION_CONFLICT');
        const s = next.snapshot();
        const task = await repo.insertTaskIfAbsent(
          newSourceTask(
            this.d.id(),
            `discover:${input.runId}`,
            `discover:${input.stream}`,
            {
              kind: 'discover',
              streamKey: input.stream,
              page: s.checkpoint,
              remaining: input.pageLimit,
              generation: s.generation,
              checkpointVersion: s.checkpointVersion,
            },
            now,
            4,
          ),
        );
        await remember(
          repo,
          'operator:discover',
          input.runId,
          hash,
          task.snapshot().id,
          now,
        );
        return {
          taskId: task.snapshot().id,
          generation: s.generation,
          checkpointVersion: s.checkpointVersion,
        };
      }),
    );
  }
}
export class RefreshService {
  constructor(private readonly d: IngestionDependencies) {}
  execute(jobId: string, key: string, actor: ActorDto): Promise<TaskDto> {
    return ingestionOperation(() =>
      this.d.unitOfWork.run(async (c) => {
        const repo = this.d.repositories(c);
        await assertActor(repo, actor);
        const now = await repo.now();
        await repo.lockStream('new');
        const scope = `user:${actor.userId}:refresh`;
        const hash = this.d.digest(jobId);
        const original = await originalReference(repo, scope, key, hash);
        if (original) {
          const task = await repo.getTask(original);
          if (!task) throw new IngestionError('INGESTION_NOT_FOUND');
          return taskDto(task);
        }
        const job = await repo.getJob(jobId);
        if (!job) throw new IngestionError('INGESTION_NOT_FOUND');
        const resource = await repo.getResource(job.resourceId, true);
        if (!resource) throw new IngestionError('INGESTION_NOT_FOUND');
        // 用户锁下计数，重复幂等重放已在前面返回；使用现有幂等记录保留分钟桶。
        const minute = Math.floor(now.getTime() / 60_000);
        const rateScope = `refresh-rate:${actor.userId}`;
        const rateKeys = Array.from(
          { length: INGESTION_POLICY.refreshRatePerMinute },
          (_, slot) => {
            const hash = this.d.digest(`${minute}:${slot}`);
            return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
          },
        );
        const occupied = [];
        for (const key of rateKeys)
          occupied.push(!!(await repo.records.getRecord(rateScope, key)));
        const slot = new RefreshQuotaEntity({
          occupiedSlots: occupied,
          previousRequestedAt: null,
        }).availableSlot();
        await remember(repo, rateScope, rateKeys[slot]!, hash, jobId, now);
        let active = await repo.findActive(`fetch:${job.resourceId}`);
        if (active) {
          active = active.request(now);
          await saveTask(repo, active);
        } else {
          const previous = (await repo.listTasks())
            .filter((t) => t.snapshot().dedupeKey === `fetch:${job.resourceId}`)
            .sort(
              (a, b) =>
                b.snapshot().requestedAt.getTime() -
                a.snapshot().requestedAt.getTime(),
            )[0];
          new RefreshQuotaEntity({
            occupiedSlots: occupied,
            previousRequestedAt: previous?.snapshot().requestedAt ?? null,
          }).assertMayCreate(now);
          active = await repo.insertTaskIfAbsent(
            newSourceTask(
              this.d.id(),
              `refresh:${this.d.id()}`,
              `fetch:${job.resourceId}`,
              { kind: 'fetch', resourceId: job.resourceId },
              now,
              0,
            ),
          );
        }
        await repo.addRequester(active.snapshot().id, actor.userId);
        await remember(repo, scope, key, hash, active.snapshot().id, now);
        return taskDto(active);
      }),
    );
  }
}
export class TaskQueryService {
  constructor(private readonly d: IngestionDependencies) {}
  execute(id: string, actor: ActorDto): Promise<TaskDto> {
    return ingestionOperation(() =>
      this.d.unitOfWork.run(async (c) => {
        const repo = this.d.repositories(c);
        await assertActor(repo, actor);
        const task = await repo.getTask(id);
        if (!task || !(await repo.hasRequester(id, actor.userId)))
          throw new IngestionError('INGESTION_NOT_FOUND');
        return taskDto(task);
      }),
    );
  }
}
export class TaskRetryService {
  constructor(private readonly d: IngestionDependencies) {}
  execute(input: RetryInputDto): Promise<TaskDto> {
    return ingestionOperation(() =>
      this.d.unitOfWork.run(async (c) => {
        const repo = this.d.repositories(c);
        const preview = await repo.getTask(input.taskId);
        if (!preview) throw new IngestionError('INGESTION_NOT_FOUND');
        const target = preview.snapshot().target;
        const stream = await repo.lockStream(
          target.kind === 'discover' ? target.streamKey : 'new',
        );
        const now = await repo.now();
        const hash = this.d.digest(
          JSON.stringify({ ...input, operationKey: undefined }),
        );
        const original = await originalReference(
          repo,
          'operator:retry',
          input.operationKey,
          hash,
        );
        if (original) {
          const task = await repo.getTask(original);
          if (!task) throw new IngestionError('INGESTION_NOT_FOUND');
          return taskDto(task);
        }
        const current = await repo.getTask(input.taskId, true);
        if (!current) throw new IngestionError('INGESTION_NOT_FOUND');
        if (
          current.snapshot().errorCode === 'SOURCE_BUDGET_EXHAUSTED' &&
          !this.d.networkEnabled
        )
          throw new IngestionError('SOURCE_BUDGET_EXHAUSTED');
        const next = current.retry(input.expectedAttempt, now);
        await saveTask(repo, next);
        if (stream.snapshot().pauseReason)
          await repo.updateStream(
            stream.pause(null),
            stream.snapshot().stateVersion,
          );
        await remember(
          repo,
          'operator:retry',
          input.operationKey,
          hash,
          next.snapshot().id,
          now,
        );
        return taskDto(next);
      }),
    );
  }
}
