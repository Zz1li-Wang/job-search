import type { Prisma } from '../generated/client.js';
import type { JobsRepository } from '../../application/jobs/ports.js';
import {
  ConfirmedProfileEntity,
  EligibilityCheckEntity,
  ProfileStateSchema,
  CheckDecisionStateSchema,
} from '../../domain/jobs/entities.js';
export function createJobsRepository(
  tx: Prisma.TransactionClient,
): JobsRepository {
  return {
    async listJobs() {
      return tx.job.findMany({
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      });
    },
    async getJob(id) {
      return tx.job.findUnique({ where: { id } });
    },
    async getProfile(userId) {
      const row = await tx.profile.findUnique({ where: { userId } });
      return row
        ? new ConfirmedProfileEntity(ProfileStateSchema.parse(row))
        : null;
    },
    async getCheckOwned(id, userId) {
      const row = await tx.eligibilityCheck.findFirst({
        where: { id, userId },
      });
      return row
        ? new EligibilityCheckEntity({
            ...row,
            decision: CheckDecisionStateSchema.parse(row.decision),
          })
        : null;
    },
    async insertCheck(entity) {
      const s = entity.snapshot();
      await tx.eligibilityCheck.create({
        data: {
          ...s,
          decision: JSON.parse(
            JSON.stringify(s.decision),
          ) as Prisma.InputJsonValue,
        },
      });
    },
  };
}
