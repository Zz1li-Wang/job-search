import { it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ResumeSchema,
  DraftSchema,
  ProfileSchema,
  emptyProfileContent,
} from '@career/contracts';
import { makeChatFixture } from '../fixtures/chat.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function fixture() {
  const f = await makeChatFixture();
  cleanups.push(f.close);
  return f;
}
async function upload(
  f: Awaited<ReturnType<typeof fixture>>,
  text = 'TypeScript',
) {
  const response = await fetch(f.base + '/api/v1/resumes/text', {
    method: 'POST',
    headers: {
      cookie: f.client.cookieHeader(),
      origin: 'http://127.0.0.1:5173',
      'x-csrf-token': f.user.csrfToken,
      'idempotency-key': randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: '虚构简历', text }),
  });
  expect(response.status).toBe(201);
  return ResumeSchema.parse((await response.json()).payload);
}
async function draft(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await fetch(f.base + '/api/v1/profile/drafts', {
    method: 'POST',
    headers: {
      cookie: f.client.cookieHeader(),
      origin: 'http://127.0.0.1:5173',
      'x-csrf-token': f.user.csrfToken,
      'idempotency-key': randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: emptyProfileContent(),
      baseProfileVersion: 0,
    }),
  });
  expect(response.status).toBe(201);
  return DraftSchema.parse((await response.json()).payload);
}
it('RES-01 文件上传验证与格式拒绝', async () => {
  const f = await fixture();
  const form = new FormData();
  form.set('file', new Blob(['TypeScript']), 'resume.txt');
  const response = await fetch(f.base + '/api/v1/resumes', {
    method: 'POST',
    headers: {
      cookie: f.client.cookieHeader(),
      origin: 'http://127.0.0.1:5173',
      'x-csrf-token': f.user.csrfToken,
      'idempotency-key': randomUUID(),
    },
    body: form,
  });
  expect(response.status).toBe(201);
  expect(ResumeSchema.parse((await response.json()).payload).format).toBe(
    'txt',
  );
});
it('RES-02 粘贴文本不直接改变正式画像', async () => {
  const f = await fixture();
  await upload(f);
  expect(
    ProfileSchema.parse((await (await f.request('/profile')).json()).payload)
      .content,
  ).toBeNull();
  expect(
    (await f.request('/resumes/text', 'POST', { title: 'x', text: '' })).status,
  ).toBe(400);
});
it('RES-03 私有简历列表与存储路径隔离', async () => {
  const f = await fixture(),
    resume = await upload(f);
  const response = await f.request('/resumes'),
    body = await response.json();
  expect(
    ResumeSchema.array()
      .parse(body.payload)
      .map((r) => r.id),
  ).toContain(resume.id);
  expect(JSON.stringify(body)).not.toContain('fileKey');
});
it('RES-04 独立Agent读取MCP原文并生成待确认草稿', async () => {
  const f = await fixture(),
    resume = await upload(f);
  await f.runtime.resumeServices.worker.tick();
  const response = await f.request(`/resumes/${resume.id}`),
    parsed = ResumeSchema.parse((await response.json()).payload);
  expect(parsed.status).toBe('ready');
  const d = DraftSchema.parse(
    (await (await f.request(`/profile/drafts/${parsed.draftId}`)).json())
      .payload,
  );
  expect(d.content.skills).toEqual(['TypeScript']);
  expect(d.evidence[0]?.excerpt).toBe('TypeScript');
  expect(
    ProfileSchema.parse((await (await f.request('/profile')).json()).payload)
      .version,
  ).toBe(0);
});
it('RES-05 重复解析复用任务且不重复推理', async () => {
  const f = await fixture(),
    resume = await upload(f);
  const response = await f.request(`/resumes/${resume.id}/parse`, 'POST', {
    expectedResumeVersion: 1,
    retry: false,
  });
  expect(response.status).toBe(202);
  expect(ResumeSchema.parse((await response.json()).payload).taskId).toBe(
    resume.taskId,
  );
  expect(f.model.calls()).toBe(0);
  expect(
    (
      await f.request(`/resumes/${resume.id}/parse`, 'POST', {
        expectedResumeVersion: 2,
        retry: true,
        expectedTaskId: resume.taskId,
      })
    ).status,
  ).toBe(409);
});
it('RES-06 删除立即不可读并阻止排队任务恢复', async () => {
  const f = await fixture(),
    resume = await upload(f);
  expect((await f.request(`/resumes/${resume.id}`, 'DELETE')).status).toBe(202);
  expect((await f.request(`/resumes/${resume.id}`)).status).toBe(404);
  await f.runtime.resumeServices.worker.tick();
  expect(f.model.calls()).toBe(0);
  expect((await f.request(`/resumes/${resume.id}`, 'DELETE')).status).toBe(202);
});
it('RES-07 原文未就绪冲突并保留定位', async () => {
  const f = await fixture(),
    resume = await upload(f);
  expect((await f.request(`/resumes/${resume.id}/content`)).status).toBe(409);
  await f.runtime.resumeServices.worker.tick();
  const response = await f.request(`/resumes/${resume.id}/content`);
  expect(response.status).toBe(200);
  expect((await response.json()).payload.spans[0]).toEqual({
    locator: 'paragraph:1',
    text: 'TypeScript',
  });
  expect((await f.request(`/resumes/${randomUUID()}/content`)).status).toBe(
    404,
  );
});
it('PROFILE-02 手填草稿等待确认', async () => {
  const f = await fixture(),
    d = await draft(f);
  expect(d.status).toBe('draft');
  expect((await (await f.request('/profile')).json()).payload.version).toBe(0);
});
it('PROFILE-03 草稿编辑版本冲突', async () => {
  const f = await fixture(),
    d = await draft(f),
    input = {
      content: { ...d.content, skills: ['SQL'] },
      baseProfileVersion: 0,
      expectedDraftVersion: d.version,
    };
  expect(
    (await f.request(`/profile/drafts/${d.id}`, 'PATCH', input)).status,
  ).toBe(200);
  expect(
    (await f.request(`/profile/drafts/${d.id}`, 'PATCH', input)).status,
  ).toBe(409);
});
it('PROFILE-04 两草稿确认竞争及重复原结果', async () => {
  const f = await fixture(),
    a = await draft(f),
    b = await draft(f),
    input = { expectedDraftVersion: 1, expectedProfileVersion: 0 };
  const responses = await Promise.all([
    f.request(`/profile/drafts/${a.id}/confirm`, 'POST', input),
    f.request(`/profile/drafts/${b.id}/confirm`, 'POST', input),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  const winner = responses[0]!.status === 200 ? a : b;
  expect(
    (await f.request(`/profile/drafts/${winner.id}/confirm`, 'POST', input))
      .status,
  ).toBe(200);
  expect((await (await f.request('/profile')).json()).payload.version).toBe(1);
});
it('PROFILE-05 草稿读取归属与不存在', async () => {
  const f = await fixture(),
    d = await draft(f);
  expect((await f.request(`/profile/drafts/${d.id}`)).status).toBe(200);
  expect((await f.request(`/profile/drafts/${randomUUID()}`)).status).toBe(404);
});
it('INT-EXTRACT 提取接口拒绝无服务授权', async () => {
  const f = await fixture();
  expect(
    (
      await fetch(f.agentBase + '/internal/v1/resume-extractions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(403);
});

it('旧解析重试在新尝试失败后不能再次触发模型', async () => {
  const f = await fixture();
  f.model.setMode('broken');
  const resume = await upload(f);
  await f.runtime.resumeServices.worker.tick();
  const input = {
    expectedResumeVersion: resume.version,
    retry: true,
    expectedTaskId: resume.taskId,
  };
  expect(
    (await f.request(`/resumes/${resume.id}/parse`, 'POST', input)).status,
  ).toBe(202);
  await f.runtime.resumeServices.worker.tick();
  expect(
    (await f.request(`/resumes/${resume.id}/parse`, 'POST', input)).status,
  ).toBe(409);
  expect(f.model.calls()).toBe(2);
});

it('预存文件期间清空资料会拒绝迟到上传并清理孤立文件', async () => {
  let release = () => {},
    entered = () => {};
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    stored = new Map<string, Uint8Array>();
  const f = await makeChatFixture({
    files: {
      async put(key, content) {
        stored.set(key, content);
        entered();
        await gate;
      },
      async read(key) {
        return stored.get(key)!;
      },
      async delete(key) {
        stored.delete(key);
      },
    },
  });
  cleanups.push(f.close);
  const upload = fetch(f.base + '/api/v1/resumes/text', {
    method: 'POST',
    headers: {
      cookie: f.client.cookieHeader(),
      origin: 'http://127.0.0.1:5173',
      'x-csrf-token': f.user.csrfToken,
      'idempotency-key': randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: '迟到上传', text: 'TypeScript' }),
  });
  try {
    await started;
    const removed = await fetch(f.base + '/api/v1/me/data', {
      method: 'DELETE',
      headers: {
        cookie: f.client.cookieHeader(),
        origin: 'http://127.0.0.1:5173',
        'x-csrf-token': f.user.csrfToken,
        'idempotency-key': randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ confirmation: 'CLEAR_PERSONAL_DATA' }),
    });
    expect(removed.status).toBe(202);
    release();
    const response = await upload;
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('AUTH_CONTEXT_STALE');
    expect(stored.size).toBe(0);
    expect((await (await f.request('/resumes')).json()).payload).toEqual([]);
  } finally {
    release();
    await upload;
  }
});

it('五万字中文JSON正文可上传且同键改标题返回冲突', async () => {
  const f = await fixture(),
    key = randomUUID(),
    body = { title: '中文边界样本', text: '中'.repeat(50000) };
  const send = (title: string) =>
    fetch(f.base + '/api/v1/resumes/text', {
      method: 'POST',
      headers: {
        cookie: f.client.cookieHeader(),
        origin: 'http://127.0.0.1:5173',
        'x-csrf-token': f.user.csrfToken,
        'idempotency-key': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...body, title }),
    });
  expect((await send(body.title)).status).toBe(201);
  expect((await send('更改标题')).status).toBe(409);
  expect(f.model.calls()).toBe(0);
});

it('简历模型日期不符合契约时保留格式错误，不误报执行中断', async () => {
  const f = await fixture();
  f.model.setMode('invalid_dates');
  const resume = await upload(f);
  await f.runtime.resumeServices.worker.tick();
  const response = await f.request(`/resumes/${resume.id}`);
  const state = ResumeSchema.parse((await response.json()).payload);
  expect(state.status).toBe('failed');
  expect(state.errorCode).toBe('MODEL_OUTPUT_INVALID');
  expect(state.draftId).toBeNull();
  expect(f.model.calls()).toBe(1);
  expect((await (await f.request('/profile')).json()).payload.version).toBe(0);
});

it('模型HTTP不可用保留分类且不返回供应商原始错误或自动重试', async () => {
  const f = await fixture();
  f.model.setMode('http_error');
  const resume = await upload(f);
  await f.runtime.resumeServices.worker.tick();
  const body = await (await f.request(`/resumes/${resume.id}`)).json();
  const state = ResumeSchema.parse(body.payload);
  expect(state.status).toBe('failed');
  expect(state.errorCode).toBe('MODEL_UNAVAILABLE');
  expect(JSON.stringify(body)).not.toContain('provider-private-fixture-detail');
  expect(f.model.calls()).toBe(1);
});

it.each(['dated_resume', 'dated_parent'] as const)(
  '点号原文年月转换为规范日期后有原文依据的草稿可以生成：%s',
  async (mode) => {
    const f = await fixture();
    f.model.setMode(mode);
    const resume = await upload(f, '2027.06');
    await f.runtime.resumeServices.worker.tick();
    const state = ResumeSchema.parse(
      (await (await f.request(`/resumes/${resume.id}`)).json()).payload,
    );
    expect(state.status).toBe('ready');
    const draft = DraftSchema.parse(
      (await (await f.request(`/profile/drafts/${state.draftId}`)).json())
        .payload,
    );
    expect(draft.content.educationEntries[0]?.graduationDate).toEqual({
      value: '2027-06',
      precision: 'month',
    });
    expect(draft.evidence[0]?.excerpt).toBe('2027.06');
    expect((await (await f.request('/profile')).json()).payload.version).toBe(
      0,
    );
    expect(f.model.calls()).toBe(1);
  },
);

it('经历说明采用有定位的逐字引用，而非模型改写的摘要', async () => {
  const f = await fixture();
  f.model.setMode('paraphrased_description');
  const resume = await upload(f, '原文项目实践');
  await f.runtime.resumeServices.worker.tick();
  const state = ResumeSchema.parse(
    (await (await f.request(`/resumes/${resume.id}`)).json()).payload,
  );
  expect(state.status).toBe('ready');
  const draft = DraftSchema.parse(
    (await (await f.request(`/profile/drafts/${state.draftId}`)).json())
      .payload,
  );
  expect(draft.content.internshipEntries[0]?.description).toBe('原文项目实践');
  expect((await (await f.request('/profile')).json()).payload.version).toBe(0);
});

it('模型声称的原文引用不存在时仍拒绝经历草稿', async () => {
  const f = await fixture();
  f.model.setMode('fabricated_description');
  const resume = await upload(f, '原文项目实践');
  await f.runtime.resumeServices.worker.tick();
  const state = ResumeSchema.parse(
    (await (await f.request(`/resumes/${resume.id}`)).json()).payload,
  );
  expect(state.status).toBe('failed');
  expect(state.errorCode).toBe('INVALID_EVIDENCE');
  expect(state.draftId).toBeNull();
});
