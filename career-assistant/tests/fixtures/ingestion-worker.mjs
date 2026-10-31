import { createIngestionRuntime, createSourceReader } from '@career/business';
import { startSourceWorker } from '../../apps/worker/dist/loop.js';
if (
  process.env.TEST_DATABASE_ISOLATED !== 'true' ||
  new URL(process.env.DATABASE_URL).pathname !== '/career_test'
)
  throw Error('仅隔离测试库');
const base = new URL(process.env.INGESTION_FIXTURE_URL);
if (base.hostname !== '127.0.0.1') throw Error('测试来源必须为本地替身');
const runtime = createIngestionRuntime({
  databaseUrl: process.env.DATABASE_URL,
  privateRoot: process.env.PRIVATE_FILE_ROOT,
  exportRoot: process.env.INGESTION_EXPORT_ROOT,
  operatorReference: 'fixture_operator',
  network: { enabled: false, budgetId: 'fixture', requestLimit: 40 },
});
// 仅HTTP传输改为本地替身，生产的robots/预算/分类/解析全部保留。
runtime.dependencies.source = createSourceReader(
  runtime.dependencies,
  { enabled: true, budgetId: 'fixture', requestLimit: 40 },
  {
    async get(url, cookie) {
      const response = await fetch(new URL(url.pathname + url.search, base), {
        headers: cookie ? { cookie } : {},
        redirect: 'manual',
      });
      return {
        status: response.status,
        body: await response.text(),
        ...(response.headers.get('location')
          ? { location: response.headers.get('location') }
          : {}),
        ...(response.headers.get('retry-after')
          ? { retryAfter: response.headers.get('retry-after') }
          : {}),
      };
    },
  },
);
const loop = await startSourceWorker(runtime.services, {
  isEnabled: true,
  onError: () => process.send?.({ type: 'error' }),
  onHeartbeat: () => {},
});
process.send?.({ type: 'ready' });
process.on('message', (message) => {
  if (message?.type === 'close')
    void loop
      .close()
      .then(runtime.close)
      .then(() => process.disconnect());
});
