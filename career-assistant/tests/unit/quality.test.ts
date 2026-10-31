import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSafeLogger } from '@career/observability';
// 工程检查脚本与测试使用同一检查器，禁止只测试一份重复实现。
import {
  validateImport,
  checkArchitecture,
} from '../../scripts/check-architecture.mjs';
import { checkInterfaces } from '../../scripts/check-interfaces.mjs';

describe('架构和日志质量门禁', () => {
  it('正确边界通过，静态和动态导入共用规则', async () => {
    expect(await checkArchitecture()).toBeGreaterThan(15);
    expect(
      validateImport('packages/agent-core/src/index.ts', '@career/business'),
    ).toBeTruthy();
    expect(
      validateImport('apps/web/src/index.ts', '@career/business'),
    ).toBeTruthy();
    expect(
      validateImport(
        'packages/business/src/application/x.ts',
        '../infrastructure/persistence.js',
      ),
    ).toBeTruthy();
    expect(
      validateImport(
        'apps/api/src/index.ts',
        '../../../packages/business/src/index.js',
      ),
    ).toBeTruthy();
    expect(
      validateImport('apps/api/src/index.ts', '@prisma/client'),
    ).toBeTruthy();
    expect(
      validateImport('packages/business/src/domain/x.ts', 'pg'),
    ).toBeTruthy();
  });
  it('已实现接口均有关联测试', async () => {
    const registry = JSON.parse(
      await readFile('tests/interface-registry.json', 'utf8'),
    ) as unknown[];
    expect(await checkInterfaces()).toBe(registry.length);
  });
  it('新增接口漏登记时质量检查失败，不能仅靠清单自身完整', async () => {
    const root = await mkdtemp(join(tmpdir(), 'career-interface-'));
    try {
      const { cp } = await import('node:fs/promises');
      for (const directory of ['apps', 'packages', 'tests'])
        await cp(directory, join(root, directory), {
          recursive: true,
          filter: (source) =>
            !source
              .split('/')
              .some((part) =>
                ['node_modules', 'dist', 'generated'].includes(part),
              ),
        });
      const registry = JSON.parse(
        await readFile('tests/interface-registry.json', 'utf8'),
      ) as { id: string }[];
      await writeFile(
        join(root, 'tests/interface-registry.json'),
        JSON.stringify(registry.filter((entry) => entry.id !== 'HEALTH-04')),
      );
      await expect(checkInterfaces(root)).rejects.toThrow('未关联测试');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('日志不输出敏感头、正文或异常详情', () => {
    let output = '';
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const logger = createSafeLogger('test', stream);
    logger.info(
      {
        cookie: 'private-cookie',
        authorization: 'private-auth',
        apiKey: 'private-key',
        headers: { secret: 'private-header' },
        body: { text: 'private-resume' },
        err: Error('private-database-url'),
        requestId: 'public-reference',
      },
      'request_completed',
    );
    for (const secret of [
      'private-cookie',
      'private-auth',
      'private-key',
      'private-header',
      'private-resume',
      'private-database-url',
    ])
      expect(output).not.toContain(secret);
    expect(output).toContain('public-reference');
  });
});
