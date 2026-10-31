import {
  ApiConfigSchema,
  readConfig,
  ConfigurationError,
  AuthConfigSchema,
} from '@career/config';
import { createSafeLogger } from '@career/observability';
import { createApiApplication } from './app.js';

async function main() {
  const config = readConfig(ApiConfigSchema, process.env);
  const runtime = await createApiApplication({
    api: config,
    auth: readConfig(AuthConfigSchema, process.env),
  });
  const app = runtime.app;
  await app.listen(config.API_PORT, process.env.SERVER_HOST ?? '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      void runtime.close().then(() => process.exit(0));
    });
}
main().catch((error: unknown) => {
  createSafeLogger('api').error(
    error instanceof ConfigurationError
      ? error.message
      : '启动失败，请检查配置和依赖',
  );
  process.exitCode = 1;
});
