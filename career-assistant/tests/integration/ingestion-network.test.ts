import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSourceReader, type SourceTransport } from '@career/business';
import { makeIngestionFixture, jobHtml } from '../fixtures/ingestion.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function fixture() {
  const f = await makeIngestionFixture();
  cleanups.push(f.close);
  return f;
}
describe('来源网络许可与凭据隔离', () => {
  it('Cookie只用于列表，robots详情及跳转均不携带', async () => {
    const f = await fixture();
    const seen: {
      path: string;
      cookie: string | undefined;
      startedAt: number;
    }[] = [];
    const transport: SourceTransport = {
      async get(url, cookie) {
        seen.push({ path: url.pathname, cookie, startedAt: Date.now() });
        if (url.pathname === '/robots.txt')
          return { status: 200, body: 'User-agent: *\nAllow: /\n' };
        if (url.pathname === '/jobs')
          return {
            status: 200,
            body: '<main><h1>找岗位</h1><a href="/jobs/example">岗位</a></main>',
          };
        return { status: 200, body: jobHtml() };
      },
    };
    const reader = createSourceReader(
      f.dependencies,
      {
        enabled: true,
        budgetId: randomUUID(),
        requestLimit: 4,
        cookie: 'fixture-secret-cookie',
      },
      transport,
    );
    await reader.list(1);
    await reader.evidence('job', 'example');
    expect(seen.map((s) => s.cookie)).toEqual([
      undefined,
      'fixture-secret-cookie',
      undefined,
    ]);
    for (let i = 1; i < seen.length; i++)
      expect(
        seen[i]!.startedAt - seen[i - 1]!.startedAt,
      ).toBeGreaterThanOrEqual(1000);
  });
  it('跨域重定向被拒绝，预算用尽后不会发送下一请求', async () => {
    const f = await fixture();
    let requests = 0;
    const transport: SourceTransport = {
      async get(url) {
        requests++;
        if (url.pathname === '/robots.txt') return { status: 404, body: '' };
        return { status: 302, location: 'https://127.0.0.1/private', body: '' };
      },
    };
    const reader = createSourceReader(
      f.dependencies,
      { enabled: true, budgetId: randomUUID(), requestLimit: 2 },
      transport,
    );
    await expect(reader.list(1)).rejects.toMatchObject({
      code: 'SOURCE_ACCESS_BLOCKED',
    });
    expect(requests).toBe(2);
    await expect(reader.list(2)).rejects.toMatchObject({
      code: 'SOURCE_BUDGET_EXHAUSTED',
    });
    expect(requests).toBe(2);
  });
  it('robots禁止和网络关闭均不读取岗位', async () => {
    const f = await fixture();
    let requests = 0;
    const transport: SourceTransport = {
      async get() {
        requests++;
        return { status: 200, body: 'User-agent: *\nDisallow: /jobs\n' };
      },
    };
    const reader = createSourceReader(
      f.dependencies,
      { enabled: true, budgetId: randomUUID(), requestLimit: 2 },
      transport,
    );
    await expect(reader.list(1)).rejects.toMatchObject({
      code: 'SOURCE_ACCESS_BLOCKED',
    });
    expect(requests).toBe(1);
    const disabled = createSourceReader(
      f.dependencies,
      { enabled: false, budgetId: randomUUID(), requestLimit: 2 },
      transport,
    );
    await expect(disabled.evidence('job', 'example')).rejects.toMatchObject({
      code: 'SOURCE_ACCESS_BLOCKED',
    });
    expect(requests).toBe(1);
  });
});
