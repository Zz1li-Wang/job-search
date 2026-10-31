import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readConfig, ApiConfigSchema, AgentConfigSchema } from '@career/config';
import { HealthResponseSchema } from '@career/contracts';
import { IdempotencyRecord, IdempotencyConflictError } from '@career/business';
import { createBusinessHealthProbe } from '@career/agent-core';
import { HealthService } from '@career/observability';

const environment = {
  SERVICE_AUTH_TOKEN: 'test-service-token-'.repeat(3),
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/career_test',
  API_INTERNAL_URL: 'http://127.0.0.1:1',
  MODEL_API_KEY: 'test-model-secret',
};
describe('配置与健康契约', () => {
  it('默认端口与显式配置通过，启动拒绝错误协议及端口', () => {
    expect(readConfig(ApiConfigSchema, environment).API_PORT).toBe(3001);
    expect(readConfig(AgentConfigSchema, environment).MODEL_NAME).toBe(
      'deepseek-v4-pro',
    );
    for (const change of [
      { DATABASE_URL: 'https://wrong.example' },
      { API_PORT: '0' },
      { SERVICE_AUTH_TOKEN: 'short' },
    ])
      expect(() =>
        readConfig(ApiConfigSchema, { ...environment, ...change }),
      ).toThrow('配置无效');
  });
  it('无效配置仅暴露字段名，不含密钥或输入值', () => {
    try {
      readConfig(AgentConfigSchema, {
        ...environment,
        MODEL_BASE_URL: 'private-invalid-address',
      });
      throw Error('should reject');
    } catch (error) {
      expect(String(error)).toContain('MODEL_BASE_URL');
      expect(String(error)).not.toContain('private-invalid-address');
      expect(String(error)).not.toContain(environment.MODEL_API_KEY);
    }
    expect(
      HealthResponseSchema.safeParse({ payload: { status: 'ok' } }).success,
    ).toBe(false);
  });
  it('存活不调用依赖；依赖抛错只产生不可用状态', async () => {
    const service = new HealthService('api', [
      {
        name: 'database',
        isAvailable: async () => {
          throw Error('private database url');
        },
      },
    ]);
    expect(service.live({}).dependencies).toEqual({});
    expect(await service.ready({})).toEqual({
      service: 'api',
      status: 'unavailable',
      dependencies: { database: false },
    });
  });
  it('Agent仅访问业务健康接口，不访问模型，并拒绝伪造健康正文', async () => {
    const urls: string[] = [];
    const config = readConfig(AgentConfigSchema, environment);
    const probe = createBusinessHealthProbe(config, async (url) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          requestId: randomUUID(),
          payload: { service: 'api', status: 'ok', dependencies: {} },
        }),
      );
    });
    expect(await probe.isAvailable()).toBe(true);
    expect(urls).toEqual(['http://127.0.0.1:1/health/ready']);
    expect(
      await createBusinessHealthProbe(
        config,
        async () => new Response('{}'),
      ).isAvailable(),
    ).toBe(false);
    expect(
      await createBusinessHealthProbe(
        config,
        async () => new Response('', { status: 503 }),
      ).isAvailable(),
    ).toBe(false);
  });
});

describe('幂等领域对象', () => {
  it('重放保留首次结果，不同内容拒绝', () => {
    const record = new IdempotencyRecord({
      scope: 'test:operation',
      key: randomUUID(),
      requestHash: 'a'.repeat(64),
      responseReference: 'first',
      createdAt: new Date(),
    });
    record.assertSameRequest('a'.repeat(64));
    expect(() => record.assertSameRequest('b'.repeat(64))).toThrow(
      IdempotencyConflictError,
    );
    expect(record.snapshot().responseReference).toBe('first');
  });
  it('构造校验和快照复制维护领域不变量', () => {
    const snapshot = {
      scope: 'test',
      key: randomUUID(),
      requestHash: 'a'.repeat(64),
      responseReference: 'first',
      createdAt: new Date(),
    };
    const record = new IdempotencyRecord(snapshot);
    record.snapshot().createdAt.setFullYear(2000);
    expect(record.snapshot().createdAt.getFullYear()).not.toBe(2000);
    expect(
      () => new IdempotencyRecord({ ...snapshot, requestHash: 'bad' }),
    ).toThrow();
  });
});
