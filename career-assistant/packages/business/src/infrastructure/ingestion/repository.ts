import { z } from 'zod';
import { RuleTreeSchema } from '@career/contracts';
import {
  SourceTaskEntity,
  SourceTaskStateSchema,
} from '../../domain/ingestion/task.js';
import {
  SourceResourceEntity,
  SourceStreamEntity,
  BodyStateSchema,
} from '../../domain/ingestion/source.js';
import {
  SourceVersionEntity,
  RequirementReviewEntity,
  ReviewStateSchema,
} from '../../domain/ingestion/evidence.js';
import { IngestionError } from '../../domain/ingestion/errors.js';
import { INGESTION_POLICY } from '../../domain/ingestion/policy.js';
import type {
  IngestionRepository,
  ExportRecord,
} from '../../application/ingestion/ports.js';
import type { AuthRepositories } from '../../application/auth/ports.js';
import type { IdempotencyRepository } from '../../application/ports.js';
import type { Prisma } from '../generated/client.js';

type TaskRow = Prisma.TaskOutboxGetPayload<object>;
type ReviewRow = Prisma.RequirementReviewGetPayload<object>;
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const task = (row: TaskRow) =>
  new SourceTaskEntity(SourceTaskStateSchema.parse(row));
const reviewContent = ReviewStateSchema.pick({
  tree: true,
  evidenceVersions: true,
  gaps: true,
  conflicts: true,
  reason: true,
});
const review = (row: ReviewRow) =>
  new RequirementReviewEntity({ ...row, ...reviewContent.parse(row.content) });
const exportEntries = z.array(
  z.object({
    versions: z.array(
      z.object({
        versionId: z.uuid(),
        materialHash: z.string(),
        body: BodyStateSchema,
        createdAt: z.string(),
      }),
    ),
    observations: z.array(
      z.object({
        observationId: z.uuid(),
        versionId: z.uuid(),
        fetchedAt: z.string(),
        httpStatus: z.number().int(),
        rawDigest: z.string(),
        parserVersion: z.string(),
      }),
    ),
    reviews: z.array(
      z.object({
        reviewId: z.uuid(),
        jobVersionId: z.uuid(),
        isComplete: z.boolean(),
        reviewedAt: z.string(),
        verifiedAt: z.string().nullable(),
        tree: RuleTreeSchema,
        evidenceVersions: z.array(
          z.object({ resourceId: z.uuid(), versionId: z.uuid() }),
        ),
      }),
    ),
    resourceId: z.uuid(),
    kind: z.enum(['job', 'announcement']),
    sourceId: z.string(),
    url: z.string(),
    versionId: z.uuid(),
    body: BodyStateSchema,
    fetchedAt: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    verifiedAt: z.string().nullable(),
    isComplete: z.boolean(),
  }),
);
const exportRow = (row: Prisma.ExportRunGetPayload<object>): ExportRecord => ({
  ...row,
  status: z.enum(['pending', 'completed']).parse(row.status),
  entries: exportEntries.parse(row.entries),
});

/** ORM类型、SQL及JSON映射全部封闭在持久化适配器。 */
export function createIngestionRepository(
  transaction: () => Prisma.TransactionClient,
  auth: AuthRepositories,
  records: IdempotencyRepository,
): IngestionRepository {
  const tx = transaction();
  return {
    accounts: auth.accounts,
    async getExecutionState(id) {
      return tx.agentRun.findUnique({
        where: { id },
        select: {
          userId: true,
          kind: true,
          resourceId: true,
          status: true,
          authEpoch: true,
          personalDataEpoch: true,
          leaseUntil: true,
        },
      });
    },
    records,
    async now() {
      const [row] = await tx.$queryRaw<
        { now: Date }[]
      >`SELECT clock_timestamp() AS now`;
      return row!.now;
    },
    async listStreams() {
      return (await tx.sourceStream.findMany({ orderBy: { id: 'asc' } })).map(
        (row) =>
          new SourceStreamEntity({
            ...row,
            streamKey: z.enum(['new', 'backfill']).parse(row.streamKey),
          }),
      );
    },
    async reapExpired(now, limit) {
      await tx.$executeRaw`WITH expired AS (SELECT id FROM task_outbox WHERE source_key='zhidianmijin' AND status='running' AND lease_until<=${now} AND attempt>=attempt_limit ORDER BY id FOR UPDATE SKIP LOCKED LIMIT ${limit}) UPDATE task_outbox SET status='failed', error_code='SOURCE_UNAVAILABLE',lease_until=NULL, updated_at=${now} WHERE id IN (SELECT id FROM expired)`;
    },
    async lockStream(streamKey) {
      const id = `zhidianmijin:${streamKey}`;
      await tx.sourceStream.createMany({
        data: [
          {
            id,
            streamKey,
            generation: 0,
            checkpoint: 1,
            checkpointVersion: 0,
            nextDiscoveryAt: new Date(0),
            pauseReason: null,
            stateVersion: 0,
          },
        ],
        skipDuplicates: true,
      });
      await tx.$queryRaw`SELECT id FROM source_streams WHERE id=${id} FOR UPDATE`;
      return new SourceStreamEntity({
        ...(await tx.sourceStream.findUniqueOrThrow({ where: { id } })),
        streamKey,
      });
    },
    async updateStream(stream, expected) {
      const s = stream.snapshot();
      return (
        (
          await tx.sourceStream.updateMany({
            where: { id: s.id, stateVersion: expected },
            data: s,
          })
        ).count === 1
      );
    },
    async getTask(id, lock = false) {
      if (lock)
        await tx.$queryRaw`SELECT id FROM task_outbox WHERE id=${id}::uuid FOR UPDATE`;
      const row = await tx.taskOutbox.findUnique({ where: { id } });
      return row?.sourceKey ? task(row) : null;
    },
    async findActive(dedupeKey) {
      const row = await tx.taskOutbox.findFirst({
        where: {
          dedupeKey,
          status: { in: ['queued', 'running', 'retry_wait', 'paused'] },
        },
      });
      if (!row) return null;
      await tx.$queryRaw`SELECT id FROM task_outbox WHERE id=${row.id}::uuid FOR UPDATE`;
      const current = await tx.taskOutbox.findUniqueOrThrow({
        where: { id: row.id },
      });
      return ['queued', 'running', 'retry_wait', 'paused'].includes(
        current.status,
      )
        ? task(current)
        : null;
    },
    async insertTaskIfAbsent(entity) {
      const s = entity.snapshot();
      await tx.taskOutbox.createMany({
        data: [{ ...s, target: json(s.target) }],
        skipDuplicates: true,
      });
      const row = await tx.taskOutbox.findFirstOrThrow({
        where: {
          OR: [
            { eventKey: s.eventKey },
            {
              dedupeKey: s.dedupeKey,
              status: { in: ['queued', 'running', 'retry_wait', 'paused'] },
            },
          ],
        },
      });
      return task(row);
    },
    async saveTask(entity, token) {
      const s = entity.snapshot();
      // 有效租约与围栏在同一条写语句判断，事务前读取时间不能授权过期写入。
      const count = await tx.$executeRaw`UPDATE task_outbox t SET
        status=${s.status},priority=${s.priority},attempt=${s.attempt},attempt_limit=${s.attemptLimit},
        fencing_token=${s.fencingToken},lease_until=${s.leaseUntil},available_at=${s.availableAt},
        completed_at=${s.completedAt},updated_at=${s.updatedAt},requested_at=${s.requestedAt},
        refresh_generation=${s.refreshGeneration},claimed_refresh_generation=${s.claimedRefreshGeneration},
        error_code=${s.errorCode},successor_task_id=${s.successorTaskId}::uuid,target=${JSON.stringify(s.target)}::jsonb
        WHERE t.id=${s.id}::uuid AND t.fencing_token=${token} AND (
          t.status<>'running'
          OR (${s.fencingToken}>${token} AND t.lease_until<=clock_timestamp())
          OR (${s.fencingToken}=${token} AND t.lease_until>clock_timestamp())
          OR (${s.status}='running' AND ${s.refreshGeneration}>t.refresh_generation AND t.lease_until IS NOT DISTINCT FROM ${s.leaseUntil}::timestamptz)
        )`;
      return count === 1;
    },
    async claimCandidate(now, ordinary) {
      const rows = ordinary
        ? await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM task_outbox WHERE source_key='zhidianmijin' AND NOT EXISTS (SELECT 1 FROM source_streams WHERE pause_reason IS NOT NULL) AND priority>=4 AND attempt<attempt_limit AND ((status IN ('queued','retry_wait') AND available_at<=${now}) OR (status='running' AND lease_until<=${now})) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`
        : await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM task_outbox WHERE source_key='zhidianmijin' AND NOT EXISTS (SELECT 1 FROM source_streams WHERE pause_reason IS NOT NULL) AND attempt<attempt_limit AND ((status IN ('queued','retry_wait') AND available_at<=${now}) OR (status='running' AND lease_until<=${now})) ORDER BY priority,available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`;
      const row = rows[0];
      return row
        ? task(await tx.taskOutbox.findUniqueOrThrow({ where: { id: row.id } }))
        : null;
    },
    async insertAttempt(record) {
      await tx.taskAttempt.create({ data: record });
    },
    async getAttempt(taskId, attempt) {
      return tx.taskAttempt.findUniqueOrThrow({
        where: { taskId_attempt: { taskId, attempt } },
      });
    },
    async endAttempt(record) {
      await tx.taskAttempt.update({ where: { id: record.id }, data: record });
    },
    async addRequester(taskId, userId) {
      await tx.taskRequester.createMany({
        data: [{ taskId, userId }],
        skipDuplicates: true,
      });
    },
    async hasRequester(taskId, userId) {
      return !!(await tx.taskRequester.findUnique({
        where: { userId_taskId: { userId, taskId } },
      }));
    },
    async copyRequesters(from, to) {
      await tx.$executeRaw`INSERT INTO task_requesters(user_id,task_id) SELECT user_id,${to}::uuid FROM task_requesters WHERE task_id=${from}::uuid ON CONFLICT DO NOTHING`;
    },
    async listTasks() {
      return (
        await tx.taskOutbox.findMany({ where: { sourceKey: 'zhidianmijin' } })
      ).map(task);
    },
    async ensureResource(entity) {
      const s = entity.snapshot();
      await tx.sourceResource.createMany({
        data: [{ ...s, sourceKey: 'zhidianmijin' }],
        skipDuplicates: true,
      });
      const row = await tx.sourceResource.findUniqueOrThrow({
        where: {
          sourceKey_kind_sourceId: {
            sourceKey: 'zhidianmijin',
            kind: s.kind,
            sourceId: s.sourceId,
          },
        },
      });
      return new SourceResourceEntity({
        ...row,
        kind: z.enum(['job', 'announcement']).parse(row.kind),
      });
    },
    async getResource(id, lock = false) {
      if (lock)
        await tx.$queryRaw`SELECT id FROM source_resources WHERE id=${id}::uuid FOR UPDATE`;
      const row = await tx.sourceResource.findUnique({ where: { id } });
      return row
        ? new SourceResourceEntity({
            ...row,
            kind: z.enum(['job', 'announcement']).parse(row.kind),
          })
        : null;
    },
    async saveResource(entity, expected) {
      const s = entity.snapshot();
      return (
        (
          await tx.sourceResource.updateMany({
            where: { id: s.id, stateVersion: expected },
            data: s,
          })
        ).count === 1
      );
    },
    async listResources() {
      return (await tx.sourceResource.findMany({ orderBy: { id: 'asc' } })).map(
        (row) =>
          new SourceResourceEntity({
            ...row,
            kind: z.enum(['job', 'announcement']).parse(row.kind),
          }),
      );
    },
    async ensureJob(record) {
      await tx.job.createMany({ data: [record], skipDuplicates: true });
      return tx.job.findUniqueOrThrow({
        where: { resourceId: record.resourceId },
      });
    },
    async getJob(id) {
      return tx.job.findUnique({ where: { id } });
    },
    async getJobByResource(resourceId) {
      return tx.job.findUnique({ where: { resourceId } });
    },
    async listVersions(resourceId) {
      return (
        await tx.sourceVersion.findMany({
          where: { resourceId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      ).map(
        (row) =>
          new SourceVersionEntity({
            ...row,
            body: BodyStateSchema.parse(row.body),
          }),
      );
    },
    async listObservations(resourceId) {
      return tx.fetchObservation.findMany({
        where: { resourceId },
        orderBy: [{ fetchedAt: 'asc' }, { id: 'asc' }],
      });
    },
    async listReviews(jobId) {
      return (
        await tx.requirementReview.findMany({
          where: { jobId },
          orderBy: { reviewVersion: 'asc' },
        })
      ).map(review);
    },
    async getVersion(id) {
      const row = await tx.sourceVersion.findUnique({ where: { id } });
      return row
        ? new SourceVersionEntity({
            ...row,
            body: BodyStateSchema.parse(row.body),
          })
        : null;
    },
    async findVersion(resourceId, materialHash) {
      const row = await tx.sourceVersion.findUnique({
        where: { resourceId_materialHash: { resourceId, materialHash } },
      });
      return row
        ? new SourceVersionEntity({
            ...row,
            body: BodyStateSchema.parse(row.body),
          })
        : null;
    },
    async insertVersion(version) {
      const s = version.snapshot();
      await tx.sourceVersion.create({ data: { ...s, body: json(s.body) } });
    },
    async insertSnapshot(snapshot) {
      await tx.sourceSnapshot.create({ data: snapshot });
    },
    async isSnapshotReferenced(id) {
      return (await tx.sourceSnapshot.count({ where: { id } })) > 0;
    },
    async lockFile(key) {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))::text`;
    },
    async insertObservation(observation) {
      await tx.fetchObservation.create({ data: observation });
    },
    async getObservation(id) {
      return tx.fetchObservation.findUnique({ where: { id } });
    },
    async latestObservation(resourceId) {
      return tx.fetchObservation.findFirst({
        where: { resourceId },
        orderBy: [{ fetchedAt: 'desc' }, { id: 'desc' }],
      });
    },
    async replaceLinks(jobId, versionId, links) {
      await tx.jobEvidenceLink.deleteMany({ where: { jobId } });
      if (links.length)
        await tx.jobEvidenceLink.createMany({
          data: links.map((link) => ({
            ...link,
            associationVersion: versionId,
          })),
          skipDuplicates: true,
        });
    },
    async listLinks(jobId) {
      return tx.jobEvidenceLink.findMany({
        where: { jobId },
        orderBy: { url: 'asc' },
      });
    },
    async listJobsLinkedTo(resourceId) {
      return tx.job.findMany({ where: { links: { some: { resourceId } } } });
    },
    async insertDraft(resourceId, jobVersionId, body) {
      await tx.requirementDraft.createMany({
        data: [
          {
            id: jobVersionId,
            resourceId,
            jobVersionId,
            fields: json({
              title: body.title,
              company: body.company,
              cities: body.cities,
              recruitmentType: body.recruitmentType,
              deadline: body.deadline,
              blocks: body.blocks.map((text, block) => ({ block, text })),
            }),
            parserVersion: body.parserVersion,
          },
        ],
        skipDuplicates: true,
      });
    },
    async insertReview(entity) {
      const s = entity.snapshot();
      const { tree, evidenceVersions, gaps, conflicts, reason, ...fields } = s;
      await tx.requirementReview.create({
        data: {
          ...fields,
          content: json({ tree, evidenceVersions, gaps, conflicts, reason }),
        },
      });
    },
    async getReview(id) {
      const row = await tx.requirementReview.findUnique({ where: { id } });
      return row ? review(row) : null;
    },
    async findReview(jobId, reviewDigest) {
      const row = await tx.requirementReview.findUnique({
        where: { jobId_reviewDigest: { jobId, reviewDigest } },
      });
      return row ? review(row) : null;
    },
    async audit(id, actorReference, action, occurredAt) {
      await tx.auditEvent.create({
        data: { id, actorReference, action, occurredAt },
      });
    },
    async reserveBudget(id, limit) {
      if (limit > INGESTION_POLICY.maximumRealRequests || limit < 0)
        throw new IngestionError('SOURCE_BUDGET_EXHAUSTED');
      await tx.sourceRequestBudget.createMany({
        data: [{ id, limit, used: 0 }],
        skipDuplicates: true,
      });
      const rows = await tx.$queryRaw<
        { used: number }[]
      >`UPDATE source_request_budgets SET used=used+1 WHERE id=${id} AND used<"limit" AND "limit"=${limit} RETURNING used`;
      return rows.length === 1;
    },
    async budgetUsed(id) {
      return (
        (await tx.sourceRequestBudget.findUnique({ where: { id } }))?.used ?? 0
      );
    },
    async reservePermit(host, owner, now, gapMs) {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${host},0))::text`;
      const main = await tx.domainPermit.upsert({
        where: { id: host },
        create: { id: host, nextStartAt: new Date(0) },
        update: {},
      });
      // 主机启动许可保留到响应结束，使预算/调度延迟也不能挤压实际启动间隔。
      if (main.owner && main.leaseUntil && main.leaseUntil > now) return false;
      if (main.nextStartAt > now) return false;
      const slots = await tx.domainPermit.findMany({
        where: { id: { in: [`${host}:0`, `${host}:1`] } },
      });
      const slot = [0, 1].find(
        (index) =>
          !slots.some(
            (s) =>
              s.id === `${host}:${index}` && s.leaseUntil && s.leaseUntil > now,
          ),
      );
      if (slot === undefined) return false;
      await tx.domainPermit.upsert({
        where: { id: `${host}:${slot}` },
        create: {
          id: `${host}:${slot}`,
          owner,
          leaseUntil: new Date(
            now.getTime() + INGESTION_POLICY.requestTimeoutMs + 5000,
          ),
          nextStartAt: now,
        },
        update: {
          owner,
          leaseUntil: new Date(
            now.getTime() + INGESTION_POLICY.requestTimeoutMs + 5000,
          ),
        },
      });
      await tx.domainPermit.update({
        where: { id: host },
        data: {
          nextStartAt: new Date(now.getTime() + gapMs),
          owner,
          leaseUntil: new Date(now.getTime() + 45_000),
        },
      });
      return true;
    },
    async releasePermit(owner) {
      await tx.$executeRaw`UPDATE domain_permits SET owner=NULL,lease_until=NULL,next_start_at=GREATEST(next_start_at,clock_timestamp()+interval '1.005 seconds') WHERE owner=${owner}::uuid`;
    },
    async readRobots() {
      const row = await tx.domainPermit.findUnique({ where: { id: 'robots' } });
      if (!row?.state) return null;
      return z
        .object({ text: z.string(), fetchedAt: z.string() })
        .parse(row.state);
    },
    async saveRobots(text, fetchedAt) {
      await tx.domainPermit.upsert({
        where: { id: 'robots' },
        create: {
          id: 'robots',
          nextStartAt: fetchedAt,
          state: { text, fetchedAt: fetchedAt.toISOString() },
        },
        update: { state: { text, fetchedAt: fetchedAt.toISOString() } },
      });
    },
    async getExport(id) {
      const row = await tx.exportRun.findUnique({ where: { id } });
      return row ? exportRow(row) : null;
    },
    async findExport(operationKey) {
      const row = await tx.exportRun.findUnique({ where: { operationKey } });
      return row ? exportRow(row) : null;
    },
    async insertExport(record) {
      await tx.exportRun.create({
        data: { ...record, entries: json(record.entries) },
      });
    },
    async saveExport(record) {
      await tx.exportRun.update({
        where: { id: record.id },
        data: { status: record.status, manifestDigest: record.manifestDigest },
      });
    },
  };
}
