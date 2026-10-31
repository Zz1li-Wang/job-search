import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { availablePort } from '@career/testing';
const privateValues = [];
const redact = (text) =>
  privateValues.reduce(
    (value, secret) => value.replaceAll(secret, '[REDACTED]'),
    String(text),
  );
const execute = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'career-delivery-')),
  project = 'career-delivery-' + randomUUID().slice(0, 8),
  httpsPort = await availablePort(),
  httpPort = await availablePort(),
  envFile = join(directory, 'environment'),
  backupDirectory = join(directory, 'backups');
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  CAREER_ENV_FILE: envFile,
};
const compose = ['compose', '--env-file', envFile, '-f', 'deploy/compose.yml'];
const report = {
  startedAt: new Date().toISOString(),
  project,
  checks: [],
  externalModelCalls: 0,
  externalSourceCalls: 0,
  success: false,
};
async function docker(args) {
  return execute('docker', [...compose, ...args], {
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
}
function http(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: '127.0.0.1',
        servername: 'localhost',
        port: httpsPort,
        path,
        method,
        rejectUnauthorized: false,
        headers: { host: 'localhost' },
        timeout: 5000,
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, body }),
        );
      },
    );
    request.on('error', reject);
    request.on('timeout', () => request.destroy(Error('timeout')));
    request.end();
  });
}
async function ready() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await http('/health/ready')).status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Error('容器服务未就绪');
}
function assert(condition, label) {
  if (!condition) throw Error(label);
  report.checks.push(label);
}
try {
  const secret = () => {
    const value = randomBytes(32).toString('hex');
    privateValues.push(value);
    return value;
  };
  await writeFile(
    envFile,
    Object.entries({
      POSTGRES_PASSWORD: secret(),
      SERVICE_AUTH_TOKEN: secret(),
      AUTH_TOKEN_PEPPER: secret(),
      AUTH_CSRF_SECRET: secret(),
      AUTH_PUBLIC_ORIGIN: `https://localhost:${httpsPort}`,
      PUBLIC_HOST: 'localhost',
      MODEL_API_KEY: 'local-check-no-inference',
      MODEL_BASE_URL: 'http://127.0.0.1:9',
      CAREER_IMAGE: 'career-assistant:batch-check',
      CAREER_WEB_IMAGE: 'career-assistant-web:batch-check',
      HTTP_BIND: '127.0.0.1',
      HTTPS_BIND: '127.0.0.1',
      HTTP_PORT: httpPort,
      HTTPS_PORT: httpsPort,
      NODE_ENV: 'production',
    })
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    { mode: 0o600 },
  );
  await docker(['config', '--quiet']);
  assert(true, 'Compose生产配置校验');
  await docker(['up', '-d', '--no-build', '--wait', '--wait-timeout', '120']);
  await ready();
  assert((await http('/')).status === 200, 'HTTPS静态前端');
  const health = await http('/health/ready');
  assert(
    health.status === 200 && JSON.parse(health.body).payload.status === 'ok',
    'API及全部持久化迁移就绪',
  );
  assert((await http('/internal/v1/runs')).status === 404, '公网内部入口拒绝');
  assert((await http('/mcp', 'POST')).status === 404, '公网MCP入口拒绝');
  const captcha = await http('/api/v1/auth/captcha');
  assert(
    captcha.status === 200 &&
      JSON.parse(captcha.body).payload.imageDataUrl.startsWith(
        'data:image/png;base64,',
      ),
    '真实生产验证码入口',
  );
  const documents = await docker([
    'exec',
    '-T',
    'api',
    'node',
    '--input-type=module',
    '-e',
    "import{extractDocument}from'@career/business';import{fictionalPdf,fictionalDocx}from'@career/testing';const pdf=await extractDocument(fictionalPdf(),'pdf'),docx=await extractDocument(fictionalDocx(),'docx');if(pdf[0]?.text!=='TypeScript'||docx[0]?.text!=='TypeScript')process.exit(1);process.stdout.write('document-adapters-ok');",
  ]);
  assert(
    documents.stdout.trim() === 'document-adapters-ok',
    '生产镜像PDF与DOCX真实提取',
  );
  const marker = randomUUID();
  await docker([
    'exec',
    '-T',
    'database',
    'psql',
    '-U',
    'career',
    '-d',
    'career',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `INSERT INTO audit_events(id,actor_reference,action,occurred_at) VALUES('${marker}','deployment-test','persistence-check',NOW())`,
  ]);
  await docker([
    'exec',
    '-T',
    'api',
    'node',
    '--input-type=module',
    '-e',
    `import{writeFile}from'node:fs/promises';await writeFile('/app/var/private/${marker}','deployment-private-volume-check',{mode:0o600});`,
  ]);
  await docker(['restart', 'api']);
  await ready();
  const shared = await docker([
    'exec',
    '-T',
    'worker',
    'node',
    '--input-type=module',
    '-e',
    `import{readFile}from'node:fs/promises';process.stdout.write(await readFile('/app/var/private/${marker}','utf8'));`,
  ]);
  assert(
    shared.stdout === 'deployment-private-volume-check',
    'API重启与Worker共享私有持久卷',
  );
  await docker(['stop', 'web', 'worker', 'agent', 'api']);
  await execute('sh', ['deploy/backup.sh', backupDirectory], {
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  const backups = await readdir(backupDirectory),
    dbDump = backups.find((f) => f.endsWith('.dump')),
    files = backups.find((f) => f.endsWith('.tar.gz'));
  assert(!!dbDump && !!files, '一致窗口数据库与文件备份');
  await docker([
    'exec',
    '-T',
    'database',
    'psql',
    '-U',
    'career',
    '-d',
    'career',
    '-c',
    `DELETE FROM audit_events WHERE id='${marker}'`,
  ]);
  await execute(
    'sh',
    [
      'deploy/restore.sh',
      join(backupDirectory, dbDump),
      join(backupDirectory, files),
    ],
    { env, maxBuffer: 10 * 1024 * 1024 },
  );
  await ready();
  const restored = await docker([
    'exec',
    '-T',
    'database',
    'psql',
    '-U',
    'career',
    '-d',
    'career',
    '-tAc',
    `SELECT COUNT(*) FROM audit_events WHERE id='${marker}'`,
  ]);
  assert(restored.stdout.trim() === '1', '备份恢复后数据库标记存在');
  const restoredFile = await docker([
    'exec',
    '-T',
    'api',
    'node',
    '--input-type=module',
    '-e',
    `import{readFile}from'node:fs/promises';process.stdout.write(await readFile('/app/var/private/${marker}','utf8'));`,
  ]);
  assert(
    restoredFile.stdout === 'deployment-private-volume-check',
    '备份恢复后私有文件存在',
  );
  const overrideFile = join(directory, 'restore-override.yml');
  await writeFile(overrideFile, 'services: {}\n');
  await execute(
    'sh',
    [
      'deploy/restore.sh',
      join(backupDirectory, dbDump),
      join(backupDirectory, files),
    ],
    {
      env: { ...env, CAREER_COMPOSE_OVERRIDE: overrideFile },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const runningAfterRestore = await docker([
    'ps',
    '--status',
    'running',
    '--services',
  ]);
  const servicesAfterRestore = runningAfterRestore.stdout.trim().split('\n');
  assert(
    servicesAfterRestore.includes('database') &&
      ['api', 'agent', 'worker', 'web'].every(
        (service) => !servicesAfterRestore.includes(service),
      ),
    '服务器覆盖配置恢复后保持业务停止以核对额度和删除屏障',
  );
  report.success = true;
} catch (error) {
  report.error =
    error instanceof Error
      ? error.message.split('\n')[0].slice(0, 200)
      : '容器验证失败';
  report.detail = redact(error?.stderr ?? '').slice(-2000);
  try {
    const logs = await docker([
      'logs',
      '--tail',
      '8',
      'migrate',
      'api',
      'agent',
      'worker',
      'web',
    ]);
    await writeFile(
      '.artifacts/deployment-debug.log',
      redact(logs.stdout + '\n' + logs.stderr),
    );
  } catch {}
  process.exitCode = 1;
} finally {
  try {
    await docker(['down', '--volumes', '--remove-orphans']);
    report.cleanupSucceeded = true;
  } catch {
    report.cleanupSucceeded = false;
    process.exitCode = 1;
  }
  await rm(directory, { recursive: true, force: true });
  report.endedAt = new Date().toISOString();
  await mkdir('.artifacts', { recursive: true });
  await writeFile(
    '.artifacts/deployment.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
}
