import { EXECUTION_POLICY } from '@career/contracts';
import type { AgentClient } from '../../application/chat/ports.js';
/** 网络失败意味着执行结果未知，上层只标记中断，绝不自动重复推理。 */
export function createAgentClient(
  baseUrl: string,
  serviceToken: string,
  send: typeof fetch = fetch,
): AgentClient {
  return {
    async dispatch(input) {
      const response = await send(new URL('/internal/v1/runs', baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(EXECUTION_POLICY.dispatchTimeoutMs),
        redirect: 'error',
      });
      await response.body?.cancel();
      if (response.status !== 202) throw Error('Agent派发未确认');
    },
    async cancel(runId) {
      const response = await send(
        new URL(`/internal/v1/runs/${runId}/cancel`, baseUrl),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${serviceToken}` },
          signal: AbortSignal.timeout(EXECUTION_POLICY.cancelTimeoutMs),
          redirect: 'error',
        },
      );
      await response.body?.cancel();
      if (!response.ok) throw Error('取消未确认');
    },
  };
}
