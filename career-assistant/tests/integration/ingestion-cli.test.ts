import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { executeMaintenance } from '../../apps/worker/src/cli.js';
import { makeIngestionFixture } from '../fixtures/ingestion.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function fixture() {
  const f = await makeIngestionFixture();
  cleanups.push(f.close);
  return f;
}
describe('本地维护逐命令契约', () => {
  it('OPS-01 发现输入身份和重复请求', async () => {
    const f = await fixture();
    const input = {
      sourceKey: 'zhidianmijin',
      stream: 'new',
      runId: randomUUID(),
      pageLimit: 1,
    };
    const command = (input_: unknown, actor = 'fixture_operator') =>
      executeMaintenance(f.services, 'collect discover', input_, actor);
    expect((await command(input, '')).exitCode).toBe(2);
    expect((await command({ ...input, pageLimit: 99 })).exitCode).toBe(2);
    const first = await command(input);
    expect(first.exitCode).toBe(0);
    expect(await command(input)).toEqual(first);
    expect((await command({ ...input, pageLimit: 2 })).exitCode).toBe(3);
  });
  it('OPS-02 核验拒绝无证据及过时岗位', async () => {
    const f = await fixture();
    expect(
      (
        await executeMaintenance(
          f.services,
          'evidence review',
          {},
          'fixture_operator',
        )
      ).exitCode,
    ).toBe(2);
    const result = await executeMaintenance(
      f.services,
      'evidence review',
      {
        jobId: randomUUID(),
        expectedJobVersion: randomUUID(),
        expectedReviewVersion: 0,
        evidenceVersions: [
          { resourceId: randomUUID(), versionId: randomUUID() },
        ],
        tree: { type: 'unknown', reason: '缺失', evidence: [] },
        isComplete: false,
        gaps: ['无来源'],
        conflicts: [],
        reason: '测试',
        operationKey: randomUUID(),
      },
      'fixture_operator',
    );
    expect(result.exitCode).toBe(4);
  });
  it('OPS-03 导出固定视图重放并拒绝任意路径', async () => {
    const f = await fixture();
    const result = await executeMaintenance(
      f.services,
      'data export',
      { scope: 'all', operationKey: randomUUID() },
      'fixture_operator',
    );
    expect(result.exitCode).toBe(0);
    const first = result.output as { exportId: string; manifestDigest: string };
    const repeated = await executeMaintenance(
      f.services,
      'data export',
      { existingExportId: first.exportId },
      'fixture_operator',
    );
    expect(repeated.output).toEqual(result.output);
    expect(
      (
        await executeMaintenance(
          f.services,
          'data export',
          { scope: 'all', operationKey: randomUUID(), output: '/etc/passwd' },
          'fixture_operator',
        )
      ).exitCode,
    ).toBe(2);
  });
  it('OPS-04 重试拒绝输入覆盖与不存在目标', async () => {
    const f = await fixture();
    expect(
      (
        await executeMaintenance(
          f.services,
          'task retry',
          {
            taskId: randomUUID(),
            expectedAttempt: 0,
            operationKey: randomUUID(),
            url: 'http://internal',
          },
          'fixture_operator',
        )
      ).exitCode,
    ).toBe(2);
    expect(
      (
        await executeMaintenance(
          f.services,
          'task retry',
          {
            taskId: randomUUID(),
            expectedAttempt: 0,
            operationKey: randomUUID(),
          },
          'fixture_operator',
        )
      ).exitCode,
    ).toBe(4);
  });
});
