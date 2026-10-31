import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  open,
  unlink,
  copyFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  IngestionError,
  SourceResourceEntity,
  newSourceTask,
  createIngestionRuntime,
  createSourceReader,
  PublicHttpsTransport,
  readSourceCookie,
} from '@career/business';
import { startTestDatabase } from './lib/test-database.mjs';

// 本命令仅用于用户已批准的第六步40次验证，历史及重跑共享同一账本。
const directory = 'docs/ingestion';
await mkdir(directory, { recursive: true });
const ledger = join(directory, 'source-request-ledger.jsonl');
const lockPath = ledger + '.lock';
let lock;
try {
  lock = await open(lockPath, 'wx', 0o600);
} catch {
  throw Error('来源验证账本已被占用，请先确认原进程已结束');
}
const privateRoot = join('.artifacts', 'ingestion-source-private');
const startedAt = new Date().toISOString();
let database, runtime;
const results = [];
async function count() {
  try {
    return (await readFile(ledger, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row.event === 'started').length;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw Error('来源账本不可解析');
  }
}
try {
  const usedBefore = await count();
  if (usedBefore >= 40) throw Error('获准40次预算已用完');
  const cookie = await readSourceCookie('tools/verification/.env.source');
  database = await startTestDatabase();
  await new Promise((resolve, reject) => {
    const child = spawn(
      'pnpm',
      ['exec', 'prisma', 'migrate', 'deploy', '--config', 'prisma.config.ts'],
      {
        env: { ...process.env, DATABASE_URL: database.url },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    child.once('error', () => reject(Error('验证迁移无法启动')));
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(Error('验证迁移失败')),
    );
  });
  runtime = createIngestionRuntime({
    databaseUrl: database.url,
    privateRoot,
    exportRoot: join(privateRoot, 'exports'),
    operatorReference: 'approved_source_verification',
    network: {
      enabled: false,
      budgetId: 'step6-approved-verification',
      requestLimit: 40,
    },
  });
  const native = new PublicHttpsTransport();
  const reader = createSourceReader(
    runtime.dependencies,
    {
      enabled: true,
      budgetId: 'step6-approved-verification',
      requestLimit: 40,
      ...(cookie ? { cookie } : {}),
    },
    {
      async get(url, credential) {
        if ((await count()) >= 40)
          throw new IngestionError('SOURCE_BUDGET_EXHAUSTED');
        const requestId = randomUUID();
        await appendFile(
          ledger,
          JSON.stringify({
            event: 'started',
            requestId,
            url: url.href,
            startedAt: new Date().toISOString(),
          }) + '\n',
        );
        try {
          const response = await native.get(url, credential);
          await appendFile(
            ledger,
            JSON.stringify({
              event: 'finished',
              requestId,
              status: response.status,
              endedAt: new Date().toISOString(),
            }) + '\n',
          );
          return response;
        } catch {
          await appendFile(
            ledger,
            JSON.stringify({
              event: 'finished',
              requestId,
              errorCode: 'SOURCE_UNAVAILABLE',
              endedAt: new Date().toISOString(),
            }) + '\n',
          );
          throw new IngestionError('SOURCE_UNAVAILABLE');
        }
      },
    },
  );
  // 逐项报告限制，不把认证HTML写入任何证据或日志。
  for (const page of [1, 2]) {
    try {
      const result = await reader.list(page);
      results.push({
        operation: `list:${page}`,
        status: 'passed',
        jobCount: result.jobIds.length,
        nextPage: result.nextPage,
      });
    } catch (error) {
      results.push({
        operation: `list:${page}`,
        status: 'blocked',
        errorCode: error.code ?? 'SOURCE_UNAVAILABLE',
      });
    }
  }
  try {
    const result = await reader.evidence(
      'job',
      '01d3988d-6c30-0d20-2c09-0f15085e21b2',
    );
    results.push({
      operation: 'known-social-detail',
      status: 'passed',
      recruitmentType: result.body.recruitmentType,
      rawDigest: result.rawDigest,
    });
    await writeFile(
      join(directory, 'social-evidence.json'),
      JSON.stringify(result.body, null, 2) + '\n',
    );
  } catch (error) {
    results.push({
      operation: 'known-social-detail',
      status: 'blocked',
      errorCode: error.code ?? 'SOURCE_UNAVAILABLE',
    });
  }
  // 正式Service+数据库+文件链路，最多处理6项，避免验证变成无限全量采集。
  runtime.dependencies.source = reader;
  // 社招种子来自第三步实际获取的公开URL，用于验证正文入库而非虚构岗位。
  await runtime.dependencies.unitOfWork.run(async (c) => {
    const repo = runtime.dependencies.repositories(c);
    const now = await repo.now();
    const resource = await repo.ensureResource(
      new SourceResourceEntity({
        id: randomUUID(),
        kind: 'job',
        sourceId: '01d3988d-6c30-0d20-2c09-0f15085e21b2',
        canonicalUrl:
          'https://www.zhidianmijin.com.cn/jobs/01d3988d-6c30-0d20-2c09-0f15085e21b2',
        currentVersionId: null,
        lastAttemptAt: null,
        lastFetchedAt: null,
        nextRefreshAt: now,
        reviewVersion: 0,
        currentReviewId: null,
        stateVersion: 0,
      }),
    );
    await repo.ensureJob({
      id: randomUUID(),
      resourceId: resource.snapshot().id,
    });
    await repo.insertTaskIfAbsent(
      newSourceTask(
        randomUUID(),
        randomUUID(),
        `fetch:${resource.snapshot().id}`,
        { kind: 'fetch', resourceId: resource.snapshot().id },
        now,
        1,
      ),
    );
  });
  const registration = await runtime.services.discover.execute({
    sourceKey: 'zhidianmijin',
    stream: 'new',
    runId: randomUUID(),
    pageLimit: 1,
  });
  for (let i = 0; i < 6 && (await count()) < 40; i++) {
    if (!(await runtime.services.execution.runOne())) break;
  }
  const coverage = await runtime.services.coverage.execute();
  const tasks = await runtime.dependencies.unitOfWork.run(async (c) =>
    (await runtime.dependencies.repositories(c).listTasks()).map((t) => {
      const s = t.snapshot();
      return {
        id: s.id,
        kind: s.kind,
        status: s.status,
        errorCode: s.errorCode,
      };
    }),
  );
  const exported = await runtime.services.export.execute({
    scope: 'all',
    operationKey: randomUUID(),
  });
  await copyFile(
    join(privateRoot, 'exports', exported.exportId + '.json'),
    join(directory, 'source-data.json'),
  );
  const report = {
    startedAt,
    endedAt: new Date().toISOString(),
    budget: 40,
    usedBefore,
    usedAfter: await count(),
    historicalSourceRequests: 26,
    modelRequestsUnchanged: 5,
    results,
    pipeline: {
      taskId: registration.taskId,
      coverage,
      tasks,
      exportDigest: exported.manifestDigest,
    },
    limitations: [
      '有限样本，不代表全站范围或更新吞吐已验证',
      '认证列表只在内存解析，不保存原始HTML',
      '外站原文未访问，抓取成功不等于资格已核验',
      '真实持续采集保持关闭',
    ],
  };
  await writeFile(
    join(directory, 'source-validation.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      results,
      requestsThisRun: report.usedAfter - usedBefore,
      usedAfter: report.usedAfter,
      storedJobs: coverage.counts.fetched,
      storedReviews: coverage.counts.reviewed,
    }),
  );
} finally {
  if (runtime) await runtime.close();
  if (database) await database.close();
  await lock.close();
  await unlink(lockPath);
}
