import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';

const environment = { ...process.env };
const [command, ...arguments_] = process.argv.slice(2);
if (!command) throw Error('缺少启动命令');
const files = ['.env'];
if (arguments_.includes('apps/agent/dist/main.js'))
  files.push('tools/verification/.env.verification');
for (const name of files) {
  try {
    for (const [key, value] of Object.entries(
      parseEnv(readFileSync(name, 'utf8')),
    )) {
      if (!environment[key]) environment[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw Error('私有配置无法读取');
  }
}
const child = spawn(command, arguments_, {
  env: environment,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => child.kill(signal));
child.once('error', () => {
  console.error('命令无法启动');
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
