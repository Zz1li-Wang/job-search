import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { waitForHealth, stopProcess } from '@career/testing';

const PASSWORD = 'browser-test-password-123';
const NEW_PASSWORD = 'browser-new-password-456';
const ORIGIN = 'http://127.0.0.1:4173';
if (process.env.TEST_DATABASE_ISOLATED !== 'true') throw Error('仅允许隔离E2E');
async function server() {
  const environment = {
    ...process.env,
    SERVICE_AUTH_TOKEN: 'auth-test-service-token-'.repeat(3),
    AUTH_PUBLIC_ORIGIN: ORIGIN,
    AUTH_TOKEN_PEPPER: randomBytes(32).toString('hex'),
    AUTH_CSRF_SECRET: randomBytes(32).toString('hex'),
  };
  const child = spawn(process.execPath, ['tests/fixtures/auth-server.mjs'], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output += String(chunk);
  });
  await waitForHealth(`${process.env.API_INTERNAL_URL}/health/live`);
  return {
    output: () => output,
    async advance(milliseconds: number) {
      await new Promise<void>((resolve) => {
        child.once('message', () => resolve());
        child.send({ type: 'advance', milliseconds });
      });
    },
    close: () => stopProcess(child),
  };
}
async function login(page: Page, username: string, password = PASSWORD) {
  await page.goto('/login');
  await expect(page.getByRole('img', { name: '图片验证码' })).toBeVisible();
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('验证码', { exact: true }).fill('234567');
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('E2E-AUTH 注册登录刷新、第二设备、改密撤销和重新登录', async ({
  page,
  browser,
}) => {
  const runtime = await server();
  const second = await browser.newContext();
  try {
    const username = `b${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await page.goto('/register');
    const image = page.getByRole('img', { name: '图片验证码' });
    await expect(image).toBeVisible();
    expect(
      await image.evaluate(
        (node) =>
          node instanceof HTMLImageElement &&
          node.naturalWidth === 240 &&
          node.naturalHeight === 80,
      ),
    ).toBe(true);
    await page.getByLabel('用户名', { exact: true }).fill(username);
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByLabel('确认密码', { exact: true }).fill(PASSWORD);
    await page.getByLabel('验证码', { exact: true }).fill('234567');
    await page.getByRole('button', { name: '注册', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登录账号' })).toBeVisible();
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
    await login(page, username);
    await expect(page.getByRole('heading', { name: '账号设置' })).toBeVisible();
    await page.reload();
    await expect(page.getByText(username, { exact: true })).toBeVisible();
    const secondPage = await second.newPage();
    await login(secondPage, username);
    await expect(
      secondPage.getByRole('heading', { name: '账号设置' }),
    ).toBeVisible();
    await mkdir('.artifacts', { recursive: true });
    await page.screenshot({
      path: '.artifacts/auth-settings.png',
      fullPage: true,
    });
    await page.getByLabel('当前密码', { exact: true }).fill(PASSWORD);
    await page.getByLabel('新密码', { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: '修改密码', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登录账号' })).toBeVisible();
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
    expect(
      (await second.request.get(`${ORIGIN}/api/v1/auth/me`)).status(),
    ).toBe(401);
    await secondPage.reload();
    await expect(
      secondPage.getByRole('heading', { name: '登录账号' }),
    ).toBeVisible();
    await login(page, username, NEW_PASSWORD);
    await expect(page.getByRole('heading', { name: '账号设置' })).toBeVisible();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登录账号' })).toBeVisible();
    expect(
      (
        await page.request.post('/api/v1/auth/logout', {
          headers: { origin: ORIGIN },
        })
      ).status(),
    ).toBe(204);
    expect(runtime.output().includes(PASSWORD)).toBe(false);
    expect(runtime.output().includes(NEW_PASSWORD)).toBe(false);
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
  } finally {
    await second.close();
    await runtime.close();
  }
});

test('E2E-AUTH 错误验证码、重放、CSRF和冷却到期恢复', async ({ page }) => {
  const runtime = await server();
  try {
    await page.goto('/login');
    await expect(page.getByRole('img', { name: '图片验证码' })).toBeVisible();
    const username = `b${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await page.getByLabel('用户名', { exact: true }).fill(username);
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
    await page.getByLabel('验证码', { exact: true }).fill('999999');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(
      '验证码无效，请刷新后重试',
    );
    const challenge = async () =>
      (await (await page.request.get('/api/v1/auth/captcha')).json())
        .payload as { captchaId: string; csrfToken: string };
    const first = await challenge();
    const input = {
      username,
      password: PASSWORD,
      captchaId: first.captchaId,
      captchaAnswer: '234567',
    };
    expect(
      (
        await page.request.post('/api/v1/auth/login', {
          data: input,
          headers: { origin: ORIGIN },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await page.request.post('/api/v1/auth/login', {
          data: input,
          headers: { origin: ORIGIN, 'x-csrf-token': first.csrfToken },
        })
      ).status(),
    ).toBe(401);
    expect(
      (
        await page.request.post('/api/v1/auth/login', {
          data: input,
          headers: { origin: ORIGIN, 'x-csrf-token': first.csrfToken },
        })
      ).status(),
    ).toBe(400);
    for (let failure = 1; failure < 5; failure++) {
      const current = await challenge();
      expect(
        (
          await page.request.post('/api/v1/auth/login', {
            data: { ...input, captchaId: current.captchaId },
            headers: { origin: ORIGIN, 'x-csrf-token': current.csrfToken },
          })
        ).status(),
      ).toBe(401);
    }
    const blocked = await challenge();
    expect(
      (
        await page.request.post('/api/v1/auth/login', {
          data: { ...input, captchaId: blocked.captchaId },
          headers: { origin: ORIGIN, 'x-csrf-token': blocked.csrfToken },
        })
      ).status(),
    ).toBe(429);
    await runtime.advance(15 * 60_000);
    const restored = await challenge();
    expect(
      (
        await page.request.post('/api/v1/auth/login', {
          data: { ...input, captchaId: restored.captchaId },
          headers: { origin: ORIGIN, 'x-csrf-token': restored.csrfToken },
        })
      ).status(),
    ).toBe(401);
  } finally {
    await runtime.close();
  }
});
