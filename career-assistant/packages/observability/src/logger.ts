import pino, { type DestinationStream } from 'pino';

/** 仅记录允许的运行事实；请求正文、异常对象和凭据不进入通用日志。 */
export function createSafeLogger(
  service: string,
  destination?: DestinationStream,
) {
  return pino(
    {
      base: { service },
      redact: {
        paths: [
          'authorization',
          'cookie',
          'password',
          'apiKey',
          'token',
          'headers',
          'body',
          'err',
        ],
        censor: '[REDACTED]',
      },
    },
    destination,
  );
}
