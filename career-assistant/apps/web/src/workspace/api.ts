export class WorkspaceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function workspaceRequest<T>(
  path: string,
  schema: { parse(value: unknown): T },
  options: {
    method?: string;
    body?: unknown;
    csrf?: string;
    key?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const response = await fetch('/api/v1' + path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      ...(options.body !== undefined
        ? { 'content-type': 'application/json' }
        : {}),
      ...(options.csrf ? { 'x-csrf-token': options.csrf } : {}),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (response.status === 204) return schema.parse(undefined);
  const content: unknown = await response.json();
  if (!response.ok) {
    const error =
      content && typeof content === 'object' && 'error' in content
        ? content.error
        : null;
    throw new WorkspaceApiError(
      response.status,
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'UNKNOWN',
      error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : '请求失败，请稍后重试',
    );
  }
  return schema.parse(
    content && typeof content === 'object' && 'payload' in content
      ? content.payload
      : undefined,
  );
}
export const VoidResponse = {
  parse: (_value: unknown): undefined => undefined,
};
