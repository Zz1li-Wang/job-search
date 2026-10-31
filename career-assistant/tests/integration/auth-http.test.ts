import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  CaptchaResponseSchema,
  UserResponseSchema,
  ErrorResponseSchema,
} from '@career/contracts';
import { createPersistence, AUTH_POLICY } from '@career/business';
import {
  makeAuthHttpFixture,
  uniqueUsername,
  TEST_PASSWORD,
  TEST_NEW_PASSWORD,
  TEST_CAPTCHA_ANSWER,
  TEST_ORIGIN,
  isolatedDatabaseUrl,
} from '../fixtures/auth.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});
async function server() {
  const fixture = await makeAuthHttpFixture();
  cleanups.push(fixture.close);
  return fixture;
}
describe('账号HTTP逐接口契约', () => {
  it('认证表迁移缺失时ready503但live200', async () => {
    const fixture = await server();
    const client = new Client({ connectionString: isolatedDatabaseUrl() });
    await client.connect();
    try {
      await client.query(
        'ALTER TABLE users RENAME TO users_temporarily_hidden',
      );
      expect((await fetch(`${fixture.base}/health/live`)).status).toBe(200);
      const response = await fetch(`${fixture.base}/health/ready`);
      expect(response.status).toBe(503);
      expect((await response.json()).payload.dependencies).toEqual({
        database: true,
        auth_storage: false,
        ingestion_storage: true,
        application_storage: true,
      });
    } finally {
      await client.query(
        'ALTER TABLE users_temporarily_hidden RENAME TO users',
      );
      await client.end();
    }
  });
  it('AUTH-01 PNG挑战和浏览器绑定及限流', async () => {
    const fixture = await server();
    const browser = fixture.client();
    const response = await browser.request('GET', 'captcha');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const first = CaptchaResponseSchema.parse(await response.json()).payload;
    expect(
      Buffer.from(first.imageDataUrl.split(',')[1]!, 'base64').subarray(0, 8),
    ).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(Object.keys(first).sort()).toEqual([
      'captchaId',
      'csrfToken',
      'expiresAt',
      'imageDataUrl',
    ]);
    expect((await browser.challenge()).captchaId).not.toBe(first.captchaId);
    const foreign = fixture.client();
    const foreignTicket = await foreign.challenge();
    const input = {
      username: uniqueUsername(),
      password: TEST_PASSWORD,
      captchaId: first.captchaId,
      captchaAnswer: TEST_CAPTCHA_ANSWER,
    };
    expect(
      (
        await foreign.request(
          'POST',
          'register',
          input,
          foreignTicket.csrfToken,
        )
      ).status,
    ).toBe(400);
    expect(
      (await browser.request('POST', 'register', input, first.csrfToken))
        .status,
    ).toBe(201);
    // 当前同IP已有3次图片请求，其余允许到固定上限。
    for (let count = 3; count < AUTH_POLICY.limits.captcha; count++)
      expect((await browser.request('GET', 'captcha')).status).toBe(200);
    const limited = await browser.request('GET', 'captcha');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });
  it('AUTH-02 注册不登录及验证前拒绝和用户名冲突', async () => {
    const fixture = await server();
    const browser = fixture.client();
    const ticket = await browser.challenge();
    const username = uniqueUsername();
    const input = {
      username,
      password: TEST_PASSWORD,
      captchaId: ticket.captchaId,
      captchaAnswer: TEST_CAPTCHA_ANSWER,
    };
    expect(
      (
        await browser.request('POST', 'register', input, ticket.csrfToken, {
          origin: 'https://foreign.example',
        })
      ).status,
    ).toBe(403);
    expect(
      (await browser.request('POST', 'register', input, 'a'.repeat(64))).status,
    ).toBe(403);
    expect(
      (
        await browser.request(
          'POST',
          'register',
          { ...input, userId: randomUUID() },
          ticket.csrfToken,
        )
      ).status,
    ).toBe(400);
    const created = await browser.request(
      'POST',
      'register',
      input,
      ticket.csrfToken,
    );
    expect(created.status).toBe(201);
    const user = UserResponseSchema.parse(await created.json()).payload;
    expect(user.username).toBe(username);
    expect(browser.cookies.has('career_session_dev')).toBe(false);
    expect((await browser.request('GET', 'me')).status).toBe(401);
    expect(
      (await browser.credentials('register', username.toUpperCase())).status,
    ).toBe(409);
    expect(JSON.stringify(user)).not.toContain(TEST_PASSWORD);
    expect(
      (await browser.request('POST', 'register', input, ticket.csrfToken))
        .status,
    ).toBe(400);
  });
  it('AUTH-03 登录Cookie冷却和统一错误及验证码重放', async () => {
    const fixture = await server();
    const browser = fixture.client();
    const username = uniqueUsername();
    expect((await browser.credentials('register', username)).status).toBe(201);
    const ticket = await browser.challenge();
    const wrongInput = {
      username,
      password: TEST_NEW_PASSWORD,
      captchaId: ticket.captchaId,
      captchaAnswer: TEST_CAPTCHA_ANSWER,
    };
    const wrong = await browser.request(
      'POST',
      'login',
      wrongInput,
      ticket.csrfToken,
    );
    expect(wrong.status).toBe(401);
    const wrongError = ErrorResponseSchema.parse(await wrong.json()).error;
    expect(
      (await browser.request('POST', 'login', wrongInput, ticket.csrfToken))
        .status,
    ).toBe(400);
    const unknown = await browser.credentials('login', uniqueUsername());
    expect(unknown.status).toBe(401);
    expect(ErrorResponseSchema.parse(await unknown.json()).error).toEqual(
      wrongError,
    );
    for (let count = 1; count < AUTH_POLICY.failureLimit; count++)
      expect(
        (await browser.credentials('login', username, TEST_NEW_PASSWORD))
          .status,
      ).toBe(401);
    const cooled = await browser.credentials('login', username);
    expect(cooled.status).toBe(429);
    fixture.clock.advance(AUTH_POLICY.cooldownMs);
    const logged = await browser.credentials('login', username);
    expect(logged.status).toBe(200);
    const cookie = logged.headers
      .getSetCookie()
      .find((value) => value.startsWith('career_session_dev='));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=604800');
    const body = UserResponseSchema.parse(await logged.json());
    expect(Object.keys(body.payload).sort()).toEqual([
      'createdAt',
      'csrfToken',
      'id',
      'username',
    ]);
    expect(JSON.stringify(body)).not.toContain(
      browser.cookies.get('career_session_dev'),
    );
  });
  it('AUTH-04 当前设备退出重复和空Cookie及CSRF', async () => {
    const fixture = await server();
    const first = fixture.client();
    const second = fixture.client();
    const user = await first.signedIn();
    expect((await second.credentials('login', user.username)).status).toBe(200);
    expect((await first.request('POST', 'logout')).status).toBe(403);
    const oldCookie = first.cookieHeader();
    expect(
      (await first.request('POST', 'logout', undefined, user.csrfToken)).status,
    ).toBe(204);
    expect(
      (
        await first.request('POST', 'logout', undefined, user.csrfToken, {
          cookie: oldCookie,
        })
      ).status,
    ).toBe(204);
    expect((await first.request('POST', 'logout')).status).toBe(204);
    expect(
      (
        await first.request('POST', 'logout', undefined, undefined, {
          origin: 'https://foreign.example',
        })
      ).status,
    ).toBe(403);
    expect((await first.request('GET', 'me')).status).toBe(401);
    expect((await second.request('GET', 'me')).status).toBe(200);
  });
  it('AUTH-05 本人资料及会话到期和伪造ID拒绝', async () => {
    const fixture = await server();
    const browser = fixture.client();
    const user = await browser.signedIn();
    const response = await browser.request('GET', 'me');
    expect(response.status).toBe(200);
    expect(UserResponseSchema.parse(await response.json()).payload.id).toBe(
      user.id,
    );
    expect(
      (await browser.request('GET', `me?userId=${randomUUID()}`)).status,
    ).toBe(400);
    fixture.clock.advance(AUTH_POLICY.sessionLifetimeMs);
    expect((await browser.request('GET', 'me')).status).toBe(401);
    expect(
      (
        await browser.request(
          'PUT',
          'password',
          { currentPassword: TEST_PASSWORD, newPassword: TEST_NEW_PASSWORD },
          user.csrfToken,
        )
      ).status,
    ).toBe(401);
  });
  it('AUTH-06 改密原密码错误及全部会话撤销', async () => {
    const fixture = await server();
    const browser = fixture.client();
    const other = fixture.client();
    const user = await browser.signedIn();
    expect((await other.credentials('login', user.username)).status).toBe(200);
    const persistence = createPersistence(isolatedDatabaseUrl());
    cleanups.push(() => persistence.close());
    expect(
      (
        await browser.request(
          'PUT',
          'password',
          { currentPassword: TEST_NEW_PASSWORD, newPassword: TEST_PASSWORD },
          user.csrfToken,
        )
      ).status,
    ).toBe(401);
    expect((await browser.request('GET', 'me')).status).toBe(200);
    const changed = await browser.request(
      'PUT',
      'password',
      { currentPassword: TEST_PASSWORD, newPassword: TEST_NEW_PASSWORD },
      user.csrfToken,
    );
    expect(changed.status).toBe(204);
    expect(await changed.text()).toBe('');
    expect((await browser.request('GET', 'me')).status).toBe(401);
    expect((await other.request('GET', 'me')).status).toBe(401);
    expect(
      (await browser.credentials('login', user.username, TEST_PASSWORD)).status,
    ).toBe(401);
    expect(
      (await browser.credentials('login', user.username, TEST_NEW_PASSWORD))
        .status,
    ).toBe(200);
    const account = await persistence.unitOfWork.run((context) =>
      persistence.auth(context).accounts.getById(user.id),
    );
    expect(account?.snapshot().authEpoch).toBe(1);
  });
  it('验证码错误和到期均消费，IP额度不能由转发头绕过', async () => {
    const fixture = await server();
    const browser = fixture.client();
    const ticket = await browser.challenge();
    const username = uniqueUsername();
    const input = {
      username,
      password: TEST_PASSWORD,
      captchaId: ticket.captchaId,
      captchaAnswer: '999999',
    };
    expect(
      (await browser.request('POST', 'register', input, ticket.csrfToken))
        .status,
    ).toBe(400);
    expect(
      (
        await browser.request(
          'POST',
          'register',
          { ...input, captchaAnswer: TEST_CAPTCHA_ANSWER },
          ticket.csrfToken,
        )
      ).status,
    ).toBe(400);
    const expired = await browser.challenge();
    fixture.clock.advance(AUTH_POLICY.captchaLifetimeMs);
    expect(
      (
        await browser.request(
          'POST',
          'register',
          {
            ...input,
            captchaId: expired.captchaId,
            captchaAnswer: TEST_CAPTCHA_ANSWER,
          },
          expired.csrfToken,
        )
      ).status,
    ).toBe(400);
    for (let attempt = 1; attempt < AUTH_POLICY.limits.credentials; attempt++) {
      const response = await browser.request(
        'POST',
        'register',
        { ...input, captchaId: randomUUID() },
        expired.csrfToken,
        { 'x-forwarded-for': `203.0.113.${attempt}` },
      );
      expect(response.status).toBe(400);
    }
    expect(
      (
        await browser.request(
          'POST',
          'register',
          { ...input, captchaId: randomUUID() },
          expired.csrfToken,
        )
      ).status,
    ).toBe(429);
    expect(TEST_ORIGIN).toContain('127.0.0.1');
  });
});
