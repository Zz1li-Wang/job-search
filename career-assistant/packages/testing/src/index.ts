import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { createServer } from 'node:net';

export async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('无法分配测试端口');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

/** 子进程输出只在内存中用于断言，禁止将完整私有环境写入失败报告。 */
export function startProcess(
  entry: string,
  environment: NodeJS.ProcessEnv,
  arguments_: string[] = [],
) {
  const child = spawn(process.execPath, [entry, ...arguments_], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output += String(chunk);
  });
  return { child, output: () => output };
}
export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  child.kill('SIGTERM');
  const timer = globalThis.setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}
export async function waitForHealth(
  url: string,
  token?: string,
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(500),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      /* 服务仍在启动，只轮询本地存活，不调用模型或来源。 */
    }
    await setTimeout(100);
  }
  throw Error('本地测试服务未在期限内启动');
}
export * from './documents.js';
