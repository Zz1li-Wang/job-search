import {
  ApplicationSchema,
  FavoriteSchema,
  ApplicationHistorySchema,
  type ActorDto,
  type ApplicationPatchSchema,
} from '@career/contracts';
import type { z } from 'zod';
import { ApplicationEntity } from '../../domain/career/entities.js';
import { BusinessError } from '../../domain/shared/errors.js';
import {
  assertActor,
  originalReference,
  remember,
} from '../ingestion/support.js';
import { businessOperation } from '../business-operation.js';
import { JobQueryService } from '../jobs/services.js';
import type { CareerDependencies, CareerRepository } from './ports.js';
import type { TransactionContext } from '../ports.js';
function applicationDto(entity: ApplicationEntity) {
  const s = entity.snapshot();
  return ApplicationSchema.parse({
    id: s.id,
    jobId: s.jobId,
    title: s.title,
    status: s.status,
    actionDate: s.actionDate,
    note: s.note,
    version: s.version,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  });
}
export class CareerService {
  constructor(private readonly d: CareerDependencies) {}
  private execute<T>(
    actor: ActorDto,
    action: (repo: CareerRepository, c: TransactionContext) => Promise<T>,
  ) {
    return businessOperation(() =>
      this.d.unitOfWork.run(async (c) => {
        await assertActor(this.d.source(c), actor);
        return action(this.d.career(c), c);
      }),
    );
  }
  private async owned(repo: CareerRepository, id: string, actor: ActorDto) {
    const application = await repo.getApplication(id, actor.userId);
    if (!application) throw new BusinessError('NOT_FOUND');
    return application;
  }
  async favorites(actor: ActorDto) {
    return this.execute(actor, async (repo) =>
      (await repo.listFavorites(actor.userId)).map((s) =>
        FavoriteSchema.parse({
          jobId: s.jobId,
          title: s.title,
          createdAt: s.createdAt.toISOString(),
        }),
      ),
    );
  }
  async addFavorite(jobId: string, actor: ActorDto) {
    return this.execute(actor, async (repo, c) => {
      const job = await this.d.repositories(c).getJob(jobId);
      if (!job) throw new BusinessError('NOT_FOUND');
      const context = await new JobQueryService(this.d).context(c, job);
      await repo.insertFavorite({
        userId: actor.userId,
        jobId,
        title: context.summary.title,
        createdAt: this.d.now(),
      });
      const s = (await repo.listFavorites(actor.userId)).find(
        (r) => r.jobId === jobId,
      )!;
      return FavoriteSchema.parse({
        jobId: s.jobId,
        title: s.title,
        createdAt: s.createdAt.toISOString(),
      });
    });
  }
  async removeFavorite(jobId: string, actor: ActorDto) {
    return this.execute(actor, (repo) =>
      repo.deleteFavorite(actor.userId, jobId),
    );
  }
  async list(status: string | undefined, actor: ActorDto) {
    return this.execute(actor, async (repo) =>
      (await repo.listApplications(actor.userId))
        .filter((e) => !status || e.snapshot().status === status)
        .map(applicationDto),
    );
  }
  async create(jobId: string, key: string, actor: ActorDto) {
    return this.execute(actor, async (repo, c) => {
      const hash = this.d.digest(jobId),
        scope = `application-create:${actor.userId}`,
        source = this.d.source(c),
        old = await originalReference(source, scope, key, hash);
      if (old) return applicationDto(await this.owned(repo, old, actor));
      const existing = await repo.findApplication(actor.userId, jobId);
      if (existing) {
        await remember(
          source,
          scope,
          key,
          hash,
          existing.snapshot().id,
          this.d.now(),
        );
        return applicationDto(existing);
      }
      const job = await this.d.repositories(c).getJob(jobId);
      if (!job) throw new BusinessError('NOT_FOUND');
      const context = await new JobQueryService(this.d).context(c, job),
        now = this.d.now(),
        entity = new ApplicationEntity({
          id: this.d.id(),
          userId: actor.userId,
          jobId,
          title: context.summary.title,
          status: 'preparing',
          actionDate: null,
          note: '',
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
      await repo.insertApplication(entity);
      await this.history(repo, entity);
      await remember(source, scope, key, hash, entity.snapshot().id, now);
      return applicationDto(entity);
    });
  }
  async get(id: string, actor: ActorDto) {
    return this.execute(actor, async (repo) =>
      applicationDto(await this.owned(repo, id, actor)),
    );
  }
  async patch(
    id: string,
    input: z.infer<typeof ApplicationPatchSchema>,
    key: string,
    actor: ActorDto,
  ) {
    return this.execute(actor, async (repo, c) => {
      const entity = await this.owned(repo, id, actor),
        hash = this.d.digest(JSON.stringify(input)),
        scope = `application-edit:${actor.userId}:${id}`,
        source = this.d.source(c),
        old = await originalReference(source, scope, key, hash);
      if (old) {
        const event = await repo.getHistoryById(old, id);
        if (!event) throw new BusinessError('NOT_FOUND');
        const s = entity.snapshot();
        return applicationDto(
          new ApplicationEntity({
            ...s,
            version: event.version,
            status: event.status,
            actionDate: event.actionDate,
            note: event.note,
            updatedAt: event.createdAt,
          }),
        );
      }
      const next = entity.revise(input, this.d.now());
      if (next !== entity) {
        if (!(await repo.saveApplication(next, entity.snapshot().version)))
          throw new BusinessError('VERSION_CONFLICT');
        const historyId = await this.history(repo, next);
        await remember(source, scope, key, hash, historyId, this.d.now());
      }
      if (next === entity) {
        const history = await repo.getHistoryByVersion(
          id,
          next.snapshot().version,
        );
        if (!history) throw new BusinessError('DEPENDENCY_UNAVAILABLE');
        await remember(source, scope, key, hash, history.id, this.d.now());
      }
      return applicationDto(next);
    });
  }
  private async history(repo: CareerRepository, entity: ApplicationEntity) {
    const s = entity.snapshot(),
      id = this.d.id();
    await repo.insertHistory({
      id,
      applicationId: s.id,
      version: s.version,
      status: s.status,
      actionDate: s.actionDate,
      note: s.note,
      createdAt: s.updatedAt,
    });
    return id;
  }
  async histories(id: string, actor: ActorDto) {
    return this.execute(actor, async (repo) => {
      await this.owned(repo, id, actor);
      return (await repo.listHistory(id)).map((h) =>
        ApplicationHistorySchema.parse({
          id: h.id,
          version: h.version,
          status: h.status,
          actionDate: h.actionDate,
          note: h.note,
          createdAt: h.createdAt.toISOString(),
        }),
      );
    });
  }
  async remove(id: string, actor: ActorDto) {
    return this.execute(actor, (repo) =>
      repo.deleteApplication(id, actor.userId),
    );
  }
}
