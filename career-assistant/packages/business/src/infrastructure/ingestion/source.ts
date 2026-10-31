import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { createRequire } from 'node:module';
const robotsParser: (
  url: string,
  text: string,
) => {
  isAllowed(url: string, agent: string): boolean | undefined;
  getCrawlDelay(agent: string): number | undefined;
} = createRequire(import.meta.url)('robots-parser');
import { setTimeout as pause } from 'node:timers/promises';
import { IngestionError } from '../../domain/ingestion/errors.js';
import { INGESTION_POLICY as policy } from '../../domain/ingestion/policy.js';
import type {
  IngestionDependencies,
  SourceReader,
} from '../../application/ingestion/ports.js';
import { parseEvidenceHtml, parseListHtml } from './html.js';

export interface SourceResponse {
  status: number;
  location?: string | undefined;
  retryAfter?: string | undefined;
  body: string;
}
export interface SourceTransport {
  get(url: URL, cookie?: string): Promise<SourceResponse>;
}
export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export function validateSourceUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IngestionError('SOURCE_ACCESS_BLOCKED');
  }
  if (
    url.origin !== policy.origin ||
    url.username ||
    url.password ||
    !/^\/(?:robots\.txt|jobs(?:\/[A-Za-z0-9_-]{1,200})?|announcements\/[A-Za-z0-9_-]{1,200})$/.test(
      url.pathname,
    )
  )
    throw new IngestionError('SOURCE_ACCESS_BLOCKED');
  for (const [key, value_] of url.searchParams) {
    if (
      url.pathname !== '/jobs' ||
      !['sort', 'direction', 'page'].includes(key) ||
      (key === 'sort' && value_ !== 'latest') ||
      (key === 'direction' && value_ !== 'desc') ||
      (key === 'page' && !/^[1-9]\d{0,6}$/.test(value_))
    )
      throw new IngestionError('SOURCE_ACCESS_BLOCKED');
  }
  return url;
}
/** DNS结果绑定实际连接，TLS仍校验原始主机；不使用任意代理或重定向Cookie。 */
export class PublicHttpsTransport implements SourceTransport {
  async get(url: URL, cookie?: string): Promise<SourceResponse> {
    const signal = AbortSignal.timeout(policy.requestTimeoutMs);
    const addresses = await Promise.race([
      lookup(url.hostname, { all: true }),
      new Promise<never>((_, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(new IngestionError('SOURCE_UNAVAILABLE')),
          { once: true },
        ),
      ),
    ]);
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
      throw new IngestionError('SOURCE_ACCESS_BLOCKED');
    const address = addresses[0]!;
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'GET',
          agent: false,
          family: address.family,
          lookup: (_host, _options, callback) =>
            callback(null, address.address, address.family),
          signal,
          headers: {
            'user-agent': 'CareerAssistant/0.2',
            accept: 'text/html,text/plain',
            'accept-encoding': 'identity',
            ...(cookie ? { cookie } : {}),
          },
        },
        (response) => {
          void (async () => {
            const status = response.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              response.resume();
              resolve({
                status,
                location: response.headers.location,
                body: '',
              });
              return;
            }
            const encoding = response.headers['content-encoding'];
            const stream =
              encoding === 'gzip'
                ? response.pipe(createGunzip())
                : encoding === 'deflate'
                  ? response.pipe(createInflate())
                  : encoding === 'br'
                    ? response.pipe(createBrotliDecompress())
                    : response;
            let size = 0;
            const chunks: Buffer[] = [];
            try {
              for await (const chunk of stream) {
                const bytes = Buffer.isBuffer(chunk)
                  ? chunk
                  : Buffer.from(chunk as Uint8Array);
                size += bytes.length;
                if (size > policy.maxBytes) {
                  response.destroy();
                  throw new IngestionError('SOURCE_PARSE_UNSUPPORTED');
                }
                chunks.push(bytes);
              }
              const contentType = response.headers['content-type'] ?? '';
              if (
                status === 200 &&
                !/text\/(html|plain)|application\/xhtml\+xml/i.test(contentType)
              )
                throw new IngestionError('SOURCE_PARSE_UNSUPPORTED');
              resolve({
                status,
                retryAfter: response.headers['retry-after'],
                body: new TextDecoder('utf-8', { fatal: true }).decode(
                  Buffer.concat(chunks),
                ),
              });
            } catch (error) {
              req.destroy();
              reject(
                error instanceof IngestionError
                  ? error
                  : new IngestionError('SOURCE_UNAVAILABLE'),
              );
            }
          })().catch(reject);
        },
      );
      req.on('error', () => reject(new IngestionError('SOURCE_UNAVAILABLE')));
      req.end();
    });
  }
}
export interface NetworkSettings {
  enabled: boolean;
  budgetId: string;
  requestLimit: number;
  cookie?: string;
}
/** 每一跳独立获取主机许可和持久化预算；认证HTML仅在解析栈内存活。 */
export function createSourceReader(
  dependencies: Pick<IngestionDependencies, 'unitOfWork' | 'repositories'>,
  settings: NetworkSettings,
  transport: SourceTransport = new PublicHttpsTransport(),
): SourceReader {
  const repository = dependencies.repositories;
  const run = dependencies.unitOfWork.run.bind(dependencies.unitOfWork);
  async function send(
    url: URL,
    cookie?: string,
    gap: number = policy.requestGapMs,
  ): Promise<SourceResponse> {
    if (!settings.enabled) throw new IngestionError('SOURCE_ACCESS_BLOCKED');
    const owner = randomUUID();
    // 许可等待不持有事务；预算在拿到许可后、实际请求前单调预留。
    for (;;) {
      const allowed = await run(async (c) => {
        const repo = repository(c);
        return repo.reservePermit(url.hostname, owner, await repo.now(), gap);
      });
      if (allowed) break;
      await pause(50);
    }
    try {
      const allowed = await run((c) =>
        repository(c).reserveBudget(settings.budgetId, settings.requestLimit),
      );
      if (!allowed) throw new IngestionError('SOURCE_BUDGET_EXHAUSTED');
      return await transport.get(url, cookie);
    } finally {
      await run((c) => repository(c).releasePermit(owner));
    }
  }
  async function robots() {
    const cached = await run((c) => repository(c).readRobots());
    if (
      cached &&
      Date.now() - new Date(cached.fetchedAt).getTime() < policy.refreshMs
    )
      return robotsParser(policy.origin + '/robots.txt', cached.text);
    const response = await send(
      validateSourceUrl(policy.origin + '/robots.txt'),
    );
    if (response.status !== 200 && response.status !== 404)
      throw new IngestionError('SOURCE_ACCESS_BLOCKED');
    const body = response.status === 404 ? '' : response.body;
    if (body.includes('<html'))
      throw new IngestionError('SOURCE_ACCESS_BLOCKED');
    await run(async (c) => {
      const repo = repository(c);
      await repo.saveRobots(body, await repo.now());
    });
    return robotsParser(policy.origin + '/robots.txt', body);
  }
  async function read(url: URL) {
    const rules = await robots();
    let current = url;
    for (let hop = 0; hop <= policy.maxRedirects; hop++) {
      if (rules.isAllowed(current.href, 'CareerAssistant') === false)
        throw new IngestionError('SOURCE_ACCESS_BLOCKED');
      const delay = Math.max(
        policy.requestGapMs,
        (rules.getCrawlDelay('CareerAssistant') ?? 0) * 1000,
      );
      const response = await send(
        current,
        hop === 0 && current.pathname === '/jobs' ? settings.cookie : undefined,
        delay,
      );
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.location
      ) {
        current = validateSourceUrl(new URL(response.location, current).href);
        continue;
      }
      if ([401, 403].includes(response.status))
        throw new IngestionError('SOURCE_ACCESS_BLOCKED');
      if (response.status === 429) {
        const seconds = Number(response.retryAfter);
        const milliseconds = Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(response.retryAfter ?? '') - Date.now();
        throw new IngestionError(
          'SOURCE_RATE_LIMITED',
          Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 5000,
        );
      }
      if (response.status >= 500 || response.status === 0)
        throw new IngestionError('SOURCE_UNAVAILABLE');
      if (response.status !== 200)
        throw new IngestionError('SOURCE_PARSE_UNSUPPORTED');
      return response;
    }
    throw new IngestionError('SOURCE_ACCESS_BLOCKED');
  }
  return {
    async list(page) {
      const url = validateSourceUrl(
        page === 1
          ? `${policy.origin}/jobs`
          : `${policy.origin}/jobs?sort=latest&direction=desc&page=${page}`,
      );
      const response = await read(url);
      return parseListHtml(response.body, page, new Date());
    },
    async evidence(kind, id) {
      const url = validateSourceUrl(
        `${policy.origin}/${kind === 'job' ? 'jobs' : 'announcements'}/${id}`,
      );
      const response = await read(url);
      return parseEvidenceHtml(response.body, new Date(), response.status);
    },
  };
}
