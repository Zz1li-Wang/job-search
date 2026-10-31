import {
  DeletionSchema,
  type ActorDto,
  type DeleteDataInputSchema,
} from '@career/contracts';
import type { z } from 'zod';
import {
  PrivacyDecision,
  type DeletionScope,
  type DeletionRecord,
} from '../../domain/privacy/entity.js';
import { BusinessError } from '../../domain/shared/errors.js';
import { AuthError } from '../../domain/auth/errors.js';
import { AuthRateLimiter } from '../auth/support.js';
import {
  assertActor,
  originalReference,
  remember,
} from '../ingestion/support.js';
import { businessOperation } from '../business-operation.js';
import type { PrivacyDependencies, PrivacyRepository } from './ports.js';
export class PrivacyService {
  constructor(private readonly d: PrivacyDependencies) {}
  private async dto(repo: PrivacyRepository, record: DeletionRecord) {
    const pending = await repo.pendingFiles(record.userId);
    return DeletionSchema.parse({
      id: record.id,
      scope: record.scope,
      status: pending ? 'pending_cleanup' : 'completed',
      requestedAt: record.requestedAt.toISOString(),
      pendingFiles: pending,
    });
  }
  async remove(
    scope: DeletionScope,
    input: z.infer<typeof DeleteDataInputSchema>,
    key: string,
    actor: ActorDto,
  ) {
    const decision = new PrivacyDecision(scope);
    decision.assertConfirmation(input.confirmation);
    let passwordEpoch: number | null = null;
    if (decision.requiresPassword()) {
      await new AuthRateLimiter(this.d.auth).consume(
        'password',
        this.d.tokens.digest('privacy-delete', actor.userId),
      );
      const account = await this.d.unitOfWork.run(async (c) => {
        await assertActor(this.d.source(c), actor);
        return this.d.source(c).accounts.getById(actor.userId);
      });
      if (
        !account ||
        !input.currentPassword ||
        !(await this.d.auth.passwords.verify(
          input.currentPassword,
          account.snapshot().passwordHash,
        ))
      )
        throw new AuthError('AUTH_INVALID_CREDENTIALS');
      passwordEpoch = account.snapshot().authEpoch;
    }
    return businessOperation(() =>
      this.d.unitOfWork.run(async (c) => {
        const source = this.d.source(c);
        await assertActor(source, actor);
        const account = await source.accounts.getForUpdate(actor.userId);
        if (!account) throw new AuthError('AUTH_UNAUTHENTICATED');
        if (passwordEpoch !== null) account.assertEpoch(passwordEpoch);
        const repo = this.d.privacy(c),
          hash = this.d.digest(input.confirmation),
          recordScope = `privacy:${actor.userId}:${scope}`,
          old = await originalReference(source, recordScope, key, hash);
        if (old) {
          const existing = await repo.get(old, actor.userId);
          if (!existing) throw new BusinessError('NOT_FOUND');
          return this.dto(repo, existing);
        }
        const now = this.d.now(),
          record: DeletionRecord = {
            id: this.d.id(),
            userId: actor.userId,
            scope,
            requestedAt: now,
          };
        const keys = decision.removesFiles()
          ? await repo.listFileKeys(actor.userId)
          : [];
        for (const fileKey of keys)
          await this.d
            .resumes(c)
            .registerFileDeletion(fileKey, actor.userId, now);
        await repo.cancelRuns(actor.userId, now);
        await repo.deleteOwnedCollections(actor.userId, decision.collections());
        const next =
          scope === 'account'
            ? account.close(now)
            : account.clearPersonalData(now);
        if (!(await repo.saveAccount(next, account.snapshot().authEpoch)))
          throw new BusinessError('VERSION_CONFLICT');
        if (scope === 'account') await repo.revokeSessions(actor.userId, now);
        await repo.insert(record);
        await remember(source, recordScope, key, hash, record.id, now);
        return this.dto(repo, record);
      }),
    );
  }
  async get(id: string, actor: ActorDto) {
    return businessOperation(() =>
      this.d.unitOfWork.run(async (c) => {
        await assertActor(this.d.source(c), actor);
        const repo = this.d.privacy(c),
          record = await repo.get(id, actor.userId);
        if (!record) throw new BusinessError('NOT_FOUND');
        return this.dto(repo, record);
      }),
    );
  }
}
