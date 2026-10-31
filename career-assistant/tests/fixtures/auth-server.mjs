import { ApiConfigSchema, AuthConfigSchema, readConfig } from '@career/config';
import { createApiApplication } from '../../apps/api/dist/app.js';

if (
  process.env.TEST_DATABASE_ISOLATED !== 'true' ||
  new URL(process.env.DATABASE_URL).pathname !== '/career_test'
)
  throw Error('仅允许隔离数据库测试进程');
let currentTime = Date.now();
const clock = { now: () => new Date(currentTime) };
const runtime = await createApiApplication(
  {
    api: readConfig(ApiConfigSchema, process.env),
    auth: readConfig(AuthConfigSchema, process.env),
  },
  { clock, answer: () => '234567' },
);
await runtime.app.listen(Number(process.env.API_PORT), '127.0.0.1');
let chatTask = null;
const chatTimer =
  process.env.TEST_CHAT_DISPATCH === 'true'
    ? setInterval(() => {
        if (!chatTask)
          chatTask = Promise.all([
            runtime.chatServices.dispatcher.tick(),
            runtime.resumeServices.worker.tick(),
          ]).finally(() => {
            chatTask = null;
          });
      }, 150)
    : null;
process.send?.({ type: 'ready' });
process.on('message', (message) => {
  if (
    message &&
    typeof message === 'object' &&
    message.type === 'advance' &&
    Number.isSafeInteger(message.milliseconds) &&
    message.milliseconds >= 0
  ) {
    currentTime += message.milliseconds;
    process.send?.({ type: 'advanced' });
  }
});
let isClosing = false;
async function close() {
  if (isClosing) return;
  isClosing = true;
  if (chatTimer) clearInterval(chatTimer);
  if (chatTask) await chatTask;
  await runtime.close();
  process.exit(0);
}
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
process.once('disconnect', () => void close());
