import type { Prisma } from '../generated/client.js';
import { z } from 'zod';
import type { PrivacyRepository } from '../../application/privacy/ports.js';
const State = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  scope: z.enum(['profile', 'personal', 'account', 'resume']),
  requestedAt: z.date(),
});
export function createPrivacyRepository(
  db: Prisma.TransactionClient,
): PrivacyRepository {
  return {
    async insert(record) {
      await db.deletionRequest.create({ data: record });
    },
    async get(id, userId) {
      const row = await db.deletionRequest.findFirst({ where: { id, userId } });
      return row ? State.parse(row) : null;
    },
    async listFileKeys(userId) {
      return (
        await db.resume.findMany({
          where: { userId },
          select: { fileKey: true },
        })
      ).flatMap((r) => (r.fileKey ? [r.fileKey] : []));
    },
    async pendingFiles(userId) {
      return db.taskOutbox.count({
        where: {
          kind: 'file.delete',
          completedAt: null,
          target: { path: ['userId'], equals: userId },
        },
      });
    },
    async cancelRuns(userId, now) {
      await db.agentRun.updateMany({
        where: { userId, status: { in: ['queued', 'running'] } },
        data: {
          status: 'cancelled',
          leaseUntil: null,
          updatedAt: now,
          version: { increment: 1 },
        },
      });
      await db.conversation.updateMany({
        where: { userId },
        data: { activeRunId: null },
      });
      await db.resume.updateMany({
        where: {
          userId,
          status: { in: ['queued', 'extracting', 'structuring'] },
        },
        data: { status: 'failed', errorCode: 'TOOL_UNAUTHORIZED' },
      });
    },
    async deleteOwnedCollections(userId, collections) {
      const deletion = {
        profile: () => db.profile.deleteMany({ where: { userId } }),
        drafts: () => db.profileDraft.deleteMany({ where: { userId } }),
        checks: () => db.eligibilityCheck.deleteMany({ where: { userId } }),
        resumes: () => db.resume.deleteMany({ where: { userId } }),
        conversations: () => db.conversation.deleteMany({ where: { userId } }),
        runs: () => db.agentRun.deleteMany({ where: { userId } }),
        favorites: () => db.favorite.deleteMany({ where: { userId } }),
        applications: () => db.jobApplication.deleteMany({ where: { userId } }),
      };
      for (const name of collections) await deletion[name]();
    },
    async saveAccount(entity, expectedEpoch) {
      const s = entity.snapshot();
      return (
        (
          await db.user.updateMany({
            where: { id: s.id, authEpoch: expectedEpoch },
            data: s,
          })
        ).count === 1
      );
    },
    async revokeSessions(userId, now) {
      await db.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
    },
  };
}
