import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { waitForHealth, stopProcess } from '@career/testing';
export async function startBrowserApi(extra: NodeJS.ProcessEnv = {}) {
  if (process.env.TEST_DATABASE_ISOLATED !== 'true') throw Error('仅隔离E2E');
  const env = {
    ...process.env,
    SERVICE_AUTH_TOKEN: 'browser-service-fixture-'.repeat(3),
    AUTH_PUBLIC_ORIGIN: 'http://127.0.0.1:4173',
    AUTH_TOKEN_PEPPER: randomBytes(32).toString('hex'),
    AUTH_CSRF_SECRET: randomBytes(32).toString('hex'),
    ...extra,
  };
  const child = spawn(process.execPath, ['tests/fixtures/auth-server.mjs'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  await waitForHealth(process.env.API_INTERNAL_URL + '/health/live');
  return { env, close: () => stopProcess(child) };
}
export async function registerBrowser(page: Page) {
  const username = 'e' + randomUUID().replaceAll('-', '').slice(0, 14);
  await page.goto('/register');
  await expect(page.getByRole('img', { name: '图片验证码' })).toBeVisible();
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page
    .getByLabel('密码', { exact: true })
    .fill('browser-fixture-password-123');
  await page
    .getByLabel('确认密码', { exact: true })
    .fill('browser-fixture-password-123');
  await page.getByLabel('验证码', { exact: true }).fill('234567');
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('img', { name: '图片验证码' })).toBeVisible();
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page
    .getByLabel('密码', { exact: true })
    .fill('browser-fixture-password-123');
  await page.getByLabel('验证码', { exact: true }).fill('234567');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  return username;
}
