/** 认证策略集中定义；覆盖值仅由受信装配配置提供，Entity不读取环境变量。 */
export const AUTH_POLICY = Object.freeze({
  captchaLifetimeMs: 5 * 60_000,
  sessionLifetimeMs: 7 * 24 * 60 * 60_000,
  rateWindowMs: 60_000,
  cooldownMs: 15 * 60_000,
  failureLimit: 5,
  cleanupBatchSize: 100,
  captchaAlphabet: '23456789',
  captchaLength: 6,
  scrypt: Object.freeze({
    N: 131072,
    r: 8,
    p: 1,
    maxmem: 192 * 1024 * 1024,
    saltBytes: 16,
    keyBytes: 64,
  }),
  hashParallelism: 2,
  hashQueueLimit: 16,
  limits: Object.freeze({ captcha: 30, credentials: 10, password: 10 }),
});
export type AuthPolicy = typeof AUTH_POLICY;
/** captcha=图片请求、credentials=注册登录合计、password=修改密码。 */
export type AuthRateScope = keyof typeof AUTH_POLICY.limits;
