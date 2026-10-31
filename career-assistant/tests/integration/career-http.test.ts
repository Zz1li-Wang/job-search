import { it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { JobPageSchema, ApplicationSchema } from '@career/contracts';
import { makeJobsFixture } from '../fixtures/jobs.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function fixture() {
  const f = await makeJobsFixture();
  cleanups.push(f.close);
  const jobs = JobPageSchema.parse(
    (await (await f.request('/jobs')).json()).payload,
  );
  return { ...f, jobId: jobs.entries[0]!.id };
}
async function create(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.request(
    '/applications',
    'POST',
    { jobId: f.jobId },
    randomUUID(),
  );
  expect(response.status).toBe(201);
  return ApplicationSchema.parse((await response.json()).payload);
}
it('FAV-01 收藏列表仅本人且初始为空', async () => {
  const f = await fixture();
  const response = await f.request('/favorites');
  expect(response.status).toBe(200);
  expect((await response.json()).payload).toEqual([]);
});
it('FAV-02 并发收藏只保留一条', async () => {
  const f = await fixture();
  const responses = await Promise.all([
    f.request(`/favorites/${f.jobId}`, 'PUT', {}),
    f.request(`/favorites/${f.jobId}`, 'PUT', {}),
  ]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  expect((await (await f.request('/favorites')).json()).payload).toHaveLength(
    1,
  );
  expect(
    (await f.request(`/favorites/${randomUUID()}`, 'PUT', {})).status,
  ).toBe(404);
});
it('FAV-03 重复取消收藏均成功', async () => {
  const f = await fixture();
  for (let i = 0; i < 2; i++)
    expect((await f.request(`/favorites/${f.jobId}`, 'DELETE')).status).toBe(
      204,
    );
});
it('APP-01 本人记录筛选及非法状态', async () => {
  const f = await fixture();
  await create(f);
  expect(
    (await (await f.request('/applications?status=preparing')).json()).payload,
  ).toHaveLength(1);
  expect((await f.request('/applications?status=invalid')).status).toBe(400);
});
it('APP-02 重复创建不重置状态与幂等内容冲突', async () => {
  const f = await fixture(),
    a = await create(f),
    again = await create(f);
  expect(again.id).toBe(a.id);
  expect(again.status).toBe('preparing');
});
it('APP-03 私有记录读取与不存在', async () => {
  const f = await fixture(),
    a = await create(f);
  expect((await f.request(`/applications/${a.id}`)).status).toBe(200);
  expect((await f.request(`/applications/${randomUUID()}`)).status).toBe(404);
});
it('APP-04 版本并发冲突与未来日期拒绝', async () => {
  const f = await fixture(),
    a = await create(f),
    input = {
      expectedVersion: 1,
      status: 'submitted',
      actionDate: null,
      note: '已手动报名',
    };
  const responses = await Promise.all([
    f.request(`/applications/${a.id}`, 'PATCH', input, randomUUID()),
    f.request(
      `/applications/${a.id}`,
      'PATCH',
      { ...input, status: 'interview' },
      randomUUID(),
    ),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(
    (
      await f.request(
        `/applications/${a.id}`,
        'PATCH',
        { ...input, expectedVersion: 2, actionDate: '2099-01-01' },
        randomUUID(),
      )
    ).status,
  ).toBe(422);
});
it('APP-05 状态修正与历史同事务及重放不重复', async () => {
  const f = await fixture(),
    a = await create(f),
    input = {
      expectedVersion: 1,
      status: 'interview',
      actionDate: null,
      note: '电话确认',
    },
    key = randomUUID();
  for (let i = 0; i < 2; i++)
    expect(
      (await f.request(`/applications/${a.id}`, 'PATCH', input, key)).status,
    ).toBe(200);
  const response = await f.request(`/applications/${a.id}/history`);
  expect(response.status).toBe(200);
  expect(
    (await response.json()).payload.map((h: { status: string }) => h.status),
  ).toEqual(['preparing', 'interview']);
});
it('APP-06 删除连同历史且旧幂等键不恢复', async () => {
  const f = await fixture(),
    a = await create(f);
  for (let i = 0; i < 2; i++)
    expect((await f.request(`/applications/${a.id}`, 'DELETE')).status).toBe(
      204,
    );
  expect((await f.request(`/applications/${a.id}/history`)).status).toBe(404);
});

it('无变化的投递更新也保留首次幂等结果', async () => {
  const f = await fixture(),
    a = await create(f),
    key = randomUUID(),
    unchanged = {
      expectedVersion: 1,
      status: 'preparing',
      actionDate: null,
      note: '',
    };
  expect(
    (await f.request(`/applications/${a.id}`, 'PATCH', unchanged, key)).status,
  ).toBe(200);
  expect(
    (
      await f.request(
        `/applications/${a.id}`,
        'PATCH',
        { ...unchanged, status: 'submitted' },
        randomUUID(),
      )
    ).status,
  ).toBe(200);
  const repeated = await f.request(
    `/applications/${a.id}`,
    'PATCH',
    unchanged,
    key,
  );
  expect(repeated.status).toBe(200);
  expect((await repeated.json()).payload).toMatchObject({
    version: 1,
    status: 'preparing',
  });
});
