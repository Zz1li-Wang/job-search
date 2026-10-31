import { it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  DeletionSchema,
  ResumeSchema,
  emptyProfileContent,
} from '@career/contracts';
import { makeChatFixture } from '../fixtures/chat.js';
import { TEST_PASSWORD } from '../fixtures/auth.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function fixture() {
  const f = await makeChatFixture();
  cleanups.push(f.close);
  return f;
}
async function remove(
  f: Awaited<ReturnType<typeof fixture>>,
  path: string,
  confirmation: string,
  key = randomUUID(),
  currentPassword?: string,
) {
  return fetch(f.base + '/api/v1' + path, {
    method: 'DELETE',
    headers: {
      cookie: f.client.cookieHeader(),
      origin: 'http://127.0.0.1:5173',
      'x-csrf-token': f.user.csrfToken,
      'idempotency-key': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      confirmation,
      ...(currentPassword ? { currentPassword } : {}),
    }),
  });
}
it('PRIV-01 清空画像与草稿幂等并保留账号', async () => {
  const f = await fixture();
  const draftResponse = await fetch(f.base + '/api/v1/profile/drafts', {
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
  const draft = (await draftResponse.json()).payload;
  await f.request(`/profile/drafts/${draft.id}/confirm`, 'POST', {
    expectedDraftVersion: 1,
    expectedProfileVersion: 0,
  });
  const key = randomUUID(),
    first = await remove(f, '/profile', 'CLEAR_PROFILE', key);
  expect(first.status).toBe(202);
  const deletion = DeletionSchema.parse((await first.json()).payload);
  expect(deletion.status).toBe('completed');
  const again = await remove(f, '/profile', 'CLEAR_PROFILE', key);
  expect(DeletionSchema.parse((await again.json()).payload).id).toBe(
    deletion.id,
  );
  expect((await (await f.request('/profile')).json()).payload.version).toBe(0);
  expect((await f.request(`/profile/drafts/${draft.id}`)).status).toBe(404);
  expect((await f.client.request('GET', 'me')).status).toBe(200);
});
it('PRIV-02 清空个人资料撤销队列与文件补偿', async () => {
  const f = await fixture();
  const response = await fetch(f.base + '/api/v1/resumes/text', {
    method: 'POST',
    headers: {
      cookie: f.client.cookieHeader(),
      origin: 'http://127.0.0.1:5173',
      'x-csrf-token': f.user.csrfToken,
      'idempotency-key': randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: '待删除简历', text: 'TypeScript' }),
  });
  const resume = ResumeSchema.parse((await response.json()).payload);
  const deletion = DeletionSchema.parse(
    (await (await remove(f, '/me/data', 'CLEAR_PERSONAL_DATA')).json()).payload,
  );
  expect(deletion.status).toBe('pending_cleanup');
  expect((await f.request(`/resumes/${resume.id}`)).status).toBe(404);
  await f.runtime.resumeServices.worker.tick();
  expect(f.model.calls()).toBe(0);
  const status = await f.request(`/deletions/${deletion.id}`);
  expect(DeletionSchema.parse((await status.json()).payload).status).toBe(
    'completed',
  );
  expect((await (await f.request('/resumes')).json()).payload).toEqual([]);
});
it('PRIV-03 删除账号要求密码并撤销所有会话', async () => {
  const f = await fixture();
  expect(
    (await remove(f, '/me', 'DELETE_ACCOUNT', randomUUID(), 'wrong-password'))
      .status,
  ).toBe(401);
  expect(
    (await remove(f, '/me', 'DELETE_ACCOUNT', randomUUID(), TEST_PASSWORD))
      .status,
  ).toBe(202);
  expect((await f.client.request('GET', 'me')).status).toBe(401);
  expect((await f.request('/conversations')).status).toBe(401);
});
it('PRIV-04 删除记录仅本人可读且确认范围不可混用', async () => {
  const f = await fixture();
  expect((await remove(f, '/profile', 'DELETE_ACCOUNT')).status).toBe(409);
  expect((await f.request(`/deletions/${randomUUID()}`)).status).toBe(404);
  const deletion = DeletionSchema.parse(
    (await (await remove(f, '/profile', 'CLEAR_PROFILE')).json()).payload,
  );
  expect((await f.request(`/deletions/${deletion.id}`)).status).toBe(200);
});
