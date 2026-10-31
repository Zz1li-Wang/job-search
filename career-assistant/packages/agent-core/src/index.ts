import type { AgentConfig } from '@career/config';

/** 基础就绪只检查配置和业务服务，不推理、不虚构MCP工具已经实现。 */
export function createBusinessHealthProbe(
  config: AgentConfig,
  send: typeof fetch = fetch,
) {
  return {
    name: 'business_api',
    async isAvailable(): Promise<boolean> {
      const response = await send(
        new URL('/health/ready', config.API_INTERNAL_URL),
        { redirect: 'manual', signal: AbortSignal.timeout(2000) },
      );
      if (!response.ok) {
        await response.body?.cancel();
        return false;
      }
      const { HealthResponseSchema } = await import('@career/contracts');
      const parsed = HealthResponseSchema.safeParse(await response.json());
      return (
        parsed.success &&
        parsed.data.payload.service === 'api' &&
        parsed.data.payload.status === 'ok'
      );
    },
  };
}
export * from './runtime.js';
export * from './extraction.js';
