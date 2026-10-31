import { spawn } from 'node:child_process';
import { startTestDatabase } from './lib/test-database.mjs';
import { availablePort } from '@career/testing';

const kind = process.argv[2];
if (!['integration', 'e2e'].includes(kind)) throw Error('测试类型非法');
const database = await startTestDatabase();
const apiPort = await availablePort();
const environment = {
  ...process.env,
  // 本地测试只访问回环服务，显式匹配以兼容不识别127.*的代理实现。
  NO_PROXY: `${process.env.NO_PROXY ?? ''},127.0.0.1,localhost`,
  no_proxy: '127.0.0.1,localhost',
  API_PORT: String(apiPort),
  API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
  DATABASE_URL: database.url,
  TEST_DATABASE_CONTAINER: database.container,
  TEST_DATABASE_ISOLATED: 'true',
};
function run(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', arguments_, {
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', () => reject(Error('测试进程无法启动')));
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(Error('测试命令失败')),
    );
  });
}
try {
  await run([
    'exec',
    'prisma',
    'migrate',
    'deploy',
    '--config',
    'prisma.config.ts',
  ]);
  if (kind === 'integration')
    await run([
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.integration.config.ts',
      ...process.argv.slice(3),
      '--reporter=default',
      '--reporter=json',
      '--outputFile=.artifacts/integration.json',
    ]);
  else await run(['exec', 'playwright', 'test', ...process.argv.slice(3)]);
} finally {
  await database.close();
}
