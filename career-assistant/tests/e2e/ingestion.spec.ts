import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPersistence } from '@career/business';
import { isolatedDatabaseUrl } from '../fixtures/database.js';
import { jobHtml } from '../fixtures/ingestion.js';
const execute = promisify(execFile);
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  child.send?.({ type: 'close' });
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      timer.unref();
    }),
  ]);
}
test('E2E-INGEST 真实CLI和Worker完成发现证据核验更新与导出', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'career-ingest-e2e-'));
  const persistence = createPersistence(isolatedDatabaseUrl());
  let revision = 'A';
  let worker: ChildProcess | undefined;
  const source = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/robots.txt') {
      response.end('User-agent: *\nAllow: /\n');
      return;
    }
    if (request.url === '/jobs' || request.url?.startsWith('/jobs?'))
      response.end(
        '<main><h1>找岗位</h1><a href="/jobs/e2e_campus">校园岗位</a><a href="/jobs/e2e_social">社会岗位</a></main>',
      );
    else
      response.end(
        jobHtml(
          request.url?.includes('social') ? 'social' : 'campus',
          revision,
        ),
      );
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const address = source.address();
  if (!address || typeof address === 'string') throw Error('测试来源地址无效');
  const environment = {
    ...process.env,
    SERVICE_AUTH_TOKEN: randomUUID() + randomUUID(),
    INGESTION_OPERATOR_REFERENCE: 'fixture_operator',
    INGESTION_NETWORK_ENABLED: 'false',
    PRIVATE_FILE_ROOT: directory,
    INGESTION_EXPORT_ROOT: join(directory, 'exports'),
    INGESTION_FIXTURE_URL: `http://127.0.0.1:${address.port}`,
  };
  async function command(first: string, second: string, input: unknown) {
    const file = join(directory, randomUUID() + '.json');
    await writeFile(file, JSON.stringify(input));
    const result = await execute(
      process.execPath,
      ['apps/worker/dist/main.js', first, second, file],
      { env: environment },
    );
    return JSON.parse(result.stdout) as {
      taskId?: string;
      exportId?: string;
      manifestDigest?: string;
      status?: string;
    };
  }
  try {
    await command('collect', 'discover', {
      sourceKey: 'zhidianmijin',
      stream: 'new',
      runId: randomUUID(),
      pageLimit: 1,
    });
    worker = spawn(process.execPath, ['tests/fixtures/ingestion-worker.mjs'], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    await expect
      .poll(
        async () =>
          persistence.unitOfWork.run(
            async (c) =>
              (await persistence.ingestion(c).listResources()).filter(
                (r) => r.snapshot().currentVersionId,
              ).length,
          ),
        { timeout: 15000 },
      )
      .toBe(2);
    const state = await persistence.unitOfWork.run(async (c) => {
      const repo = persistence.ingestion(c);
      const resource = (await repo.listResources()).find(
        (r) => r.snapshot().kind === 'job',
      )!;
      const job = await repo.getJobByResource(resource.snapshot().id);
      const version = await repo.getVersion(
        resource.snapshot().currentVersionId!,
      );
      const observation = await repo.latestObservation(resource.snapshot().id);
      return {
        job: job!,
        resource: resource.snapshot(),
        version: version!.snapshot(),
        observation: observation!,
      };
    });
    const excerpt = state.version.body.blocks[0]!;
    await command('evidence', 'review', {
      jobId: state.job.id,
      expectedJobVersion: state.version.id,
      expectedReviewVersion: 0,
      evidenceVersions: [
        { resourceId: state.resource.id, versionId: state.version.id },
      ],
      tree: {
        type: 'unknown',
        reason: '经验待核验',
        evidence: [
          {
            resourceId: state.resource.id,
            versionId: state.version.id,
            observationId: state.observation.id,
            block: 0,
            start: 0,
            end: excerpt.length,
            excerpt,
          },
        ],
      },
      isComplete: false,
      gaps: ['经验待核验'],
      conflicts: [],
      reason: '进程E2E核验',
      operationKey: randomUUID(),
    });
    const exported = await command('data', 'export', {
      scope: 'all',
      operationKey: randomUUID(),
    });
    expect(exported.status).toBe('completed');
    const bytes = await readFile(
      join(directory, 'exports', exported.exportId + '.json'),
      'utf8',
    );
    expect(bytes).toContain('e2e_campus');
    expect(bytes).toContain('e2e_social');
    expect(bytes).not.toMatch(
      /fixture_operator|passwordHash|cookie|leaseUntil/,
    );
    const repeated = await command('data', 'export', {
      existingExportId: exported.exportId,
    });
    expect(repeated.manifestDigest).toBe(exported.manifestDigest);
    revision = 'B';
    await command('collect', 'discover', {
      sourceKey: 'zhidianmijin',
      stream: 'new',
      runId: randomUUID(),
      pageLimit: 1,
    });
    await expect
      .poll(
        async () =>
          persistence.unitOfWork.run(
            async (c) =>
              (await persistence
                .ingestion(c)
                .getResource(state.resource.id))!.snapshot().currentVersionId,
          ),
        { timeout: 15000 },
      )
      .not.toBe(state.version.id);
    expect(
      await persistence.unitOfWork.run(
        async (c) =>
          (await persistence
            .ingestion(c)
            .getResource(state.resource.id))!.snapshot().currentReviewId,
      ),
    ).toBe(null);
  } finally {
    if (worker) await stop(worker);
    await persistence.close();
    await new Promise<void>((resolve) => source.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('E2E-INGEST 429退避保留检查点、重启恢复与登录限制暂停', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'career-ingest-retry-'));
  const persistence = createPersistence(isolatedDatabaseUrl());
  let worker: ChildProcess | undefined;
  let mode: 'rate' | 'ok' | 'login' = 'rate';
  const { Client } = await import('pg');
  const admin = new Client({ connectionString: isolatedDatabaseUrl() });
  await admin.connect();
  await admin.query(
    'TRUNCATE task_attempts,task_requesters,task_outbox,source_streams,source_resources,source_snapshots,source_request_budgets,domain_permits,export_runs CASCADE',
  );
  await admin.end();
  const source = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/robots.txt') {
      response.end('User-agent: *\nAllow: /\n');
      return;
    }
    if (request.url === '/jobs') {
      if (mode === 'rate') {
        response.statusCode = 429;
        response.setHeader('retry-after', '0');
        response.end('limited');
        return;
      }
      if (mode === 'login') {
        response.end('<main><h1>登录后查看第 2 页岗位</h1></main>');
        return;
      }
      response.end(
        '<main><h1>找岗位</h1><a href="/jobs/recovery_campus">岗位</a></main>',
      );
      return;
    }
    response.end(jobHtml());
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const address = source.address();
  if (!address || typeof address === 'string') throw Error('替身地址无效');
  const env = {
    ...process.env,
    SERVICE_AUTH_TOKEN: randomUUID() + randomUUID(),
    INGESTION_OPERATOR_REFERENCE: 'fixture_operator',
    INGESTION_NETWORK_ENABLED: 'false',
    PRIVATE_FILE_ROOT: directory,
    INGESTION_EXPORT_ROOT: join(directory, 'exports'),
    INGESTION_FIXTURE_URL: `http://127.0.0.1:${address.port}`,
  };
  async function discover() {
    const file = join(directory, randomUUID() + '.json');
    await writeFile(
      file,
      JSON.stringify({
        sourceKey: 'zhidianmijin',
        stream: 'new',
        runId: randomUUID(),
        pageLimit: 1,
      }),
    );
    const { stdout } = await execute(
      process.execPath,
      ['apps/worker/dist/main.js', 'collect', 'discover', file],
      { env },
    );
    return (JSON.parse(stdout) as { taskId: string }).taskId;
  }
  const start = () =>
    spawn(process.execPath, ['tests/fixtures/ingestion-worker.mjs'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
  async function state(id: string) {
    return persistence.unitOfWork.run(async (c) =>
      (await persistence.ingestion(c).getTask(id))!.snapshot(),
    );
  }
  try {
    const taskId = await discover();
    worker = start();
    await expect
      .poll(async () => (await state(taskId)).status, { timeout: 15000 })
      .toBe('retry_wait');
    expect((await state(taskId)).errorCode).toBe('SOURCE_RATE_LIMITED');
    expect(
      await persistence.unitOfWork.run(
        async (c) =>
          (await persistence.ingestion(c).listStreams())[0]!.snapshot()
            .checkpoint,
      ),
    ).toBe(1);
    await stop(worker);
    mode = 'ok';
    worker = start();
    await expect
      .poll(async () => (await state(taskId)).status, { timeout: 20000 })
      .toBe('succeeded');
    await expect
      .poll(
        async () =>
          persistence.unitOfWork.run(
            async (c) =>
              (await persistence.ingestion(c).listResources()).filter(
                (r) => r.snapshot().currentVersionId,
              ).length,
          ),
        { timeout: 15000 },
      )
      .toBe(1);
    mode = 'login';
    const blockedId = await discover();
    await expect
      .poll(async () => (await state(blockedId)).status, { timeout: 15000 })
      .toBe('paused');
    expect((await state(blockedId)).errorCode).toBe('SOURCE_ACCESS_BLOCKED');
    expect(
      await persistence.unitOfWork.run(
        async (c) =>
          (await persistence.ingestion(c).listStreams())[0]!.snapshot()
            .checkpoint,
      ),
    ).toBe(1);
  } finally {
    if (worker) await stop(worker);
    await persistence.close();
    await new Promise<void>((resolve) => source.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
