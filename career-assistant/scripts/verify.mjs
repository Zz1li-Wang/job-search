import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const steps = [
  ['generate', ['pnpm', 'db:generate']],
  ['build', ['pnpm', 'build']],
  ['format', ['pnpm', 'format:check']],
  ['lint', ['pnpm', 'lint']],
  ['typecheck', ['pnpm', 'typecheck']],
  ['architecture', ['pnpm', 'check:architecture']],
  ['interfaces', ['pnpm', 'check:interfaces']],
  ['maintenance', ['pnpm', 'check:maintenance']],
  [
    'unit',
    [
      'pnpm',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.config.ts',
      '--reporter=json',
      '--outputFile=.artifacts/unit.json',
    ],
  ],
  ['integration', ['pnpm', 'test:integration']],
  ['e2e', ['pnpm', 'test:e2e']],
  ['verification', ['pnpm', 'test:verification']],
  [
    'verificationFormat',
    ['pnpm', '--prefix', 'tools/verification', 'format:check'],
  ],
  ['verificationLint', ['pnpm', '--prefix', 'tools/verification', 'lint']],
  [
    'verificationTypes',
    ['pnpm', '--prefix', 'tools/verification', 'typecheck'],
  ],
  ['gitWhitespace', ['git', 'diff', '--check']],
  ['gitStagedWhitespace', ['git', 'diff', '--cached', '--check']],
];
const ledgers = [
  'docs/verification/model-request-ledger.jsonl',
  'docs/verification/source-session-request-ledger.jsonl',
  'docs/verification/source-association-request-ledger.jsonl',
];
const digest = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const before = await Promise.all(ledgers.map(digest));
const report = {
  startedAt: new Date().toISOString(),
  steps: [],
  externalRequestLedgersUnchanged: false,
};
await mkdir('.artifacts/check-logs', { recursive: true });
for (const [name, [command, ...arguments_]] of steps) {
  const started = performance.now();
  const child = spawn(command, arguments_, {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  const exitCode = await new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
  await writeFile(`.artifacts/check-logs/${name}.log`, output);
  report.steps.push({
    name,
    command: [command, ...arguments_],
    exitCode,
    durationMs: Math.round(performance.now() - started),
  });
  await writeFile(
    '.artifacts/checks.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(`${name}: ${exitCode === 0 ? 'passed' : 'failed'}`);
  if (exitCode !== 0) {
    console.log(output.slice(-6000));
    process.exitCode = 1;
    break;
  }
}
const after = await Promise.all(ledgers.map(digest));
report.externalRequestLedgersUnchanged = before.every(
  (hash, index) => hash === after[index],
);
report.endedAt = new Date().toISOString();
if (!report.externalRequestLedgersUnchanged) process.exitCode = 1;
await writeFile(
  '.artifacts/checks.json',
  JSON.stringify(report, null, 2) + '\n',
);
