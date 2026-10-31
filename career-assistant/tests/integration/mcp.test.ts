import { Client as DatabaseClient } from 'pg';
import { it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  createPersistence,
  createAuthSecurity,
  signRunGrant,
} from '@career/business';
import { randomUUID } from 'node:crypto';
import { makeChatFixture } from '../fixtures/chat.js';
import { isolatedDatabaseUrl } from '../fixtures/database.js';
import { makeIngestionFixture, fakeSource } from '../fixtures/ingestion.js';
import { emptyProfileContent } from '@career/contracts';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function fixture() {
  const f = await makeChatFixture();
  cleanups.push(f.close);
  const security = await createAuthSecurity({
      tokenPepper: f.authConfig.AUTH_TOKEN_PEPPER,
      csrfSecret: f.authConfig.AUTH_CSRF_SECRET,
    }),
    persistence = createPersistence(isolatedDatabaseUrl());
  cleanups.push(persistence.close);
  const conv = (await (await f.request('/conversations', 'POST', {})).json())
    .payload;
  const run = (
    await (
      await f.request(`/conversations/${conv.id}/messages`, 'POST', {
        clientMessageId: randomUUID(),
        text: '求职方向',
      })
    ).json()
  ).payload;
  const started = await persistence.unitOfWork.run(async (c) => {
    await persistence.ingestion(c).accounts.getForUpdate(f.user.id);
    const entity = await persistence.chat(c).getRun(run.id, true);
    const active = entity!.start(new Date());
    await persistence.chat(c).saveRun(active, entity!.snapshot().version);
    return active;
  });
  const grant = signRunGrant({ tokens: security.tokens }, started),
    client = new Client({ name: 'test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', f.base), {
      requestInit: {
        headers: { Authorization: `Bearer ${f.token}`, 'x-run-grant': grant },
      },
    }),
  );
  cleanups.push(() => client.close());
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    return {
      response,
      payload: JSON.parse(
        (response.content as { type: string; text: string }[])[0]!.text,
      ) as Record<string, unknown>,
    };
  };
  return { ...f, webClient: f.client, persistence, grant, run, client, tool };
}
async function seed() {
  const source = await makeIngestionFixture(fakeSource());
  cleanups.push(source.close);
  await source.services.discover.execute({
    sourceKey: 'zhidianmijin',
    stream: 'new',
    runId: randomUUID(),
    pageLimit: 1,
  });
  for (let i = 0; i < 3; i++) await source.services.execution.runOne();
}
it('MCP-01 get_profile仅读取本人正式画像且拒绝身份参数', async () => {
  const f = await fixture();
  const result = await f.tool('get_profile');
  expect(result.payload.version).toBe(0);
  expect(result.response.isError).not.toBe(true);
  await expect(
    f.tool('get_profile', { userId: randomUUID() }),
  ).rejects.toThrow();
});
it('MCP-02 search_jobs返回真实候选且不保证资格', async () => {
  await seed();
  const f = await fixture();
  const result = await f.tool('search_jobs', { limit: 1 });
  expect(result.response.isError).not.toBe(true);
  expect(result.payload.entries).toHaveLength(1);
});
it('MCP-03 get_job_evidence返回实际正文观察版本', async () => {
  await seed();
  const f = await fixture(),
    jobs = (await (await f.request('/jobs?limit=1')).json()).payload;
  const result = await f.tool('get_job_evidence', {
    jobId: jobs.entries[0].id,
  });
  expect(result.response.isError).not.toBe(true);
  expect((result.payload.entries as unknown[]).length).toBeGreaterThan(0);
});
it('MCP-04 evaluate_eligibility保持后端待核验结论', async () => {
  await seed();
  const f = await fixture(),
    jobs = (await (await f.request('/jobs?limit=1')).json()).payload,
    job = (await (await f.request('/jobs/' + jobs.entries[0].id)).json())
      .payload;
  const result = await f.tool('evaluate_eligibility', {
    jobId: job.id,
    expectedJobVersion: job.jobVersionId,
    expectedProfileVersion: 0,
    expectedReviewVersion: job.reviewVersion,
    expectedEvidenceDependencyHash: job.evidenceDependencyHash,
    operationKey: randomUUID(),
  });
  expect(result.response.isError).not.toBe(true);
  expect(result.payload.status).toBe('pending');
});
it('MCP-05 request_job_refresh只登记异步任务', async () => {
  await seed();
  const f = await fixture(),
    jobs = (await (await f.request('/jobs?limit=1')).json()).payload;
  const db = new DatabaseClient({ connectionString: isolatedDatabaseUrl() });
  await db.connect();
  try {
    await db.query(
      "UPDATE task_outbox SET requested_at=NOW()-INTERVAL '1 hour' WHERE resource_reference=(SELECT resource_id::text FROM jobs WHERE id=$1::uuid)",
      [jobs.entries[0].id],
    );
  } finally {
    await db.end();
  }
  const result = await f.tool('request_job_refresh', {
    jobId: jobs.entries[0].id,
    operationKey: randomUUID(),
  });
  expect(result.response.isError, JSON.stringify(result.payload)).not.toBe(
    true,
  );
  expect(result.payload.id).toBeTruthy();
});
it('MCP-06 get_task_status拒绝未授权任务', async () => {
  const f = await fixture();
  const result = await f.tool('get_task_status', { taskId: randomUUID() });
  expect(result.response.isError).toBe(true);
  expect(result.payload.error).toBeTruthy();
});
it('MCP-07 read_resume拒绝跨资源和未就绪资料', async () => {
  const f = await fixture();
  const result = await f.tool('read_resume', {
    resumeId: randomUUID(),
    expectedVersion: 1,
  });
  expect(result.response.isError).toBe(true);
});
it('MCP-08 propose_profile_update仅产生待确认草稿且幂等', async () => {
  const f = await fixture(),
    input = {
      content: emptyProfileContent(),
      baseProfileVersion: 0,
      operationKey: randomUUID(),
    };
  const a = await f.tool('propose_profile_update', input),
    b = await f.tool('propose_profile_update', input);
  expect(a.response.isError).not.toBe(true);
  expect(a.payload.status).toBe('draft');
  expect(b.payload.id).toBe(a.payload.id);
  expect((await (await f.request('/profile')).json()).payload.version).toBe(0);
});
it('MCP运行授权绑定删除屏障及持久化调用上限', async () => {
  const f = await fixture();
  for (let i = 0; i < 8; i++)
    expect((await f.tool('get_profile')).response.isError).not.toBe(true);
  const ninth = await f.tool('get_profile');
  expect(ninth.response.isError).toBe(true);
  expect(ninth.payload.error).toMatchObject({ code: 'TOOL_BUDGET_EXHAUSTED' });
  await f.request(`/runs/${f.run.id}/cancel`, 'POST', {});
  await expect(f.tool('get_profile')).rejects.toThrow();
});
it('内部事件序号幂等与伪造引用拒绝及终结后防写', async () => {
  const f = await fixture();
  const append = (sequence: number, payload: unknown) =>
    fetch(f.base + `/internal/v1/runs/${f.run.id}/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${f.token}`,
        'x-run-grant': f.grant,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sequence, payload }),
    });
  expect((await append(1, { type: 'text_delta', text: '开始' })).status).toBe(
    200,
  );
  expect((await append(1, { type: 'text_delta', text: '开始' })).status).toBe(
    200,
  );
  expect((await append(1, { type: 'text_delta', text: '篡改' })).status).toBe(
    409,
  );
  expect((await append(3, { type: 'text_delta', text: '跳序' })).status).toBe(
    409,
  );
  expect(
    (
      await append(2, {
        type: 'citation',
        citation: {
          resourceId: randomUUID(),
          versionId: randomUUID(),
          observationId: randomUUID(),
          sourceUrl: 'https://example.com/forged',
        },
      })
    ).status,
  ).toBe(422);
  expect(
    (await append(2, { type: 'completed', text: '完成', citations: [] }))
      .status,
  ).toBe(200);
  expect((await append(3, { type: 'text_delta', text: '迟到' })).status).toBe(
    403,
  );
});

it('删除资料后原运行授权及跨用户访问立即失效', async () => {
  const f = await fixture();
  const response = await fetch(f.base + '/api/v1/profile', {
    method: 'DELETE',
    headers: {
      cookie: f.webClient.cookieHeader(),
      origin: 'http://127.0.0.1:5173',
      'x-csrf-token': f.user.csrfToken,
      'idempotency-key': randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ confirmation: 'CLEAR_PROFILE' }),
  });
  expect(response.status).toBe(202);
  await expect(f.tool('get_profile')).rejects.toThrow();
  const other = await makeChatFixture();
  cleanups.push(other.close);
  expect((await other.request(`/runs/${f.run.id}`)).status).toBe(404);
});
it('超过单批事件上限的终结运行仍完整回放', async () => {
  const f = await fixture();
  const { Client: DatabaseClient } = await import('pg');
  const db = new DatabaseClient({ connectionString: isolatedDatabaseUrl() });
  await db.connect();
  try {
    await db.query(
      "INSERT INTO run_events(run_id,sequence,payload,hash,created_at) SELECT $1::uuid,n,jsonb_build_object('type','text_delta','text','片段'),repeat('a',64),NOW() FROM generate_series(1,1001) n",
      [f.run.id],
    );
    await db.query(
      'INSERT INTO run_events(run_id,sequence,payload,hash,created_at) VALUES($1::uuid,1002,\'{"type":"completed","text":"完成","citations":[]}\',repeat(\'b\',64),NOW())',
      [f.run.id],
    );
    await db.query(
      "UPDATE agent_runs SET status='completed',last_sequence=1002 WHERE id=$1",
      [f.run.id],
    );
  } finally {
    await db.end();
  }
  const response = await f.request(`/runs/${f.run.id}/events`),
    events = await response.text();
  expect(events).toContain(`id: ${f.run.id}:1002\n`);
  expect(events).toContain('event: completed');
  expect((events.match(/^data:/gm) ?? []).length).toBe(1002);
});
