import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  IngestionError,
  parseEvidenceHtml,
  type SourceReader,
} from '@career/business';
import {
  makeIngestionFixture,
  fakeSource,
  jobHtml,
} from '../fixtures/ingestion.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function fixture(source: SourceReader = fakeSource()) {
  const f = await makeIngestionFixture(source);
  cleanups.push(f.close);
  return f;
}
describe('采集任务与证据用例', () => {
  it('发现登记和正文写入可重放，校招社招都保留且获取不等于核验', async () => {
    const f = await fixture();
    const input = {
      sourceKey: 'zhidianmijin' as const,
      stream: 'new' as const,
      runId: randomUUID(),
      pageLimit: 1,
    };
    const first = await f.services.discover.execute(input);
    expect(await f.services.discover.execute(input)).toEqual(first);
    expect(await f.services.execution.runOne()).toBe(true);
    await f.services.execution.runOne();
    await f.services.execution.runOne();
    const report = await f.services.coverage.execute();
    expect(report.counts.campus).toBeGreaterThan(0);
    expect(report.counts.social).toBeGreaterThan(0);
    expect(report.counts.reviewed).toBe(0);
    const data = await f.services.export.execute({
      scope: 'all',
      operationKey: randomUUID(),
    });
    expect(data.status).toBe('completed');
    const repeated = await f.services.export.execute({
      existingExportId: data.exportId,
    });
    expect(repeated.manifestDigest).toBe(data.manifestDigest);
    const body = await f.dependencies.exports.read(data.exportId);
    expect(body).not.toContain('actorReference');
    expect(body).not.toContain('leaseUntil');
  });
  it('同runId改内容冲突，不创建另一个扫描周期', async () => {
    const f = await fixture();
    const runId = randomUUID();
    await f.services.discover.execute({
      sourceKey: 'zhidianmijin',
      stream: 'backfill',
      runId,
      pageLimit: 1,
    });
    await expect(
      f.services.discover.execute({
        sourceKey: 'zhidianmijin',
        stream: 'backfill',
        runId,
        pageLimit: 2,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('网络失败退避，失败不推进检查点或刷新成功时间', async () => {
    const source = fakeSource();
    source.list = async () => {
      throw new IngestionError('SOURCE_UNAVAILABLE');
    };
    const f = await fixture(source);
    const registration = await f.services.discover.execute({
      sourceKey: 'zhidianmijin',
      stream: 'new',
      runId: randomUUID(),
      pageLimit: 1,
    });
    await f.services.execution.runOne();
    await f.dependencies.unitOfWork.run(async (c) => {
      const repo = f.dependencies.repositories(c);
      const task = await repo.getTask(registration.taskId);
      expect(task!.snapshot().status).toBe('retry_wait');
      expect((await repo.lockStream('new')).snapshot().checkpoint).toBe(1);
    });
  });
  it('证据核验检查定位，旧版本和缺失外站不能被标为完整', async () => {
    const f = await fixture();
    await f.services.discover.execute({
      sourceKey: 'zhidianmijin',
      stream: 'new',
      runId: randomUUID(),
      pageLimit: 1,
    });
    for (let i = 0; i < 5; i++) await f.services.execution.runOne();
    const state = await f.dependencies.unitOfWork.run(async (c) => {
      const repo = f.dependencies.repositories(c);
      const resources = await repo.listResources();
      const resource = resources.find(
        (r) => r.snapshot().kind === 'job' && r.snapshot().currentVersionId,
      )!;
      const job = await repo.getJobByResource(resource.snapshot().id);
      const version = await repo.getVersion(
        resource.snapshot().currentVersionId!,
      );
      const observation = await repo.latestObservation(resource.snapshot().id);
      return {
        job: job!,
        resource: resource.snapshot(),
        version: version!.snapshot(),
        observation: observation!,
      };
    });
    const text = state.version.body.blocks[0]!;
    const ref = {
      resourceId: state.resource.id,
      versionId: state.version.id,
      observationId: state.observation.id,
      block: 0,
      start: 0,
      end: text.length,
      excerpt: text,
    };
    const input = {
      jobId: state.job.id,
      expectedJobVersion: state.version.id,
      expectedReviewVersion: state.resource.reviewVersion,
      evidenceVersions: [
        { resourceId: state.resource.id, versionId: state.version.id },
      ],
      tree: { type: 'unknown' as const, reason: '经验未明确', evidence: [ref] },
      isComplete: false,
      gaps: ['经验未明确'],
      conflicts: [],
      reason: '测试核验',
      operationKey: randomUUID(),
    };
    const result = await f.services.review.execute(input);
    expect(result.isComplete).toBe(false);
    expect(await f.services.review.execute(input)).toEqual(result);
    await expect(
      f.services.review.execute({
        ...input,
        operationKey: randomUUID(),
        expectedJobVersion: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'EVIDENCE_VERSION_CONFLICT' });
    await expect(
      f.services.review.execute({
        ...input,
        operationKey: randomUUID(),
        expectedReviewVersion: result.reviewVersion,
        isComplete: true,
        gaps: [],
      }),
    ).rejects.toMatchObject({ code: 'EVIDENCE_INCOMPLETE' });
  });
  it('正文摘要不会因相同页面重复执行新增版本', async () => {
    const source = fakeSource();
    source.evidence = async () => parseEvidenceHtml(jobHtml(), new Date());
    const f = await fixture(source);
    await f.services.discover.execute({
      sourceKey: 'zhidianmijin',
      stream: 'new',
      runId: randomUUID(),
      pageLimit: 1,
    });
    for (let i = 0; i < 4; i++) await f.services.execution.runOne();
    const first = await f.services.coverage.execute();
    expect(first.counts.fetched).toBeGreaterThan(0);
  });
});
