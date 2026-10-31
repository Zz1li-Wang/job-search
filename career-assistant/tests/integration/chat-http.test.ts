import { it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  RunSchema,
  ConversationSchema,
  MessageSchema,
} from '@career/contracts';
import { makeChatFixture } from '../fixtures/chat.js';
import { isolatedDatabaseUrl } from '../fixtures/database.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function fixture() {
  const f = await makeChatFixture();
  cleanups.push(f.close);
  return f;
}
async function create(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.request('/conversations', 'POST', {});
  expect(response.status).toBe(201);
  return ConversationSchema.parse((await response.json()).payload);
}
async function send(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const response = await f.request(`/conversations/${id}/messages`, 'POST', {
    clientMessageId: randomUUID(),
    text: '帮我规划求职方向',
  });
  expect(response.status).toBe(202);
  return RunSchema.parse((await response.json()).payload);
}
async function waitRun(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  for (let i = 0; i < 100; i++) {
    const run = RunSchema.parse(
      (await (await f.request(`/runs/${id}`)).json()).payload,
    );
    if (!['queued', 'running'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error('运行未完成');
}
it('CHAT-01 创建会话与身份输入拒绝', async () => {
  const f = await fixture();
  await create(f);
  expect(
    (await f.request('/conversations', 'POST', { userId: randomUUID() }))
      .status,
  ).toBe(400);
  expect(
    (await fetch(f.base + '/api/v1/conversations', { method: 'POST' })).status,
  ).toBe(403);
});
it('CHAT-02 会话列表只返回本人', async () => {
  const f = await fixture();
  const c = await create(f);
  expect(
    (await (await f.request('/conversations')).json()).payload.some(
      (entry: { id: string }) => entry.id === c.id,
    ),
  ).toBe(true);
});
it('CHAT-03 删除会话撤销运行且重复成功', async () => {
  const f = await fixture(),
    c = await create(f),
    r = await send(f, c.id);
  expect((await f.request(`/conversations/${c.id}`, 'DELETE')).status).toBe(
    204,
  );
  expect((await f.request(`/runs/${r.id}`)).status).toBe(404);
  expect((await f.request(`/conversations/${c.id}`, 'DELETE')).status).toBe(
    204,
  );
});
it('CHAT-04 消息列表与不存在会话', async () => {
  const f = await fixture(),
    c = await create(f);
  await send(f, c.id);
  const response = await f.request(`/conversations/${c.id}/messages`);
  expect(
    MessageSchema.array().parse((await response.json()).payload)[0]?.role,
  ).toBe('user');
  expect(
    (await f.request(`/conversations/${randomUUID()}/messages`)).status,
  ).toBe(404);
});
it('CHAT-05 幂等消息与并发串行', async () => {
  const f = await fixture(),
    c = await create(f),
    input = { clientMessageId: randomUUID(), text: '方向建议' };
  const responses = await Promise.all([
    f.request(`/conversations/${c.id}/messages`, 'POST', input),
    f.request(`/conversations/${c.id}/messages`, 'POST', input),
  ]);
  expect(responses.map((r) => r.status)).toEqual([202, 202]);
  const ids = await Promise.all(
    responses.map(async (r) => (await r.json()).payload.id),
  );
  expect(ids[0]).toBe(ids[1]);
  expect(
    (
      await f.request(`/conversations/${c.id}/messages`, 'POST', {
        ...input,
        text: '修改',
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.request(`/conversations/${c.id}/messages`, 'POST', {
        ...input,
        clientMessageId: randomUUID(),
      })
    ).status,
  ).toBe(409);
});
it('CHAT-06 运行状态与真实Agent及MCP闭环', async () => {
  const f = await fixture(),
    c = await create(f),
    r = await send(f, c.id);
  await f.runtime.chatServices.dispatcher.tick();
  const result = await waitRun(f, r.id);
  expect(result.status).toBe('completed');
  expect(f.model.calls()).toBe(2);
  const messages = MessageSchema.array().parse(
    (await (await f.request(`/conversations/${c.id}/messages`)).json()).payload,
  );
  expect(messages.at(-1)?.text).toContain('求职方向');
});
it('CHAT-07 SSE回放只读取已提交事件', async () => {
  const f = await fixture(),
    c = await create(f),
    r = await send(f, c.id);
  await f.runtime.chatServices.dispatcher.tick();
  await waitRun(f, r.id);
  const response = await f.request(`/runs/${r.id}/events?after=1`);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const events = await response.text();
  expect(events).toContain('event: completed');
  expect(events).not.toContain(`id: ${r.id}:1\n`);
  const before = f.model.calls();
  await (await f.request(`/runs/${r.id}/events`)).text();
  expect(f.model.calls()).toBe(before);
});
it('CHAT-08 取消排队运行阻止推理', async () => {
  const f = await fixture(),
    c = await create(f),
    r = await send(f, c.id);
  expect((await f.request(`/runs/${r.id}/cancel`, 'POST', {})).status).toBe(
    200,
  );
  await f.runtime.chatServices.dispatcher.tick();
  expect(f.model.calls()).toBe(0);
  expect((await f.request(`/runs/${r.id}/cancel`, 'POST', {})).status).toBe(
    200,
  );
});
it('CHAT-09 显式重试使用版本且不自动计费', async () => {
  const f = await fixture(),
    c = await create(f),
    r = await send(f, c.id);
  expect(
    (await f.request(`/runs/${r.id}/retry`, 'POST', { expectedRunVersion: 1 }))
      .status,
  ).toBe(409);
  const db = new Client({ connectionString: isolatedDatabaseUrl() });
  await db.connect();
  try {
    await db.query("UPDATE agent_runs SET status='interrupted' WHERE id=$1", [
      r.id,
    ]);
    await db.query('UPDATE conversations SET active_run_id=NULL WHERE id=$1', [
      c.id,
    ]);
  } finally {
    await db.end();
  }
  const retry = await f.request(`/runs/${r.id}/retry`, 'POST', {
    expectedRunVersion: 1,
  });
  expect(retry.status).toBe(202);
  expect((await retry.json()).payload.attempt).toBe(2);
  expect(f.model.calls()).toBe(0);
});
it('INT-EVENT 事件回调要求双重服务与运行授权', async () => {
  const f = await fixture();
  const response = await fetch(
    f.base + `/internal/v1/runs/${randomUUID()}/events`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  expect(response.status).toBe(403);
});
it('MCP-POST 工具入口拒绝伪造授权', async () => {
  const f = await fixture();
  const response = await fetch(f.base + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${f.token}`,
      'x-run-grant': 'forged',
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  expect(response.status).toBe(403);
});
it('MCP-GET 无状态传输读取仍需授权', async () => {
  const f = await fixture();
  expect((await fetch(f.base + '/mcp')).status).toBe(403);
});
it('MCP-DELETE 无状态传输删除仍需授权', async () => {
  const f = await fixture();
  expect((await fetch(f.base + '/mcp', { method: 'DELETE' })).status).toBe(403);
});
it('AGENT-POST 派发拒绝无凭据请求', async () => {
  const f = await fixture();
  expect(
    (
      await fetch(f.agentBase + '/internal/v1/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(403);
});
it('AGENT-GET 进程未知状态与授权', async () => {
  const f = await fixture();
  const id = randomUUID();
  expect((await fetch(f.agentBase + `/internal/v1/runs/${id}`)).status).toBe(
    403,
  );
  const response = await fetch(f.agentBase + `/internal/v1/runs/${id}`, {
    headers: { Authorization: `Bearer ${f.token}` },
  });
  expect((await response.json()).status).toBe('unknown');
});
it('AGENT-CANCEL 取消未知运行幂等', async () => {
  const f = await fixture();
  const response = await fetch(
    f.agentBase + `/internal/v1/runs/${randomUUID()}/cancel`,
    { method: 'POST', headers: { Authorization: `Bearer ${f.token}` } },
  );
  expect(response.status).toBe(200);
  expect((await response.json()).status).toBe('unknown');
});

it('模型断流明确失败且不保存固定答案', async () => {
  const f = await fixture();
  f.model.setMode('broken');
  const c = await create(f),
    r = await send(f, c.id);
  await f.runtime.chatServices.dispatcher.tick();
  const answer = await waitRun(f, r.id);
  expect(answer.status).toBe('failed');
  expect(answer.errorCode).toBe('MODEL_INTERRUPTED');
  const messages = MessageSchema.array().parse(
    (await (await f.request(`/conversations/${c.id}/messages`)).json()).payload,
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]?.role).toBe('user');
});
it('模型或资料指令不能扩展业务工具白名单', async () => {
  const f = await fixture();
  f.model.setMode('unknown_tool');
  const c = await create(f),
    r = await send(f, c.id);
  await f.runtime.chatServices.dispatcher.tick();
  const answer = await waitRun(f, r.id);
  expect(answer.status).toBe('failed');
  expect(answer.errorCode).toBe('TOOL_UNAUTHORIZED');
  expect((await (await f.request('/profile')).json()).payload.version).toBe(0);
});
it('重试原失败运行的重复请求复用首次子运行', async () => {
  const f = await fixture();
  f.model.setMode('broken');
  const c = await create(f),
    r = await send(f, c.id);
  await f.runtime.chatServices.dispatcher.tick();
  const failed = await waitRun(f, r.id);
  const body = { expectedRunVersion: failed.version };
  const a = await f.request(`/runs/${r.id}/retry`, 'POST', body),
    b = await f.request(`/runs/${r.id}/retry`, 'POST', body);
  expect(a.status).toBe(202);
  expect(b.status).toBe(202);
  expect((await a.json()).payload.id).toBe((await b.json()).payload.id);
  expect(f.model.calls()).toBe(1);
});

it.each(['tool_budget', 'tool_batch_budget'] as const)(
  '工具25次及同批超额收尾：%s',
  async (mode) => {
    const f = await fixture();
    f.model.setMode(mode);
    const c = await create(f),
      r = await send(f, c.id);
    await f.runtime.chatServices.dispatcher.tick();
    const result = await waitRun(f, r.id);
    expect(result.status).toBe('completed');
    expect(result.errorCode).toBeNull();
    const db = new Client({ connectionString: isolatedDatabaseUrl() });
    await db.connect();
    try {
      const stored = await db.query(
        'SELECT tool_calls FROM agent_runs WHERE id=$1',
        [r.id],
      );
      expect(stored.rows[0].tool_calls).toBe(25);
    } finally {
      await db.end();
    }
    const messages = MessageSchema.array().parse(
      (await (await f.request(`/conversations/${c.id}/messages`)).json())
        .payload,
    );
    expect(messages.at(-1)?.text).toContain('未查询的条件仍待核验');
  },
);

it('模型无视关闭工具时明确失败且不执行第26次', async () => {
  const f = await fixture();
  f.model.setMode('ignore_tool_limit');
  const c = await create(f),
    r = await send(f, c.id);
  await f.runtime.chatServices.dispatcher.tick();
  const result = await waitRun(f, r.id);
  expect(result.status).toBe('failed');
  expect(result.errorCode).toBe('TOOL_BUDGET_EXHAUSTED');
  const db = new Client({ connectionString: isolatedDatabaseUrl() });
  await db.connect();
  try {
    const stored = await db.query(
      'SELECT tool_calls FROM agent_runs WHERE id=$1',
      [r.id],
    );
    expect(stored.rows[0].tool_calls).toBe(25);
  } finally {
    await db.end();
  }
  const events = await (await f.request(`/runs/${r.id}/events`)).text();
  expect(events).toContain('"isRetryable":false');
});
