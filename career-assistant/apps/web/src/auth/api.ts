import { ErrorResponseSchema } from '@career/contracts';

export class AuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
/** 浏览器只调用同源API；凭据由HttpOnly Cookie携带，不读取或保存会话令牌。 */
export async function authRequest<T>(
  path: string,
  schema: { parse(input: unknown): T },
  options: { method?: string; body?: unknown; csrfToken?: string } = {},
): Promise<T> {
  const response = await fetch(`/api/v1/auth/${path}`, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      ...(options.body !== undefined
        ? { 'content-type': 'application/json' }
        : {}),
      ...(options.csrfToken ? { 'x-csrf-token': options.csrfToken } : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  if (!response.ok) {
    const parsed = ErrorResponseSchema.safeParse(await response.json());
    throw new AuthApiError(
      response.status,
      parsed.success ? parsed.data.error.code : 'UNKNOWN',
      parsed.success ? parsed.data.error.message : '请求暂时无法完成',
    );
  }
  if (response.status === 204) return schema.parse(undefined);
  return schema.parse(await response.json());
}
export const EmptyResponse = {
  parse: (_input: unknown): undefined => undefined,
};
