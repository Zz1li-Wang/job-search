import { RESUME_POLICY } from '@career/contracts';
import {
  ResumeSchema,
  DeletionSchema,
  DraftSchema,
  ProfileSchema,
  type ActorDto,
  type ProfileContent,
  type DraftInputSchema,
  type DraftPatchSchema,
  type DraftConfirmSchema,
  ExtractionResultSchema,
} from '@career/contracts';
import type { z } from 'zod';
import {
  ResumeEntity,
  ProfileDraftEntity,
  validateExtraction,
} from '../../domain/resume/entities.js';
import { AgentRunEntity } from '../../domain/chat/entities.js';
import { ConfirmedProfileEntity } from '../../domain/jobs/entities.js';
import { BusinessError } from '../../domain/shared/errors.js';
import {
  assertActor,
  originalReference,
  remember,
} from '../ingestion/support.js';
import { businessOperation } from '../business-operation.js';
import type { ResumeDependencies, ResumeRepository } from './ports.js';
import type { TransactionContext } from '../ports.js';
import { signRunGrant } from '../chat/grants.js';
function resumeDto(entity: ResumeEntity) {
  const s = entity.snapshot();
  return ResumeSchema.parse({
    id: s.id,
    title: s.title,
    format: s.format,
    version: s.version,
    status: s.status,
    taskId: s.activeRunId,
    draftId: s.draftId,
    errorCode: s.errorCode,
    createdAt: s.createdAt.toISOString(),
  });
}
function draftDto(entity: ProfileDraftEntity) {
  const s = entity.snapshot();
  return DraftSchema.parse({
    id: s.id,
    version: s.version,
    baseProfileVersion: s.baseProfileVersion,
    content: s.content,
    status: s.status,
    sourceResumeId: s.sourceResumeId,
    sourceResumeVersion: s.sourceResumeVersion,
    evidence: s.evidence,
    confirmedProfileVersion: s.confirmedProfileVersion,
  });
}
async function owned(repo: ResumeRepository, id: string, actor: ActorDto) {
  const resume = await repo.get(id, actor.userId);
  if (!resume) throw new BusinessError('NOT_FOUND');
  resume.assertReadable(
    actor.userId,
    actor.execution?.kind === 'resume' ? actor.execution.resourceId : undefined,
  );
  return resume;
}
async function draftOwned(repo: ResumeRepository, id: string, actor: ActorDto) {
  const draft = await repo.getDraft(id, actor.userId);
  if (!draft) throw new BusinessError('NOT_FOUND');
  return draft;
}
export class ResumeService {
  constructor(private readonly d: ResumeDependencies) {}
  private execute<T>(
    actor: ActorDto,
    action: (repo: ResumeRepository, c: TransactionContext) => Promise<T>,
  ) {
    return businessOperation(() =>
      this.d.unitOfWork.run(async (c) => {
        await assertActor(this.d.source(c), actor);
        return action(this.d.resumes(c), c);
      }),
    );
  }
  async upload(
    title: string,
    format: 'pdf' | 'docx' | 'txt',
    bytes: Uint8Array,
    key: string,
    actor: ActorDto,
  ) {
    if (bytes.length > RESUME_POLICY.maxFileBytes)
      throw new BusinessError('FILE_TOO_LARGE');
    const fileKey = this.d.id(),
      hash = this.d.digest(
        format + ':' + Buffer.from(bytes).toString('base64'),
      ),
      requestHash = this.d.digest(JSON.stringify({ title, format, hash }));
    // 先登记延迟清理凭据；进程在预存后崩溃也不会留下不可追踪的孤立文件。
    await this.execute(actor, (repo) =>
      repo.registerFileDeletion(
        fileKey,
        actor.userId,
        new Date(this.d.now().getTime() + RESUME_POLICY.orphanCleanupDelayMs),
      ),
    );
    await this.d.files.put(fileKey, bytes);
    let keep = false;
    try {
      return await this.execute(actor, async (repo, c) => {
        const source = this.d.source(c),
          scope = `resume-upload:${actor.userId}`,
          original = await originalReference(source, scope, key, requestHash);
        if (original) return resumeDto(await owned(repo, original, actor));
        const existing = await repo.findHash(actor.userId, hash);
        if (existing) {
          await remember(
            source,
            scope,
            key,
            requestHash,
            existing.snapshot().id,
            this.d.now(),
          );
          return resumeDto(existing);
        }
        const now = this.d.now(),
          run = await this.newRun(c, actor, null, now),
          entity = new ResumeEntity({
            id: this.d.id(),
            userId: actor.userId,
            title,
            format,
            fileKey,
            contentHash: hash,
            version: 1,
            status: 'queued',
            activeRunId: run.snapshot().id,
            draftId: null,
            errorCode: null,
            spans: null,
            createdAt: now,
            deletedAt: null,
          });
        const scoped = new AgentRunEntity({
          ...run.snapshot(),
          resourceId: entity.snapshot().id,
        });
        await this.d.repositories(c).insertRun(scoped);
        await repo.insert(entity);
        await remember(
          source,
          scope,
          key,
          requestHash,
          entity.snapshot().id,
          now,
        );
        await repo.finishFileDeletion(fileKey, now);
        keep = true;
        return resumeDto(entity);
      });
    } finally {
      if (!keep) {
        try {
          await this.d.files.delete(fileKey);
          await this.d.unitOfWork.run((c) =>
            this.d.resumes(c).finishFileDeletion(fileKey, this.d.now()),
          );
        } catch {
          /* 已登记的清理凭据会在到期后重试，不丢失文件引用。 */
        }
      }
    }
  }
  private async newRun(
    c: TransactionContext,
    actor: ActorDto,
    resourceId: string | null,
    now: Date,
    attempt = 1,
    parentRunId: string | null = null,
  ) {
    const epoch = await this.d.repositories(c).getUserEpoch(actor.userId);
    if (!epoch) throw new BusinessError('NOT_FOUND');
    return new AgentRunEntity({
      id: this.d.id(),
      userId: actor.userId,
      conversationId: null,
      kind: 'resume',
      resourceId,
      status: 'queued',
      attempt,
      version: 1,
      lastSequence: 0,
      errorCode: null,
      authEpoch: epoch.authEpoch,
      personalDataEpoch: epoch.personalDataEpoch,
      createdAt: now,
      updatedAt: now,
      leaseUntil: null,
      parentRunId,
    });
  }
  async list(actor: ActorDto) {
    return this.execute(actor, async (repo) =>
      (await repo.list(actor.userId)).map(resumeDto),
    );
  }
  async get(id: string, actor: ActorDto) {
    return this.execute(actor, async (repo) =>
      resumeDto(await owned(repo, id, actor)),
    );
  }
  async content(id: string, actor: ActorDto) {
    return this.execute(actor, async (repo) => {
      const s = (await owned(repo, id, actor)).snapshot();
      if (!s.spans) throw new BusinessError('INVALID_TRANSITION');
      return { resumeId: id, version: s.version, spans: s.spans };
    });
  }
  async parse(
    id: string,
    version: number,
    retry: boolean,
    actor: ActorDto,
    expectedTaskId?: string,
  ) {
    return this.execute(actor, async (repo, c) => {
      const resume = await owned(repo, id, actor),
        s = resume.snapshot();
      if (s.version !== version) throw new BusinessError('VERSION_CONFLICT');
      if (['queued', 'extracting', 'structuring', 'ready'].includes(s.status))
        return resumeDto(resume);
      if (retry && s.activeRunId !== expectedTaskId)
        throw new BusinessError('VERSION_CONFLICT');
      const previous = s.activeRunId
          ? await this.d.repositories(c).getRun(s.activeRunId)
          : null,
        run = await this.newRun(
          c,
          actor,
          id,
          this.d.now(),
          (previous?.snapshot().attempt ?? 0) + 1,
          s.activeRunId,
        );
      const next = resume.retry(run.snapshot().id, version, retry);
      await this.d.repositories(c).insertRun(run);
      await repo.save(next);
      return resumeDto(next);
    });
  }
  async remove(id: string, actor: ActorDto) {
    const answer = await this.execute(actor, async (repo, c) => {
      const resume = await repo.get(id, actor.userId, true);
      if (!resume) throw new BusinessError('NOT_FOUND');
      const s = resume.snapshot(),
        privacy = this.d.privacy(c),
        now = this.d.now();
      let record = await privacy.get(id, actor.userId);
      if (!record) {
        record = {
          id,
          userId: actor.userId,
          scope: 'resume',
          requestedAt: now,
        };
        await privacy.insert(record);
      }
      if (!s.deletedAt) {
        await repo.save(resume.remove(now));
        await repo.deleteDraftsByResume(id, actor.userId);
        if (s.activeRunId) {
          const run = await this.d.repositories(c).getRun(s.activeRunId);
          if (run)
            await this.d
              .repositories(c)
              .saveRun(run.cancel(now), run.snapshot().version);
        }
        if (s.fileKey)
          await repo.registerFileDeletion(s.fileKey, actor.userId, now);
      }
      const pending = await privacy.pendingFiles(actor.userId);
      return {
        runId: s.activeRunId,
        deletion: DeletionSchema.parse({
          id,
          scope: 'resume',
          status: pending ? 'pending_cleanup' : 'completed',
          requestedAt: record.requestedAt.toISOString(),
          pendingFiles: pending,
        }),
      };
    });
    if (answer.runId) await this.d.agent.cancel(answer.runId).catch(() => {});
    return answer.deletion;
  }
  async createDraft(
    input: z.infer<typeof DraftInputSchema>,
    key: string,
    actor: ActorDto,
  ) {
    return this.execute(actor, async (repo, c) => {
      const hash = this.d.digest(JSON.stringify(input)),
        scope = `profile-draft:${actor.userId}`,
        old = await originalReference(this.d.source(c), scope, key, hash);
      if (old) return draftDto(await draftOwned(repo, old, actor));
      const entity = this.manualDraft(
        actor.userId,
        input.content,
        input.baseProfileVersion,
      );
      await repo.insertDraft(entity);
      await remember(
        this.d.source(c),
        scope,
        key,
        hash,
        entity.snapshot().id,
        this.d.now(),
      );
      return draftDto(entity);
    });
  }
  private manualDraft(
    userId: string,
    content: ProfileContent,
    baseProfileVersion: number,
  ) {
    return new ProfileDraftEntity({
      id: this.d.id(),
      userId,
      content,
      baseProfileVersion,
      version: 1,
      status: 'draft',
      sourceResumeId: null,
      sourceResumeVersion: null,
      evidence: [],
      confirmedProfileVersion: null,
      confirmedContent: null,
      confirmedAt: null,
      createdAt: this.d.now(),
    });
  }
  async getDraft(id: string, actor: ActorDto) {
    return this.execute(actor, async (repo) =>
      draftDto(await draftOwned(repo, id, actor)),
    );
  }
  async patchDraft(
    id: string,
    input: z.infer<typeof DraftPatchSchema>,
    actor: ActorDto,
  ) {
    return this.execute(actor, async (repo) => {
      const draft = await draftOwned(repo, id, actor),
        next = draft.edit(
          input.content,
          input.baseProfileVersion,
          input.expectedDraftVersion,
        );
      await repo.saveDraft(next);
      return draftDto(next);
    });
  }
  async confirm(
    id: string,
    input: z.infer<typeof DraftConfirmSchema>,
    actor: ActorDto,
  ) {
    return this.execute(actor, async (repo) => {
      const draft = await draftOwned(repo, id, actor),
        s = draft.snapshot();
      if (
        s.status !== 'confirmed' &&
        s.sourceResumeId &&
        !(await repo.get(s.sourceResumeId, actor.userId))
      )
        throw new BusinessError('NOT_FOUND');
      const current = await repo.getProfile(actor.userId),
        next = draft.confirm(
          input.expectedDraftVersion,
          input.expectedProfileVersion,
          current?.snapshot().version ?? 0,
          this.d.now(),
        ),
        ns = next.snapshot();
      if (s.status !== 'confirmed') {
        await repo.saveProfile(
          new ConfirmedProfileEntity({
            userId: actor.userId,
            version: ns.confirmedProfileVersion!,
            content: ns.confirmedContent!,
            confirmedAt: ns.confirmedAt!,
            updatedAt: ns.confirmedAt!,
          }),
        );
        await repo.saveDraft(next);
      }
      return {
        ...ProfileSchema.parse({
          content: ns.confirmedContent,
          version: ns.confirmedProfileVersion,
          confirmedAt: ns.confirmedAt!.toISOString(),
        }),
        isCurrent:
          s.status !== 'confirmed' ||
          current?.snapshot().version === ns.confirmedProfileVersion,
      };
    });
  }
}
export class ResumeWorkerService {
  constructor(private readonly d: ResumeDependencies) {}
  async tick() {
    await this.cleanupOne();
    const expired = await this.d.unitOfWork.run((c) =>
      this.d.resumes(c).listExpired(this.d.now()),
    );
    for (const resume of expired) await this.fail(resume, 'MODEL_INTERRUPTED');
    const selected = await this.d.unitOfWork.run((c) =>
      this.d.resumes(c).nextQueued(),
    );
    if (!selected) return false;
    const s = selected.snapshot();
    const started = await this.d.unitOfWork.run(async (c) => {
      const source = this.d.source(c),
        account = await source.accounts.getForUpdate(s.userId),
        repo = this.d.resumes(c),
        current = await repo.get(s.id, s.userId),
        run = await this.d.repositories(c).getRun(s.activeRunId!, true);
      if (!account || !current || !run || run.snapshot().status !== 'queued')
        return null;
      const rs = run.snapshot(),
        as = account.snapshot();
      if (
        as.deletedAt ||
        rs.authEpoch !== as.authEpoch ||
        rs.personalDataEpoch !== as.personalDataEpoch
      ) {
        await repo.save(current.fail('TOOL_UNAUTHORIZED'));
        await this.d
          .repositories(c)
          .saveRun(run.cancel(this.d.now()), rs.version);
        return null;
      }
      const next = current.start(rs.id),
        active = run.start(this.d.now());
      await repo.save(next);
      await this.d.repositories(c).saveRun(active, rs.version);
      return active;
    });
    if (!started) return true;
    try {
      const bytes = await this.d.files.read(s.fileKey!),
        spans = await this.d.extract(bytes, s.format);
      await this.d.unitOfWork.run(async (c) => {
        const actor: ActorDto = {
          userId: s.userId,
          sessionId: null,
          authEpoch: started.snapshot().authEpoch,
          execution: {
            runId: started.snapshot().id,
            kind: 'resume',
            resourceId: s.id,
            personalDataEpoch: started.snapshot().personalDataEpoch,
          },
        };
        await assertActor(this.d.source(c), actor);
        const repo = this.d.resumes(c),
          resume = await owned(repo, s.id, actor);
        await repo.save(resume.withText(spans, started.snapshot().id));
      });
      const extracted = ExtractionResultSchema.parse(
        await this.d.extractProfile({
          runId: started.snapshot().id,
          resumeId: s.id,
          version: s.version,
          grant: signRunGrant(this.d, started, ['read_resume']),
        }),
      );
      validateExtraction(extracted.content, extracted.evidence, spans);
      await this.d.unitOfWork.run(async (c) => {
        const actor: ActorDto = {
          userId: s.userId,
          sessionId: null,
          authEpoch: started.snapshot().authEpoch,
          execution: {
            runId: started.snapshot().id,
            kind: 'resume',
            resourceId: s.id,
            personalDataEpoch: started.snapshot().personalDataEpoch,
          },
        };
        await assertActor(this.d.source(c), actor);
        const repo = this.d.resumes(c),
          resume = await owned(repo, s.id, actor),
          currentProfile = await repo.getProfile(s.userId),
          run = await this.d
            .repositories(c)
            .getRun(started.snapshot().id, true);
        if (!run) throw new BusinessError('NOT_FOUND');
        const draft = new ProfileDraftEntity({
          id: this.d.id(),
          userId: s.userId,
          version: 1,
          baseProfileVersion: currentProfile?.snapshot().version ?? 0,
          content: extracted.content,
          status: 'draft',
          sourceResumeId: s.id,
          sourceResumeVersion: s.version,
          evidence: extracted.evidence,
          confirmedProfileVersion: null,
          confirmedContent: null,
          confirmedAt: null,
          createdAt: this.d.now(),
        });
        await repo.insertDraft(draft);
        await repo.save(
          resume.complete(draft.snapshot().id, started.snapshot().id),
        );
        const next = run.append(1, 'completed', this.d.now());
        await this.d.repositories(c).saveRun(next, run.snapshot().version);
      });
    } catch (error) {
      await this.fail(
        selected,
        error instanceof BusinessError ? error.code : 'MODEL_INTERRUPTED',
      );
    }
    return true;
  }
  async fail(resume: ResumeEntity, code: string) {
    const s = resume.snapshot();
    await this.d.unitOfWork.run(async (c) => {
      await this.d.source(c).accounts.getForUpdate(s.userId);
      const repo = this.d.resumes(c),
        current = await repo.get(s.id, s.userId);
      if (!current || current.snapshot().activeRunId !== s.activeRunId) return;
      await repo.save(current.fail(code));
      const run = s.activeRunId
        ? await this.d.repositories(c).getRun(s.activeRunId, true)
        : null;
      if (run?.snapshot().status === 'running')
        await this.d
          .repositories(c)
          .saveRun(
            run.append(
              run.snapshot().lastSequence + 1,
              'failed',
              this.d.now(),
              code,
            ),
            run.snapshot().version,
          );
    });
  }
  async cleanupOne() {
    const task = await this.d.unitOfWork.run((c) =>
      this.d.resumes(c).nextFileDeletion(this.d.now()),
    );
    if (!task) return false;
    try {
      await this.d.files.delete(task.key);
      await this.d.unitOfWork.run((c) =>
        this.d.resumes(c).finishFileDeletion(task.id, this.d.now()),
      );
      return true;
    } catch {
      return false;
    }
  }
}
export function createResumeServices(d: ResumeDependencies) {
  return { resumes: new ResumeService(d), worker: new ResumeWorkerService(d) };
}
