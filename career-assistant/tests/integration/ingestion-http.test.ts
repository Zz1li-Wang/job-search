import { describe, it, expect, afterEach } from 'vitest';
import { Client } from 'pg';
import { isolatedDatabaseUrl } from '../fixtures/auth.js';
import { randomUUID } from 'node:crypto';
import { TaskSchema, TrustSchema } from '@career/contracts';
import { makeAuthHttpFixture, TEST_ORIGIN } from '../fixtures/auth.js';
import { makeIngestionFixture } from '../fixtures/ingestion.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function fixture() {
  const ingest = await makeIngestionFixture();
  cleanups.push(ingest.close);
  await ingest.services.discover.execute({
    sourceKey: 'zhidianmijin',
    stream: 'new',
    runId: randomUUID(),
    pageLimit: 1,
  });
  // runOne允许暂时没有可领取任务；等待固定的发现和两条详情完成，避免把轮询次数当完成条件。
  await expect
    .poll(
      async () => {
        await ingest.services.execution.runOne();
        return ingest.dependencies.unitOfWork.run(async (context) => {
          const tasks = await ingest.dependencies
            .repositories(context)
            .listTasks();
          return tasks.filter((task) => task.snapshot().status === 'succeeded')
            .length;
        });
      },
      { timeout: 5000, interval: 20 },
    )
    .toBe(3);
  const seededTasks = await ingest.dependencies.unitOfWork.run((context) =>
    ingest.dependencies.repositories(context).listTasks(),
  );
  expect(
    seededTasks.map((task) => ({
      status: task.snapshot().status,
      attempt: task.snapshot().attempt,
    })),
  ).toEqual(
    Array.from({ length: 3 }, () => ({ status: 'succeeded', attempt: 1 })),
  );
  const clientDb = new Client({ connectionString: isolatedDatabaseUrl() });
  await clientDb.connect();
  try {
    await clientDb.query(
      "UPDATE task_outbox SET requested_at=NOW()-interval '61 seconds' WHERE source_key='zhidianmijin' AND status='succeeded'",
    );
  } finally {
    await clientDb.end();
  }
  const api = await makeAuthHttpFixture();
  cleanups.push(api.close);
  const client = api.client();
  const user = await client.signedIn();
  const job = await ingest.dependencies.unitOfWork.run(async (c) => {
    const repo = ingest.dependencies.repositories(c);
    const resource = (await repo.listResources()).find(
      (r) => r.snapshot().kind === 'job',
    )!;
    return repo.getJobByResource(resource.snapshot().id);
  });
  return { api, ingest, client, user, job: job! };
}
describe('采集HTTP逐接口契约', () => {
  it('JOB-04 刷新认证CSRF幂等合并与非法URL拒绝', async () => {
    const f = await fixture();
    const url = `${f.api.base}/api/v1/jobs/${f.job.id}/refresh`;
    const key = randomUUID();
    const headers = {
      cookie: f.client.cookieHeader(),
      origin: TEST_ORIGIN,
      'x-csrf-token': f.user.csrfToken,
      'idempotency-key': key,
      'content-type': 'application/json',
    };
    const request = () => fetch(url, { method: 'POST', headers, body: '{}' });
    const first = await request();
    expect(first.status).toBe(202);
    const result = (await first.json()) as { payload: unknown };
    const task = TaskSchema.parse(result.payload);
    const repeated = await request();
    expect(repeated.status).toBe(202);
    expect(await repeated.json()).toMatchObject({ payload: { id: task.id } });
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: { ...headers, 'x-csrf-token': 'wrong' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ url: 'http://127.0.0.1' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
  });
  it('TASK-01 只允许本人关联任务并拒绝额外身份字段', async () => {
    const f = await fixture();
    const response = await fetch(
      `${f.api.base}/api/v1/jobs/${f.job.id}/refresh`,
      {
        method: 'POST',
        headers: {
          cookie: f.client.cookieHeader(),
          origin: TEST_ORIGIN,
          'x-csrf-token': f.user.csrfToken,
          'idempotency-key': randomUUID(),
          'content-type': 'application/json',
        },
        body: '{}',
      },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { payload: { id: string } };
    const url = `${f.api.base}/api/v1/tasks/${body.payload.id}`;
    const me = await fetch(url, {
      headers: { cookie: f.client.cookieHeader() },
    });
    expect(me.status).toBe(200);
    const output = await me.text();
    expect(output).not.toMatch(/leaseUntil|fencingToken|userId|owner/);
    expect((await fetch(url)).status).toBe(401);
    const other = f.api.client();
    await other.signedIn();
    expect(
      (await fetch(url, { headers: { cookie: other.cookieHeader() } })).status,
    ).toBe(404);
    expect(
      (
        await fetch(url + '?userId=' + f.user.id, {
          headers: { cookie: f.client.cookieHeader() },
        })
      ).status,
    ).toBe(400);
  });
  it('PUBLIC-01 覆盖统计区分获取核验新鲜且不含个人信息', async () => {
    const f = await fixture();
    const response = await fetch(`${f.api.base}/api/v1/trust`);
    expect(response.status).toBe(200);
    const result = (await response.json()) as { payload: unknown };
    const report = TrustSchema.parse(result.payload);
    expect(report.counts.fetched).toBe(2);
    expect(report.counts.reviewed).toBe(0);
    expect(report.counts.fresh).toBe(0);
    expect(JSON.stringify(report)).not.toContain(f.user.id);
    expect(
      (await fetch(`${f.api.base}/api/v1/trust?userId=${f.user.id}`)).status,
    ).toBe(400);
  });
});
