import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { HealthService, createHealthApplication } from '@career/observability';
import { HealthResponseSchema, ErrorResponseSchema } from '@career/contracts';

const token = 'foundation-service-token-'.repeat(3);
async function withServer(
  service: 'api' | 'agent',
  run: (base: string, setAvailable: (value: boolean) => void) => Promise<void>,
  scopes: readonly string[] = ['health:read'],
) {
  let isAvailable = true;
  const app = await createHealthApplication({
    health: new HealthService(service, [
      { name: 'test_dependency', isAvailable: async () => isAvailable },
    ]),
    ...(service === 'agent' ? { authentication: { token, scopes } } : {}),
  });
  await app.listen(0, '127.0.0.1');
  try {
    await run(await app.getUrl(), (value) => {
      isAvailable = value;
    });
  } finally {
    await app.close();
  }
}

describe('健康接口逐操作契约', () => {
  it('HEALTH-01 API存活与请求标识', async () =>
    withServer('api', async (base, setAvailable) => {
      const requestId = randomUUID();
      setAvailable(false);
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(`${base}/health/live`, {
          headers: { 'x-request-id': requestId },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('x-request-id')).toBe(requestId);
        expect(
          HealthResponseSchema.parse(await response.json()).payload.status,
        ).toBe('ok');
      }
      const invalid = await fetch(`${base}/health/live?extra=value`);
      expect(invalid.status).toBe(400);
      expect(ErrorResponseSchema.parse(await invalid.json()).error.code).toBe(
        'INVALID_INPUT',
      );
    }));
  it('HEALTH-02 API就绪与依赖故障', async () =>
    withServer('api', async (base, setAvailable) => {
      expect((await fetch(`${base}/health/ready`)).status).toBe(200);
      setAvailable(false);
      const failed = await fetch(`${base}/health/ready`);
      expect(failed.status).toBe(503);
      expect(
        HealthResponseSchema.parse(await failed.json()).payload.dependencies,
      ).toEqual({ test_dependency: false });
      expect((await fetch(`${base}/health/ready?extra=value`)).status).toBe(
        400,
      );
    }));
  it('HEALTH-03 Agent存活认证与重复读取', async () =>
    withServer('agent', async (base, setAvailable) => {
      setAvailable(false);
      expect((await fetch(`${base}/health/live`)).status).toBe(401);
      expect(
        (
          await fetch(`${base}/health/live`, {
            headers: { authorization: 'Bearer wrong' },
          })
        ).status,
      ).toBe(401);
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(`${base}/health/live`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(200);
        expect(
          HealthResponseSchema.parse(await response.json()).payload.service,
        ).toBe('agent');
      }
      expect(
        (
          await fetch(`${base}/health/live?unknown=1`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(400);
    }));
  it('HEALTH-04 Agent就绪认证作用域及降级', async () => {
    await withServer('agent', async (base, setAvailable) => {
      expect((await fetch(`${base}/health/ready`)).status).toBe(401);
      expect(
        (
          await fetch(`${base}/health/ready`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(200);
      setAvailable(false);
      const response = await fetch(`${base}/health/ready`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(503);
      expect(
        HealthResponseSchema.parse(await response.json()).payload.status,
      ).toBe('unavailable');
      expect(
        (
          await fetch(`${base}/health/ready?extra=value`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(400);
    });
    await withServer(
      'agent',
      async (base) => {
        for (const path of ['live', 'ready'])
          expect(
            (
              await fetch(`${base}/health/${path}`, {
                headers: { authorization: `Bearer ${token}` },
              })
            ).status,
          ).toBe(403);
      },
      [],
    );
  });
  it('未知路径与非法请求标识返回安全契约', async () =>
    withServer('api', async (base) => {
      const response = await fetch(
        `${base}/not-existing?token=must-not-be-reflected`,
        { headers: { 'x-request-id': 'invalid-private-value' } },
      );
      expect(response.status).toBe(404);
      const body = ErrorResponseSchema.parse(await response.json());
      expect(body.error.code).toBe('NOT_FOUND');
      expect(JSON.stringify(body)).not.toContain('must-not-be-reflected');
      expect(body.requestId).not.toBe('invalid-private-value');
    }));
});

it('JSON语法错误与超限正文分别返回400和413且不泄漏内容', async () =>
  withServer('api', async (base) => {
    const invalid = await fetch(base + '/health/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"incomplete":',
    });
    expect(invalid.status).toBe(400);
    const large = await fetch(base + '/health/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(120000) }),
    });
    expect(large.status).toBe(413);
    expect(ErrorResponseSchema.parse(await large.json()).error.code).toBe(
      'REQUEST_TOO_LARGE',
    );
  }));
