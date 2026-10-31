import { test, expect } from '@playwright/test';
import {
  availablePort,
  startProcess,
  stopProcess,
  waitForHealth,
} from '@career/testing';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Client } from 'pg';

const execute = promisify(execFile);
if (
  process.env.TEST_DATABASE_ISOLATED !== 'true' ||
  !process.env.TEST_DATABASE_CONTAINER
)
  throw Error('E2E必须由隔离数据库入口启动');
const token = 'e2e-service-token-'.repeat(3);

test('E2E-FOUNDATION 浏览器、真实服务、数据库故障与进程持久化', async ({
  page,
}) => {
  const apiPort = Number(process.env.API_PORT);
  const agentPort = await availablePort();
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    API_PORT: String(apiPort),
    AGENT_PORT: String(agentPort),
    SERVICE_AUTH_TOKEN: token,
    API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
    MODEL_API_KEY: 'fictional-no-model-call',
    MODEL_NAME: 'deepseek-v4-pro',
    AUTH_PUBLIC_ORIGIN: 'http://127.0.0.1:4173',
    AUTH_TOKEN_PEPPER: 'foundation-token-pepper-'.repeat(3),
    AUTH_CSRF_SECRET: 'foundation-csrf-secret-'.repeat(3),
  };
  let api = startProcess('apps/api/dist/main.js', environment);
  const agent = startProcess('apps/agent/dist/main.js', environment);
  const worker = startProcess('apps/worker/dist/main.js', environment);
  let isPaused = false;
  try {
    await waitForHealth(`http://127.0.0.1:${apiPort}/health/ready`);
    await waitForHealth(`http://127.0.0.1:${agentPort}/health/ready`, token);
    await expect.poll(() => worker.output()).toContain('worker_started');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '求职助手' })).toBeVisible();
    await page.getByRole('button', { name: '检查服务连接' }).click();
    await expect(page.getByRole('status')).toHaveText('服务连接正常');

    const key = randomUUID();
    const fixture = (operation: string, id = key) =>
      execute(
        process.execPath,
        ['tests/fixtures/transaction-process.mjs', operation, id],
        { env: environment },
      );
    expect(JSON.parse((await fixture('write')).stdout).committed).toBe(true);
    await stopProcess(api.child);
    api = startProcess('apps/api/dist/main.js', environment);
    await waitForHealth(`http://127.0.0.1:${apiPort}/health/ready`);
    expect(JSON.parse((await fixture('read')).stdout).responseReference).toBe(
      'persisted-across-processes',
    );
    const rolledBackKey = randomUUID();
    expect(
      JSON.parse((await fixture('rollback', rolledBackKey)).stdout).rolledBack,
    ).toBe(true);
    expect(
      JSON.parse((await fixture('read', rolledBackKey)).stdout)
        .responseReference,
    ).toBeNull();

    await execute('docker', ['pause', process.env.TEST_DATABASE_CONTAINER!]);
    isPaused = true;
    expect(
      (
        await page.request.get(`http://127.0.0.1:${apiPort}/health/live`)
      ).status(),
    ).toBe(200);
    expect(
      (
        await page.request.get(`http://127.0.0.1:${apiPort}/health/ready`)
      ).status(),
    ).toBe(503);
    expect(
      (
        await page.request.get(`http://127.0.0.1:${agentPort}/health/ready`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status(),
    ).toBe(503);
    await page.getByRole('button', { name: '检查服务连接' }).click();
    await expect(page.getByRole('status')).toHaveText(
      '服务暂不可用，请稍后重试',
    );
    await execute('docker', ['unpause', process.env.TEST_DATABASE_CONTAINER!]);
    isPaused = false;
    await expect
      .poll(
        async () =>
          (
            await page.request.get(`http://127.0.0.1:${apiPort}/health/ready`)
          ).status(),
        { timeout: 15000 },
      )
      .toBe(200);
    for (const service of [api, agent, worker]) {
      expect(service.output()).not.toContain(token);
      expect(service.output()).not.toContain(environment.DATABASE_URL!);
    }
  } finally {
    if (isPaused)
      await execute('docker', [
        'unpause',
        process.env.TEST_DATABASE_CONTAINER!,
      ]);
    await Promise.all([
      stopProcess(api.child),
      stopProcess(agent.child),
      stopProcess(worker.child),
    ]);
  }
});

test('E2E-FOUNDATION 缺少配置的真实入口安全失败', async () => {
  const child = startProcess('apps/api/dist/main.js', {
    PATH: process.env.PATH,
    DATABASE_URL: 'private-invalid-url',
    SERVICE_AUTH_TOKEN: token,
  });
  const code = await new Promise<number | null>((resolve) =>
    child.child.once('exit', resolve),
  );
  expect(code).toBe(1);
  expect(child.output()).not.toContain('private-invalid-url');
});

test('E2E-FOUNDATION 隔离库迁移回退后可重新部署', async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // 独立测试schema回退，不删除同库认证表及其他用例数据。
    const schema = `rollback_${randomUUID().replaceAll('-', '')}`;
    const migrationUrl = new URL(process.env.DATABASE_URL!);
    migrationUrl.searchParams.set('schema', schema);
    const migrate = () =>
      execute(
        'pnpm',
        ['exec', 'prisma', 'migrate', 'deploy', '--config', 'prisma.config.ts'],
        { env: { ...process.env, DATABASE_URL: migrationUrl.href } },
      );
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await migrate();
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.query(`CREATE SCHEMA "${schema}"`);
      await migrate();
      const tables = await client.query<{ count: string }>(
        "SELECT COUNT(*) FROM pg_tables WHERE schemaname=$1 AND tablename IN ('task_outbox','audit_events','idempotency_records')",
        [schema],
      );
      expect(tables.rows[0]?.count).toBe('3');
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  } finally {
    await client.end();
  }
});
