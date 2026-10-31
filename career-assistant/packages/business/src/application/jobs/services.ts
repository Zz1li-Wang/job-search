import {
  ProfileSchema,
  type ActorDto,
  type JobQueryDto,
  type JobSummaryDto,
  type JobDetailDto,
  type EvidenceBundleDto,
  type EvidenceEntryDto,
  type EvaluateInputDto,
  type EligibilityDto,
  type ProfileDto,
} from '@career/contracts';
import type { JobsDependencies, JobRecord } from './ports.js';
import type { TransactionContext } from '../ports.js';
import {
  assertActor,
  originalReference,
  remember,
} from '../ingestion/support.js';
import { IngestionError } from '../../domain/ingestion/errors.js';
import { EligibilityCheckEntity } from '../../domain/jobs/entities.js';
import {
  EligibilityAggregate,
  RULES_VERSION,
  evidenceFresh,
} from '../../domain/jobs/eligibility.js';
import { z } from 'zod';
import { businessOperation } from '../business-operation.js';
import { BusinessError } from '../../domain/shared/errors.js';
const CursorSchema = z.object({
  recordedAt: z.string(),
  id: z.uuid(),
  snapshotAt: z.string(),
  filter: z.string(),
  expires: z.number(),
});
interface JobContext {
  summary: JobSummaryDto;
  detail: JobDetailDto;
  evidence: EvidenceBundleDto;
}
/** 构建一致读的领域投影；访问权限和协议输入不由Repository决定。 */
export class JobQueryService {
  constructor(private readonly d: JobsDependencies) {}
  async context(c: TransactionContext, job: JobRecord): Promise<JobContext> {
    const repo = this.d.source(c),
      resource = await repo.getResource(job.resourceId);
    if (!resource?.snapshot().currentVersionId)
      throw new IngestionError('INGESTION_NOT_FOUND');
    const s = resource.snapshot(),
      version = await repo.getVersion(s.currentVersionId!);
    if (!version) throw new IngestionError('INGESTION_NOT_FOUND');
    const body = version.snapshot().body,
      review = s.currentReviewId
        ? await repo.getReview(s.currentReviewId)
        : null,
      rs = review?.snapshot();
    const links = await repo.listLinks(job.id),
      ids = [
        ...new Set([
          job.resourceId,
          ...links.flatMap((l) => (l.resourceId ? [l.resourceId] : [])),
        ]),
      ].sort(),
      entries: EvidenceEntryDto[] = [],
      dependencies: [string, string | null][] = [];
    for (const id of ids) {
      const r = await repo.getResource(id);
      if (!r?.snapshot().currentVersionId) {
        dependencies.push([id, null]);
        continue;
      }
      const v = await repo.getVersion(r.snapshot().currentVersionId!),
        observation = await repo.latestObservation(id);
      dependencies.push([id, r.snapshot().currentVersionId]);
      if (v && observation)
        entries.push({
          resourceId: id,
          versionId: v.snapshot().id,
          observationId: observation.id,
          sourceUrl: r.snapshot().canonicalUrl,
          blocks: v.snapshot().body.blocks,
          fetchedAt: observation.fetchedAt.toISOString(),
        });
    }
    const dependencyHash = this.d.digest(
      JSON.stringify({
        versions: dependencies,
        links: links.map((l) => [l.url, l.resourceId, l.associationStatus]),
        reviewId: s.currentReviewId,
        reviewVersion: s.reviewVersion,
      }),
    );
    const freshness = version.freshness(rs?.verifiedAt ?? null, this.d.now());
    const warnings = [
      ...(!rs?.isComplete ? ['岗位条件尚未完整人工核验'] : []),
      ...(freshness === 'pending' ? ['证据或报名状态需复查'] : []),
    ];
    const summary: JobSummaryDto = {
      id: job.id,
      jobVersionId: version.snapshot().id,
      title: body.title,
      company: body.company,
      cities: body.cities,
      recruitmentType: body.recruitmentType,
      recordedAt: job.recordedAt.toISOString(),
      lastFetchedAt: s.lastFetchedAt?.toISOString() ?? null,
      verifiedAt: rs?.verifiedAt?.toISOString() ?? null,
      deadline: body.deadline,
      availability: freshness === 'closed' ? 'closed' : body.availability,
      reviewState: rs?.isComplete ? 'reviewed' : 'pending',
      freshness,
      warnings,
    };
    return {
      summary,
      detail: {
        ...summary,
        blocks: body.blocks,
        tree: rs?.tree ?? null,
        reviewId: s.currentReviewId,
        reviewVersion: s.reviewVersion,
        evidenceDependencyHash: dependencyHash,
        isComplete: rs?.isComplete ?? false,
        gaps: rs?.gaps ?? ['完整条件未核验'],
        conflicts: rs?.conflicts ?? [],
        sourceLinks: [s.canonicalUrl, ...links.map((l) => l.url)],
      },
      evidence: {
        jobId: job.id,
        jobVersionId: version.snapshot().id,
        reviewId: s.currentReviewId,
        reviewVersion: s.reviewVersion,
        dependencyHash,
        entries,
        unvisitedUrls: links
          .filter(
            (l) =>
              !l.resourceId ||
              !entries.some((e) => e.resourceId === l.resourceId),
          )
          .map((l) => l.url),
      },
    };
  }
  detail(id: string, actor: ActorDto): Promise<JobDetailDto> {
    return businessOperation(() =>
      this.d.repeatableRead(async (c) => {
        await assertActor(this.d.source(c), actor);
        const job = await this.d.repositories(c).getJob(id);
        if (!job) throw new IngestionError('INGESTION_NOT_FOUND');
        return (await this.context(c, job)).detail;
      }),
    );
  }
  evidence(
    id: string,
    expected: string | undefined,
    actor: ActorDto,
  ): Promise<EvidenceBundleDto> {
    return businessOperation(() =>
      this.d.repeatableRead(async (c) => {
        await assertActor(this.d.source(c), actor);
        const job = await this.d.repositories(c).getJob(id);
        if (!job) throw new IngestionError('INGESTION_NOT_FOUND');
        const context = await this.context(c, job);
        if (expected && expected !== context.detail.jobVersionId)
          throw new IngestionError('EVIDENCE_VERSION_CONFLICT');
        return context.evidence;
      }),
    );
  }
  list(query: JobQueryDto, actor: ActorDto) {
    return businessOperation(() =>
      this.d.repeatableRead(async (c) => {
        await assertActor(this.d.source(c), actor);
        const now = this.d.now();
        const filter = this.d.digest(
          JSON.stringify({ ...query, limit: undefined, cursor: undefined }),
        );
        let cursor: z.infer<typeof CursorSchema> | null = null;
        if (query.cursor) {
          try {
            const [encoded, signature] = query.cursor.split('.');
            if (
              !encoded ||
              !signature ||
              !this.d.tokens.matches(
                signature,
                this.d.tokens.digest('job-cursor', encoded),
              )
            )
              throw Error();
            cursor = CursorSchema.parse(
              JSON.parse(Buffer.from(encoded, 'base64url').toString()),
            );
            if (cursor.filter !== filter || cursor.expires < now.getTime())
              throw Error();
          } catch {
            throw new BusinessError('INVALID_CURSOR');
          }
        }
        const snapshotAt = cursor?.snapshotAt ?? now.toISOString(),
          results: JobSummaryDto[] = [];
        for (const job of await this.d.repositories(c).listJobs()) {
          const time = job.recordedAt.toISOString();
          if (
            time > snapshotAt ||
            (cursor &&
              (time > cursor.recordedAt ||
                (time === cursor.recordedAt && job.id >= cursor.id)))
          )
            continue;
          let context: JobContext;
          try {
            context = await this.context(c, job);
          } catch (error) {
            if (
              error instanceof IngestionError &&
              error.code === 'INGESTION_NOT_FOUND'
            )
              continue;
            throw error;
          }
          const s = context.summary;
          const keyword = query.keyword?.normalize('NFKC').toLocaleLowerCase();
          if (
            keyword &&
            !`${s.title} ${s.company ?? ''}`
              .normalize('NFKC')
              .toLocaleLowerCase()
              .includes(keyword)
          )
            continue;
          if (query.city && !s.cities.includes(query.city)) continue;
          if (
            query.recruitmentType &&
            s.recruitmentType !== query.recruitmentType
          )
            continue;
          if (
            query.degree &&
            context.detail.isComplete &&
            s.freshness === 'fresh' &&
            context.detail.tree?.type === 'condition' &&
            context.detail.tree.condition.field === 'degree' &&
            !context.detail.tree.condition.value.includes(query.degree)
          )
            continue;
          results.push(s);
          if (results.length > query.limit) break;
        }
        const hasMore = results.length > query.limit;
        const entries = results.slice(0, query.limit);
        let nextCursor: string | null = null;
        if (hasMore && entries.length) {
          const last = entries.at(-1)!;
          const encoded = Buffer.from(
            JSON.stringify({
              recordedAt: last.recordedAt,
              id: last.id,
              snapshotAt,
              filter,
              expires: cursor?.expires ?? now.getTime() + 900_000,
            }),
          ).toString('base64url');
          nextCursor =
            encoded + '.' + this.d.tokens.digest('job-cursor', encoded);
        }
        return { entries, nextCursor };
      }),
    );
  }
}
export class ProfileQueryService {
  constructor(private readonly d: JobsDependencies) {}
  execute(actor: ActorDto): Promise<ProfileDto> {
    return businessOperation(() =>
      this.d.unitOfWork.run(async (c) => {
        await assertActor(this.d.source(c), actor);
        const profile = await this.d.repositories(c).getProfile(actor.userId);
        const s = profile?.snapshot();
        return ProfileSchema.parse({
          content: s?.content ?? null,
          version: s?.version ?? 0,
          confirmedAt: s?.confirmedAt.toISOString() ?? null,
        });
      }),
    );
  }
}
export class EligibilityService {
  constructor(
    private readonly d: JobsDependencies,
    private readonly jobs: JobQueryService,
  ) {}
  create(
    input: EvaluateInputDto,
    key: string,
    actor: ActorDto,
  ): Promise<EligibilityDto> {
    return businessOperation(() =>
      this.d.unitOfWork.run(async (c) => {
        const source = this.d.source(c);
        await assertActor(source, actor);
        await source.lockStream('new');
        const repo = this.d.repositories(c),
          scope = `user:${actor.userId}:eligibility`,
          hash = this.d.digest(JSON.stringify(input));
        const previous = await originalReference(source, scope, key, hash);
        if (previous) return this.readWithinTransaction(c, previous, actor);
        const job = await repo.getJob(input.jobId);
        if (!job) throw new IngestionError('INGESTION_NOT_FOUND');
        await source.getResource(job.resourceId, true);
        const context = await this.jobs.context(c, job),
          profile = await repo.getProfile(actor.userId);
        const ps = profile?.snapshot(),
          detail = context.detail;
        if (
          input.expectedJobVersion !== detail.jobVersionId ||
          input.expectedProfileVersion !== (ps?.version ?? 0) ||
          input.expectedReviewVersion !== detail.reviewVersion ||
          input.expectedEvidenceDependencyHash !== detail.evidenceDependencyHash
        )
          throw new IngestionError('EVIDENCE_VERSION_CONFLICT');
        const now = this.d.now(),
          id = this.d.id();
        const computed = new EligibilityAggregate().decide(
          detail.tree,
          ps?.content ?? null,
          {
            availability: detail.availability,
            isComplete: detail.isComplete,
            conflicts: detail.conflicts.length,
            freshness: detail.freshness,
            unvisited: context.evidence.unvisitedUrls.length,
          },
        );
        const { status, isTrusted } = computed;
        const decision: EligibilityDto = {
          checkId: id,
          status,
          checks: computed.checks,
          jobId: job.id,
          jobVersionId: detail.jobVersionId,
          profileVersion: ps?.version ?? 0,
          reviewVersion: detail.reviewVersion,
          evidenceDependencyHash: detail.evidenceDependencyHash,
          rulesVersion: RULES_VERSION,
          evaluatedAt: now.toISOString(),
          isCurrent: isTrusted,
          invalidatedReasons: isTrusted ? [] : ['当前证据或画像尚不完整'],
          warnings: [
            ...detail.warnings,
            ...(!ps ? ['尚无本人已确认画像'] : []),
            '结论针对已收录版本，不保证官方审核或录用',
          ],
        };
        await repo.insertCheck(
          new EligibilityCheckEntity({
            id,
            userId: actor.userId,
            jobId: job.id,
            jobVersionId: detail.jobVersionId,
            profileVersion: ps?.version ?? 0,
            reviewVersion: detail.reviewVersion,
            dependencyHash: detail.evidenceDependencyHash,
            rulesVersion: RULES_VERSION,
            evaluatedAt: now,
            decision,
          }),
        );
        await remember(source, scope, key, hash, id, now);
        return decision;
      }),
    );
  }
  get(id: string, actor: ActorDto): Promise<EligibilityDto> {
    return businessOperation(() =>
      this.d.repeatableRead(async (c) => {
        await assertActor(this.d.source(c), actor);
        return this.readWithinTransaction(c, id, actor);
      }),
    );
  }
  async readWithinTransaction(
    c: TransactionContext,
    id: string,
    actor: ActorDto,
  ): Promise<EligibilityDto> {
    const repo = this.d.repositories(c);
    const check = await repo.getCheckOwned(id, actor.userId);
    if (!check) throw new IngestionError('INGESTION_NOT_FOUND');
    const job = await repo.getJob(check.snapshot().jobId);
    if (!job)
      return {
        ...check.snapshot().decision,
        isCurrent: false,
        invalidatedReasons: ['岗位记录不可用'],
      };
    const context = await this.jobs.context(c, job),
      profile = await repo.getProfile(actor.userId);
    return check.output({
      jobVersionId: context.detail.jobVersionId,
      profileVersion: profile?.snapshot().version ?? 0,
      reviewVersion: context.detail.reviewVersion,
      dependencyHash: context.detail.evidenceDependencyHash,
      rulesVersion: RULES_VERSION,
      isFresh:
        context.detail.freshness === 'fresh' &&
        evidenceFresh(
          context.summary.verifiedAt
            ? new Date(context.summary.verifiedAt)
            : null,
          context.summary.deadline,
          this.d.now(),
        ),
    });
  }
}
export function createJobsServices(d: JobsDependencies) {
  const jobs = new JobQueryService(d);
  return {
    jobs,
    profile: new ProfileQueryService(d),
    eligibility: new EligibilityService(d, jobs),
  };
}
