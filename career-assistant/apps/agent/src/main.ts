import {
  AgentConfigSchema,
  readConfig,
  ConfigurationError,
} from '@career/config';
import { createAgentApplication } from './app.js';
import { createSafeLogger } from '@career/observability';

async function main() {
  const config = readConfig(AgentConfigSchema, process.env);
  const runtime = await createAgentApplication(config);
  const app = runtime.app;
  await app.listen(config.AGENT_PORT, process.env.SERVER_HOST ?? '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      void runtime.close().then(() => process.exit(0));
    });
}
main().catch((error: unknown) => {
  createSafeLogger('agent').error(
    error instanceof ConfigurationError
      ? error.message
      : '启动失败，请检查配置和依赖',
  );
  process.exitCode = 1;
});
