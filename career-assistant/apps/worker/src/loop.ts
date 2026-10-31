import type { IngestionServices } from '@career/business';
/** 生产与进程E2E共用同一执行循环，关闭时停止领取并等待在途执行。 */
export async function startSourceWorker(
  services: IngestionServices,
  options: { isEnabled: boolean; onError(): void; onHeartbeat(): void },
) {
  let stopping = false;
  let running: Promise<void> | null = null;
  let maintenance: Promise<unknown> | null = null;
  async function tick() {
    if (stopping || running || !options.isEnabled) return;
    running = (async () => {
      await services.scheduler.execute();
      await Promise.all([
        services.execution.runOne(),
        services.execution.runOne(),
      ]);
    })()
      .catch(options.onError)
      .finally(() => {
        running = null;
      });
    await running;
  }
  const heartbeat = setInterval(options.onHeartbeat, 30000);
  const timer = setInterval(() => void tick(), 500);
  const cleanup = setInterval(() => {
    if (maintenance) return;
    maintenance = services.maintenance
      .execute()
      .catch(options.onError)
      .finally(() => {
        maintenance = null;
      });
  }, 60000);
  await tick();
  return {
    async close() {
      stopping = true;
      clearInterval(timer);
      clearInterval(heartbeat);
      clearInterval(cleanup);
      if (running) await running;
      if (maintenance) await maintenance;
    },
  };
}
