import type {
  TrustDto,
  ExportInputDto,
  ExportResultDto,
} from '@career/contracts';
import { IngestionError } from '../../domain/ingestion/errors.js';
import type {
  IngestionDependencies,
  IngestionRepository,
  ExportRecord,
  ExportEntry,
} from './ports.js';
import { ingestionOperation } from './support.js';
async function publicEntries(
  repo: IngestionRepository,
): Promise<ExportEntry[]> {
  const entries: ExportEntry[] = [];
  for (const entity of await repo.listResources()) {
    const resource = entity.snapshot();
    if (!resource.currentVersionId) continue;
    const version = await repo.getVersion(resource.currentVersionId);
    if (!version) continue;
    const review = resource.currentReviewId
      ? await repo.getReview(resource.currentReviewId)
      : null;
    const job =
      resource.kind === 'job' ? await repo.getJobByResource(resource.id) : null;
    const history = job ? await repo.listReviews(job.id) : [];
    entries.push({
      versions: (await repo.listVersions(resource.id)).map((v) => {
        const s = v.snapshot();
        return {
          versionId: s.id,
          materialHash: s.materialHash,
          body: s.body,
          createdAt: s.createdAt.toISOString(),
        };
      }),
      observations: (await repo.listObservations(resource.id)).map((o) => ({
        observationId: o.id,
        versionId: o.versionId,
        fetchedAt: o.fetchedAt.toISOString(),
        httpStatus: o.httpStatus,
        rawDigest: o.rawDigest,
        parserVersion: o.parserVersion,
      })),
      reviews: history.map((r) => {
        const s = r.snapshot();
        return {
          reviewId: s.id,
          jobVersionId: s.jobVersionId,
          isComplete: s.isComplete,
          reviewedAt: s.reviewedAt.toISOString(),
          verifiedAt: s.verifiedAt?.toISOString() ?? null,
          tree: s.tree,
          evidenceVersions: s.evidenceVersions,
        };
      }),
      resourceId: resource.id,
      kind: resource.kind,
      sourceId: resource.sourceId,
      url: resource.canonicalUrl,
      versionId: resource.currentVersionId,
      body: version.snapshot().body,
      fetchedAt: resource.lastFetchedAt?.toISOString() ?? null,
      reviewedAt: review?.snapshot().reviewedAt.toISOString() ?? null,
      verifiedAt: review?.snapshot().verifiedAt?.toISOString() ?? null,
      isComplete: review?.snapshot().isComplete ?? false,
    });
  }
  return entries;
}
export class CoverageService {
  constructor(private readonly d: IngestionDependencies) {}
  execute(): Promise<TrustDto> {
    return ingestionOperation(() =>
      this.d.unitOfWork.run(async (c) => {
        const repo = this.d.repositories(c);
        const now = await repo.now();
        const entries = await publicEntries(repo);
        const tasks = await repo.listTasks();
        const pauses = [];
        for (const stream of await repo.listStreams()) {
          if (stream.snapshot().pauseReason)
            pauses.push(stream.snapshot().pauseReason!);
        }
        let fresh = 0;
        for (const entry of entries) {
          if (!entry.isComplete || entry.kind !== 'job' || !entry.verifiedAt)
            continue;
          const version = await repo.getVersion(entry.versionId);
          if (version?.freshness(new Date(entry.verifiedAt), now) === 'fresh')
            fresh++;
        }
        const jobs = entries.filter((e) => e.kind === 'job');
        const times = entries
          .flatMap((e) => e.observations.map((o) => o.fetchedAt))
          .sort();
        return {
          computedAt: now.toISOString(),
          firstFetchedAt: times[0] ?? null,
          lastFetchedAt: times.at(-1) ?? null,
          counts: {
            campus: jobs.filter((e) => e.body.recruitmentType === 'campus')
              .length,
            social: jobs.filter((e) => e.body.recruitmentType === 'social')
              .length,
            unknown: jobs.filter((e) => e.body.recruitmentType === 'unknown')
              .length,
            fetched: jobs.length,
            reviewed: jobs.filter((e) => e.isComplete).length,
            fresh,
          },
          queues: [
            'queued',
            'running',
            'retry_wait',
            'paused',
            'failed',
            'succeeded',
          ].map((status) => ({
            status: status as TrustDto['queues'][number]['status'],
            count: tasks.filter((t) => t.snapshot().status === status).length,
          })),
          pausedSources: [...new Set(pauses)],
          coverageWarnings: [
            '只代表已获取记录，未验证全站覆盖',
            '外站原文未访问，不作为完整核验依据',
            ...(this.d.networkEnabled ? [] : ['持续来源网络默认关闭']),
          ],
          verifiedScope: jobs.length
            ? ['已入库岗位与同站公告；具体范围以记录为准']
            : [],
        };
      }),
    );
  }
}
function exportDto(record: ExportRecord): ExportResultDto {
  return {
    exportId: record.id,
    snapshotAt: record.snapshotAt.toISOString(),
    status: record.status,
    manifestDigest: record.manifestDigest,
    recordCount: record.recordCount,
    fileName: record.status === 'completed' ? record.id + '.json' : null,
  };
}
export class DataExportService {
  constructor(private readonly d: IngestionDependencies) {}
  async execute(input: ExportInputDto): Promise<ExportResultDto> {
    return ingestionOperation(async () => {
      let record = await this.d.repeatableRead(async (c) => {
        const repo = this.d.repositories(c);
        if ('existingExportId' in input) {
          const existing = await repo.getExport(input.existingExportId);
          if (!existing) throw new IngestionError('INGESTION_NOT_FOUND');
          return existing;
        }
        await repo.lockFile(`export:${input.operationKey}`);
        const existing = await repo.findExport(input.operationKey);
        if (existing) return existing;
        const snapshotAt = await repo.now();
        const entries = await publicEntries(repo);
        const fresh: ExportRecord = {
          id: this.d.id(),
          operationKey: input.operationKey,
          snapshotAt,
          cutoffSequence: BigInt(entries.length),
          scopeHash: this.d.digest(input.scope),
          status: 'pending',
          manifestDigest: null,
          entries,
          recordCount: entries.length,
        };
        await repo.insertExport(fresh);
        return fresh;
      });
      const content =
        JSON.stringify(
          {
            format: 'career-source-export-1',
            exportId: record.id,
            snapshotAt: record.snapshotAt.toISOString(),
            recordCount: record.recordCount,
            limitations: [
              '实际已获取范围，非全站覆盖',
              '认证列表HTML不保存',
              '条件仍须人工核验',
            ],
            entries: record.entries,
          },
          null,
          2,
        ) + '\n';
      await this.d.exports.write(record.id, content);
      record = {
        ...record,
        status: 'completed',
        manifestDigest: this.d.digest(content),
      };
      await this.d.unitOfWork.run((c) =>
        this.d.repositories(c).saveExport(record),
      );
      return exportDto(record);
    });
  }
}
export class SnapshotMaintenanceService {
  constructor(private readonly d: IngestionDependencies) {}
  async execute(): Promise<number> {
    const files = await this.d.files.listOlderThan(
      new Date(this.d.now().getTime() - 86_400_000),
      100,
    );
    let removed = 0;
    for (const key of files) {
      await this.d.unitOfWork.run(async (c) => {
        const repo = this.d.repositories(c);
        await repo.lockFile(key);
        if (!(await repo.isSnapshotReferenced(key))) {
          await this.d.files.delete(key);
          removed++;
        }
      });
    }
    return removed;
  }
}
