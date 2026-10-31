import type { Prisma } from '../generated/client.js';
import { z } from 'zod';
import type { CareerRepository } from '../../application/career/ports.js';
import {
  ApplicationEntity,
  ApplicationStateSchema,
} from '../../domain/career/entities.js';
import { ApplicationStatusSchema } from '@career/contracts';
const FavoriteState = z.object({
  userId: z.uuid(),
  jobId: z.uuid(),
  title: z.string(),
  createdAt: z.date(),
});
const HistoryState = z.object({
  id: z.uuid(),
  applicationId: z.uuid(),
  version: z.number(),
  status: ApplicationStatusSchema,
  actionDate: z.string().nullable(),
  note: z.string(),
  createdAt: z.date(),
});
export function createCareerRepository(
  db: Prisma.TransactionClient,
): CareerRepository {
  return {
    async listFavorites(userId) {
      return (
        await db.favorite.findMany({
          where: { userId },
          orderBy: [{ createdAt: 'desc' }, { jobId: 'desc' }],
          take: 500,
        })
      ).map((row) => FavoriteState.parse(row));
    },
    async insertFavorite(record) {
      await db.favorite.createMany({ data: [record], skipDuplicates: true });
    },
    async deleteFavorite(userId, jobId) {
      await db.favorite.deleteMany({ where: { userId, jobId } });
    },
    async getApplication(id, userId) {
      const row = await db.jobApplication.findFirst({ where: { id, userId } });
      return row
        ? new ApplicationEntity(ApplicationStateSchema.parse(row))
        : null;
    },
    async findApplication(userId, jobId) {
      const row = await db.jobApplication.findUnique({
        where: { userId_jobId: { userId, jobId } },
      });
      return row
        ? new ApplicationEntity(ApplicationStateSchema.parse(row))
        : null;
    },
    async listApplications(userId) {
      return (
        await db.jobApplication.findMany({
          where: { userId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 500,
        })
      ).map((row) => new ApplicationEntity(ApplicationStateSchema.parse(row)));
    },
    async insertApplication(entity) {
      await db.jobApplication.create({ data: entity.snapshot() });
    },
    async saveApplication(entity, expectedVersion) {
      const s = entity.snapshot();
      return (
        (
          await db.jobApplication.updateMany({
            where: { id: s.id, version: expectedVersion },
            data: s,
          })
        ).count === 1
      );
    },
    async deleteApplication(id, userId) {
      await db.jobApplication.deleteMany({ where: { id, userId } });
    },
    async insertHistory(record) {
      await db.applicationHistory.create({ data: record });
    },
    async getHistoryById(id, applicationId) {
      const row = await db.applicationHistory.findFirst({
        where: { id, applicationId },
      });
      return row ? HistoryState.parse(row) : null;
    },
    async getHistoryByVersion(applicationId, version) {
      const row = await db.applicationHistory.findUnique({
        where: { applicationId_version: { applicationId, version } },
      });
      return row ? HistoryState.parse(row) : null;
    },
    async listHistory(applicationId) {
      return (
        await db.applicationHistory.findMany({
          where: { applicationId },
          orderBy: { version: 'asc' },
          take: 500,
        })
      ).map((row) => HistoryState.parse(row));
    },
  };
}
