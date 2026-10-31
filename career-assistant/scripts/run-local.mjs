import { spawn } from 'node:child_process';
// 各进程分别加载配置，只有Agent启动器读取模型密钥文件。
const commands = [
  ['node', 'apps/api/dist/main.js'],
  ['node', 'apps/agent/dist/main.js'],
  ['node', 'apps/worker/dist/main.js'],
  ['pnpm', '--filter', '@career/web', 'dev'],
];
let stopping = false;
const children = commands.map((args) =>
  spawn(process.execPath, ['scripts/with-env.mjs', ...args], {
    stdio: 'inherit',
    detached: true,
  }),
);
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* 进程可能已经退出。 */
    }
  }
}
for (const child of children) {
  child.once('error', () => stop(1));
  child.once('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
