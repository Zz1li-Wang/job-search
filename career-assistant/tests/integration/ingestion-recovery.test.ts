import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  newSourceTask,
  parseEvidenceHtml,
  type SourceReader,
} from '@career/business';
import {
  makeIngestionFixture,
  fakeSource,
  jobHtml,
} from '../fixtures/ingestion.js';
import { isolatedDatabaseUrl, makeAuthFixture } from '../fixtures/auth.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function fixture(source: SourceReader = fakeSource()) {
  const f = await makeIngestionFixture(source);
  cleanups.push(f.close);
  await f.services.discover.execute({
    sourceKey: 'zhidianmijin',
    stream: 'new',
    runId: randomUUID(),
    pageLimit: 1,
  });
  await f.services.execution.runOne();
  return f;
}
async function query(sql: string, values: unknown[] = []) {
  const client = new Client({ connectionString: isolatedDatabaseUrl() });
  await client.connect();
  try {
    return await client.query(sql, values);
  } finally {
    await client.end();
  }
}
function barrier() {
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => (release = resolve));
  return { ready, release };
}
describe('采集故障补偿与迟到防护', () => {
  it('暂停的历史扫描恢复时清除对应流暂停而非错误清除新增流', async () => {
    const source = fakeSource();
    source.list = async () => {
      throw new (await import('@career/business')).IngestionError(
        'SOURCE_ACCESS_BLOCKED',
      );
    };
    const f = await makeIngestionFixture(source);
    cleanups.push(f.close);
    const result = await f.services.discover.execute({
      sourceKey: 'zhidianmijin',
      stream: 'backfill',
      runId: randomUUID(),
      pageLimit: 1,
    });
    await f.services.execution.runOne();
    const before = await f.dependencies.unitOfWork.run((c) =>
      f.dependencies.repositories(c).getTask(result.taskId),
    );
    expect(before!.snapshot().status).toBe('paused');
    const retried = await f.services.retry.execute({
      taskId: result.taskId,
      expectedAttempt: 1,
      operationKey: randomUUID(),
    });
    expect(retried.status).toBe('queued');
    expect(
      await f.dependencies.unitOfWork.run(
        async (c) =>
          (await f.dependencies.repositories(c).listStreams())
            .find((s) => s.snapshot().streamKey === 'backfill')!
            .snapshot().pauseReason,
      ),
    ).toBe(null);
  });
  it('旧Worker在网络中失去租约，迟到正文不能覆盖新执行者', async () => {
    const entered = barrier(),
      release = barrier();
    let reads = 0;
    const source = fakeSource();
    source.evidence = async () => {
      const first = ++reads === 1;
      if (first) {
        entered.release();
        await release.ready;
      }
      return parseEvidenceHtml(
        jobHtml('campus', first ? 'OLD' : 'NEW'),
        new Date(),
      );
    };
    const f = await fixture(source);
    const old = (await f.services.execution.claim())!;
    const running = f.services.execution.execute(old);
    await entered.ready;
    await query(
      "UPDATE task_outbox SET lease_until=NOW()-interval '1 second' WHERE id=$1",
      [old.snapshot().id],
    );
    const replacement = (await f.services.execution.claim())!;
    expect(replacement.snapshot().id).toBe(old.snapshot().id);
    expect(replacement.snapshot().fencingToken).toBe(2);
    await f.services.execution.execute(replacement);
    release.release();
    await running;
    const target = old.snapshot().target;
    if (target.kind !== 'fetch') throw Error('测试任务错误');
    await f.dependencies.unitOfWork.run(async (c) => {
      const repo = f.dependencies.repositories(c);
      const resource = await repo.getResource(target.resourceId);
      const version = await repo.getVersion(
        resource!.snapshot().currentVersionId!,
      );
      expect(version!.snapshot().body.title).toContain('NEW');
      expect(await repo.listVersions(target.resourceId)).toHaveLength(1);
    });
  });
  it('快照写失败记录可重试失败，不发布正文或成功时间', async () => {
    const f = await fixture();
    const oldStore = f.dependencies.files;
    f.dependencies.files = {
      ...oldStore,
      async put() {
        throw Error('模拟磁盘不可用');
      },
    };
    const task = (await f.services.execution.claim())!;
    await f.services.execution.execute(task);
    const target = task.snapshot().target;
    if (target.kind !== 'fetch') throw Error();
    await f.dependencies.unitOfWork.run(async (c) => {
      const repo = f.dependencies.repositories(c);
      expect((await repo.getTask(task.snapshot().id))!.snapshot().status).toBe(
        'retry_wait',
      );
      expect(
        (await repo.getResource(target.resourceId))!.snapshot().lastFetchedAt,
      ).toBe(null);
      expect(await repo.listVersions(target.resourceId)).toHaveLength(0);
    });
  });
  it('相同正文重复采集只增加观察，不增加正文版本', async () => {
    const f = await fixture();
    const task = (await f.services.execution.claim())!;
    await f.services.execution.execute(task);
    const target = task.snapshot().target;
    if (target.kind !== 'fetch') throw Error();
    const follow = await f.dependencies.unitOfWork.run(async (c) => {
      const repo = f.dependencies.repositories(c);
      return repo.insertTaskIfAbsent(
        newSourceTask(
          randomUUID(),
          randomUUID(),
          task.snapshot().dedupeKey,
          target,
          await repo.now(),
          0,
        ),
      );
    });
    const next = (await f.services.execution.claim())!;
    expect(next.snapshot().id).toBe(follow.snapshot().id);
    await f.services.execution.execute(next);
    await f.dependencies.unitOfWork.run(async (c) => {
      const repo = f.dependencies.repositories(c);
      expect(await repo.listVersions(target.resourceId)).toHaveLength(1);
      expect(await repo.listObservations(target.resourceId)).toHaveLength(2);
    });
  });
  it('运行中后到刷新形成一个可追踪后继，原任务重放不额外创建', async () => {
    const f = await fixture();
    const task = (await f.services.execution.claim())!;
    const target = task.snapshot().target;
    if (target.kind !== 'fetch') throw Error();
    const auth = await makeAuthFixture();
    cleanups.push(auth.close);
    const { username } = await auth.register();
    const login = await auth.login(username);
    const actor = (
      await auth.services.session.resolve({
        sessionCredential: login.sessionCredential,
      })
    ).actor;
    const job = await f.dependencies.unitOfWork.run((c) =>
      f.dependencies.repositories(c).getJobByResource(target.resourceId),
    );
    const key = randomUUID();
    const requested = await f.services.refresh.execute(job!.id, key, actor);
    expect(requested.id).toBe(task.snapshot().id);
    await f.services.execution.execute(task);
    const result = await f.services.task.execute(task.snapshot().id, actor);
    expect(result.status).toBe('succeeded');
    expect(result.successorTaskId).toBeTruthy();
    expect(
      (await f.services.task.execute(result.successorTaskId!, actor)).status,
    ).toBe('queued');
    expect((await f.services.refresh.execute(job!.id, key, actor)).id).toBe(
      task.snapshot().id,
    );
  });
  it('完整核验可保存，公告变化撤销有效性且旧操作键不可刷新结论', async () => {
    let revision = 'A';
    const source = fakeSource();
    source.evidence = async (kind, _id) =>
      parseEvidenceHtml(
        kind === 'job'
          ? jobHtml('campus')
              .replace('学历不限，经验未写明。', '学历本科，经验不限。')
              .replace(
                '</main>',
                '<a href="/announcements/review_fixture">关联公告</a></main>',
              )
          : `<main><h1>测试公告${revision}</h1><p>学历本科，经验不限。</p><a href="/jobs/campus_fixture">岗位</a></main>`,
        new Date(),
      );
    const f = await fixture(source);
    for (let i = 0; i < 6; i++) await f.services.execution.runOne();
    const context = await f.dependencies.unitOfWork.run(async (c) => {
      const repo = f.dependencies.repositories(c);
      const resources = await repo.listResources();
      const jobResource = resources.find(
        (r) =>
          r.snapshot().kind === 'job' &&
          r.snapshot().sourceId === 'campus_fixture',
      )!;
      const job = await repo.getJobByResource(jobResource.snapshot().id);
      const linked = resources.find(
        (r) => r.snapshot().kind === 'announcement',
      )!;
      const refs = [];
      for (const resource of [jobResource, linked]) {
        const version = await repo.getVersion(
          resource.snapshot().currentVersionId!,
        );
        const observation = await repo.latestObservation(
          resource.snapshot().id,
        );
        const excerpt = version!.snapshot().body.blocks[0]!;
        refs.push({
          resourceId: resource.snapshot().id,
          versionId: version!.snapshot().id,
          observationId: observation!.id,
          block: 0,
          start: 0,
          end: excerpt.length,
          excerpt,
        });
      }
      return {
        job: job!,
        jobResource: jobResource.snapshot(),
        linked: linked.snapshot(),
        refs,
      };
    });
    const input = {
      jobId: context.job.id,
      expectedJobVersion: context.jobResource.currentVersionId!,
      expectedReviewVersion: 0,
      evidenceVersions: context.refs.map((r) => ({
        resourceId: r.resourceId,
        versionId: r.versionId,
      })),
      tree: {
        type: 'condition' as const,
        condition: {
          field: 'degree' as const,
          operator: 'in' as const,
          value: ['bachelor'],
        },
        evidence: context.refs,
      },
      isComplete: true,
      gaps: [],
      conflicts: [],
      reason: '已审阅全部测试材料',
      operationKey: randomUUID(),
    };
    const saved = await f.services.review.execute(input);
    expect(saved.isComplete).toBe(true);
    revision = 'B';
    await f.dependencies.unitOfWork.run(async (c) => {
      const repo = f.dependencies.repositories(c);
      await repo.insertTaskIfAbsent(
        newSourceTask(
          randomUUID(),
          randomUUID(),
          `fetch:${context.linked.id}`,
          { kind: 'fetch', resourceId: context.linked.id },
          await repo.now(),
          0,
        ),
      );
    });
    await f.services.execution.runOne();
    expect(
      await f.dependencies.unitOfWork.run(
        async (c) =>
          (await f.dependencies
            .repositories(c)
            .getResource(context.jobResource.id))!.snapshot().currentReviewId,
      ),
    ).toBe(null);
    await expect(f.services.review.execute(input)).rejects.toMatchObject({
      code: 'EVIDENCE_VERSION_CONFLICT',
    });
  });
});
