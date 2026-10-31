import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
const execute = promisify(execFile);
const IMAGE =
  'postgres:17@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3';

/** 每次运行新建独立测试库，绝不从用户DATABASE_URL选择清理目标。 */
export async function startTestDatabase() {
  const container = `career-foundation-test-${randomUUID()}`;
  const password = randomBytes(24).toString('hex');
  await execute(
    'docker',
    [
      'run',
      '--rm',
      '--detach',
      '--name',
      container,
      '--label',
      'career.test=foundation',
      '--tmpfs',
      '/var/lib/postgresql/data:rw,size=512m',
      '--publish',
      '127.0.0.1::5432',
      '--env',
      'POSTGRES_PASSWORD',
      '--env',
      'POSTGRES_USER=career_test',
      '--env',
      'POSTGRES_DB=career_test',
      IMAGE,
    ],
    { env: { ...process.env, POSTGRES_PASSWORD: password } },
  );
  const close = async () => {
    await execute('docker', ['rm', '--force', '--volumes', container]);
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        await execute('docker', [
          'exec',
          container,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'career_test',
          '-d',
          'career_test',
        ]);
        ready = true;
        break;
      } catch {
        await setTimeout(250);
      }
    }
    if (!ready) throw Error('独立PostgreSQL测试容器未就绪');
    const { stdout } = await execute('docker', ['port', container, '5432/tcp']);
    const port = Number(stdout.trim().split(':').at(-1));
    if (!port) throw Error('测试数据库端口不可用');
    return {
      container,
      url: `postgresql://career_test:${password}@127.0.0.1:${port}/career_test`,
      close,
    };
  } catch {
    await close();
    throw Error('测试数据库初始化失败');
  }
}
