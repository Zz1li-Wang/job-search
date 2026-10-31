import { Prisma } from '../generated/client.js';
import type { ResumeRepository } from '../../application/resume/ports.js';
import {
  ResumeEntity,
  ResumeStateSchema,
  ProfileDraftEntity,
  DraftStateSchema,
} from '../../domain/resume/entities.js';
import {
  ConfirmedProfileEntity,
  ProfileStateSchema,
} from '../../domain/jobs/entities.js';
import { z } from 'zod';

export function createResumeRepository(
  db: Prisma.TransactionClient,
): ResumeRepository {
  return {
    async get(id, userId, includeDeleted = false) {
      const row = await db.resume.findFirst({
        where: { id, userId, ...(includeDeleted ? {} : { deletedAt: null }) },
      });
      return row ? new ResumeEntity(ResumeStateSchema.parse(row)) : null;
    },
    async list(userId) {
      return (
        await db.resume.findMany({
          where: { userId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 100,
        })
      ).map((row) => new ResumeEntity(ResumeStateSchema.parse(row)));
    },
    async findHash(userId, contentHash) {
      const row = await db.resume.findFirst({
        where: { userId, contentHash, deletedAt: null },
      });
      return row ? new ResumeEntity(ResumeStateSchema.parse(row)) : null;
    },
    async insert(entity) {
      const s = entity.snapshot();
      await db.resume.create({
        data: { ...s, spans: s.spans ?? Prisma.DbNull },
      });
    },
    async save(entity) {
      const s = entity.snapshot();
      await db.resume.update({
        where: { id: s.id },
        data: { ...s, spans: s.spans ?? Prisma.DbNull },
      });
    },
    async nextQueued() {
      const rows = await db.$queryRaw<
        { id: string }[]
      >`SELECT id FROM resumes WHERE status='queued' AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`;
      const row = rows[0]
        ? await db.resume.findUnique({ where: { id: rows[0].id } })
        : null;
      return row ? new ResumeEntity(ResumeStateSchema.parse(row)) : null;
    },
    async listExpired(now) {
      const rows = await db.$queryRaw<
        { id: string }[]
      >`SELECT r.id FROM resumes r JOIN agent_runs a ON r.active_run_id=a.id WHERE r.status IN ('extracting','structuring') AND (a.lease_until<=${now} OR a.status IN ('cancelled','interrupted','failed')) LIMIT 30`;
      return (
        await db.resume.findMany({
          where: { id: { in: rows.map((r) => r.id) } },
        })
      ).map((row) => new ResumeEntity(ResumeStateSchema.parse(row)));
    },
    async deleteDraftsByResume(resumeId, userId) {
      await db.profileDraft.deleteMany({
        where: { userId, sourceResumeId: resumeId },
      });
    },
    async getDraft(id, userId) {
      const row = await db.profileDraft.findFirst({ where: { id, userId } });
      return row ? new ProfileDraftEntity(DraftStateSchema.parse(row)) : null;
    },
    async insertDraft(entity) {
      const s = entity.snapshot();
      await db.profileDraft.create({
        data: { ...s, confirmedContent: s.confirmedContent ?? Prisma.DbNull },
      });
    },
    async saveDraft(entity) {
      const s = entity.snapshot();
      await db.profileDraft.update({
        where: { id: s.id },
        data: { ...s, confirmedContent: s.confirmedContent ?? Prisma.DbNull },
      });
    },
    async getProfile(userId) {
      const row = await db.profile.findUnique({ where: { userId } });
      return row
        ? new ConfirmedProfileEntity(ProfileStateSchema.parse(row))
        : null;
    },
    async saveProfile(entity) {
      const s = entity.snapshot();
      await db.profile.upsert({
        where: { userId: s.userId },
        create: s,
        update: s,
      });
    },
    async registerFileDeletion(key, userId, now) {
      await db.taskOutbox.upsert({
        where: { eventKey: `file.delete:${key}` },
        create: {
          id: key,
          eventKey: `file.delete:${key}`,
          kind: 'file.delete',
          resourceReference: key,
          target: { userId, key },
          availableAt: now,
        },
        update: { completedAt: null, status: 'queued', availableAt: now },
      });
    },
    async nextFileDeletion(now) {
      const row = await db.taskOutbox.findFirst({
        where: {
          kind: 'file.delete',
          completedAt: null,
          availableAt: { lte: now },
        },
        orderBy: { availableAt: 'asc' },
      });
      if (!row) return null;
      const target = z
        .object({ userId: z.uuid(), key: z.uuid() })
        .parse(row.target);
      return { id: row.id, ...target };
    },
    async finishFileDeletion(id, now) {
      await db.taskOutbox.updateMany({
        where: { id, kind: 'file.delete' },
        data: { completedAt: now, status: 'succeeded' },
      });
    },
  };
}
