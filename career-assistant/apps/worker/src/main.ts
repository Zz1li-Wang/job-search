import 'reflect-metadata';
import { readFile, stat } from 'node:fs/promises';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  ApiConfigSchema,
  AuthConfigSchema,
  IngestionConfigSchema,
  readConfig,
  ConfigurationError,
} from '@career/config';
import {
  createIngestionRuntime,
  readSourceCookie,
  createAssistantRuntime,
} from '@career/business';
import { createSafeLogger } from '@career/observability';
import { executeMaintenance } from './cli.js';
import { startSourceWorker } from './loop.js';
@Module({})
class WorkerModule {}
async function main() {
  const config = readConfig(ApiConfigSchema, process.env);
  const ingestion = readConfig(IngestionConfigSchema, process.env);
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
  });
  const cookie = ingestion.INGESTION_NETWORK_ENABLED
    ? await readSourceCookie(ingestion.INGESTION_COOKIE_FILE)
    : undefined;
  const runtime = createIngestionRuntime({
    databaseUrl: config.DATABASE_URL,
    privateRoot: config.PRIVATE_FILE_ROOT,
    exportRoot: ingestion.INGESTION_EXPORT_ROOT,
    operatorReference: ingestion.INGESTION_OPERATOR_REFERENCE,
    network: {
      enabled: ingestion.INGESTION_NETWORK_ENABLED,
      budgetId: ingestion.INGESTION_BUDGET_ID,
      requestLimit: ingestion.INGESTION_REQUEST_LIMIT,
      ...(cookie ? { cookie } : {}),
    },
  });
  const close = async () => {
    await runtime.close();
    await app.close();
  };
  if (
    !(await runtime.persistence.probe.isAvailable()) ||
    !(await runtime.persistence.ingestionProbe.isAvailable())
  ) {
    await close();
    throw Error('数据库不可用');
  }
  const arguments_ = process.argv.slice(2);
  if (arguments_.length) {
    const command = arguments_.slice(0, 2).join(' ');
    const inputFile = arguments_[2];
    let input: unknown;
    try {
      if (!inputFile || arguments_.length !== 3) throw Error();
      const metadata = await stat('.env');
      if ((metadata.mode & 0o077) !== 0) throw Error();
      input = JSON.parse(await readFile(inputFile, 'utf8'));
    } catch {
      process.stderr.write(
        JSON.stringify({
          error: {
            code: 'INVALID_INPUT',
            message: '需要JSON输入文件及0600服务器配置',
          },
        }) + '\n',
      );
      await close();
      process.exitCode = 2;
      return;
    }
    const result = await executeMaintenance(
      runtime.services,
      command,
      input,
      ingestion.INGESTION_OPERATOR_REFERENCE,
    );
    (result.exitCode === 0 ? process.stdout : process.stderr).write(
      JSON.stringify(result.output) + '\n',
    );
    process.exitCode = result.exitCode;
    await close();
    return;
  }
  const auth = readConfig(AuthConfigSchema, process.env);
  const assistant = await createAssistantRuntime({
    databaseUrl: config.DATABASE_URL,
    privateRoot: config.PRIVATE_FILE_ROOT,
    tokenPepper: auth.AUTH_TOKEN_PEPPER,
    csrfSecret: auth.AUTH_CSRF_SECRET,
    agentBase:
      process.env.AGENT_INTERNAL_URL ?? `http://127.0.0.1:${config.AGENT_PORT}`,
    callbackBase:
      process.env.API_INTERNAL_URL ?? `http://127.0.0.1:${config.API_PORT}`,
    serviceToken: config.SERVICE_AUTH_TOKEN,
  });
  let assistantTask: Promise<unknown> | null = null;
  const assistantTimer = setInterval(() => {
    if (assistantTask) return;
    assistantTask = Promise.all([
      assistant.services.dispatcher.tick(),
      assistant.resumes.worker.tick(),
    ])
      .catch(() => logger.error('对话任务执行失败'))
      .finally(() => {
        assistantTask = null;
      });
  }, 500);
  const logger = createSafeLogger('worker');
  logger.info('worker_started');
  const loop = await startSourceWorker(runtime.services, {
    isEnabled: ingestion.INGESTION_NETWORK_ENABLED,
    onError: () => logger.error('采集执行失败，稍后重试'),
    onHeartbeat: () => logger.info('worker_alive'),
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      clearInterval(assistantTimer);
      void Promise.resolve(assistantTask)
        .then(() => assistant.close())
        .then(() => loop.close())
        .then(close)
        .then(() => {
          process.exitCode = 0;
        });
    });
}
main().catch((error) => {
  createSafeLogger('worker').error(
    error instanceof ConfigurationError
      ? error.message
      : '启动失败，请检查配置和依赖',
  );
  process.exitCode = 1;
});
