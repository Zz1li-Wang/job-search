import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5';
import { createHash } from 'node:crypto';
import { IngestionError } from '../../domain/ingestion/errors.js';
import { INGESTION_POLICY } from '../../domain/ingestion/policy.js';
import { BodyStateSchema } from '../../domain/ingestion/source.js';
import type {
  FetchedList,
  FetchedEvidence,
} from '../../application/ingestion/ports.js';

const omitted = new Set([
  'script',
  'style',
  'form',
  'input',
  'button',
  'nav',
  'footer',
  'header',
  'aside',
  'svg',
  'template',
]);
function children(node: Tree.Node): Tree.ChildNode[] {
  return 'childNodes' in node ? node.childNodes : [];
}
function elements(node: Tree.Node): Tree.Element[] {
  return [
    ...('tagName' in node ? [node] : []),
    ...children(node).flatMap(elements),
  ];
}
function attr(node: Tree.Element, name: string): string | undefined {
  return node.attrs.find((attribute) => attribute.name === name)?.value;
}
function text(node: Tree.Node): string {
  if ('tagName' in node && omitted.has(node.tagName)) return '';
  return ('value' in node ? node.value : children(node).map(text).join(' '))
    .replace(/\s+/g, ' ')
    .trim();
}
function document(html: string) {
  const nodes = elements(parse(html));
  const main = nodes.find((n) => n.tagName === 'main');
  const title =
    nodes.find((n) => n.tagName === 'h1') ??
    nodes.find((n) => n.tagName === 'title');
  const heading = title ? text(title) : '';
  if (
    /登录后查看|请先登录|登录后继续|^登录$|验证码|会员专享|订阅后查看/.test(
      heading,
    )
  )
    throw new IngestionError('SOURCE_ACCESS_BLOCKED');
  if (!main || !heading) throw new IngestionError('SOURCE_PARSE_UNSUPPORTED');
  return { main, heading, nodes: elements(main) };
}
export function normalizeSourceLink(value: string): {
  kind: 'job' | 'announcement' | 'external';
  sourceId: string | null;
  url: string;
} | null {
  try {
    const url = new URL(value, INGESTION_POLICY.origin);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const match = /^\/(jobs|announcements)\/([A-Za-z0-9_-]{1,200})\/?$/.exec(
      url.pathname,
    );
    url.search = '';
    url.hash = '';
    if (url.origin === INGESTION_POLICY.origin) {
      if (!match) return null;
      return {
        kind: match[1] === 'jobs' ? 'job' : 'announcement',
        sourceId: match[2]!,
        url: url.href,
      };
    }
    return { kind: 'external', sourceId: null, url: url.href };
  } catch {
    return null;
  }
}
export function parseListHtml(
  html: string,
  page: number,
  fetchedAt: Date,
): FetchedList {
  const doc = document(html);
  const anchors = doc.nodes.filter((n) => n.tagName === 'a');
  const jobIds = [
    ...new Set(
      anchors.flatMap((n) => {
        const link = normalizeSourceLink(attr(n, 'href') ?? '');
        return link?.kind === 'job' && link.sourceId ? [link.sourceId] : [];
      }),
    ),
  ];
  const pages = anchors.flatMap((n) => {
    try {
      const url = new URL(attr(n, 'href') ?? '', INGESTION_POLICY.origin);
      if (url.origin !== INGESTION_POLICY.origin || url.pathname !== '/jobs')
        return [];
      const next = Number(url.searchParams.get('page'));
      return Number.isSafeInteger(next) && next > page ? [next] : [];
    } catch {
      return [];
    }
  });
  if (
    !/找岗位|岗位列表|全部岗位/.test(doc.heading) &&
    !doc.nodes.some((n) => attr(n, 'data-job-list') !== undefined)
  )
    throw new IngestionError('SOURCE_PARSE_UNSUPPORTED');
  const nextPage = pages.length ? Math.min(...pages) : null;
  if (
    !jobIds.length &&
    (nextPage !== null ||
      !/暂无岗位|暂无符合条件|未找到相关岗位|没有找到符合条件/.test(
        text(doc.main),
      ))
  )
    throw new IngestionError('SOURCE_PARSE_UNSUPPORTED');
  return { kind: 'list', jobIds, nextPage, fetchedAt };
}
export function parseEvidenceHtml(
  html: string,
  fetchedAt: Date,
  httpStatus = 200,
): FetchedEvidence {
  const doc = document(html);
  const pairs = new Map<string, string>();
  for (const node of doc.nodes) {
    if (node.tagName !== 'dl') continue;
    const terms = elements(node).filter(
      (n) => n.tagName === 'dt' || n.tagName === 'dd',
    );
    for (let i = 0; i < terms.length - 1; i++) {
      if (terms[i]!.tagName === 'dt' && terms[i + 1]!.tagName === 'dd')
        pairs.set(text(terms[i]!), text(terms[i + 1]!));
    }
  }
  function blocks(node: Tree.Node): string[] {
    if ('tagName' in node && omitted.has(node.tagName)) return [];
    if (
      'tagName' in node &&
      ['p', 'h1', 'h2', 'h3', 'dt', 'dd', 'li', 'tr'].includes(node.tagName)
    ) {
      const value = text(node);
      return value ? [value] : [];
    }
    return children(node).flatMap(blocks);
  }
  const bodyBlocks = blocks(doc.main);
  if (!bodyBlocks.length) throw new IngestionError('SOURCE_PARSE_UNSUPPORTED');
  const links = doc.nodes
    .filter((n) => n.tagName === 'a')
    .flatMap((n) => {
      const link = normalizeSourceLink(attr(n, 'href') ?? '');
      return link ? [link] : [];
    });
  const recruitment = pairs.get('招聘类型') ?? '';
  const company =
    pairs.get('招聘单位') ??
    pairs.get('单位名称') ??
    doc.nodes
      .find((n) =>
        attr(n, 'class')
          ?.split(' ')
          .some((name) =>
            ['detail-company', 'detail-employer-name'].includes(name),
          ),
      )
      ?.childNodes.map(text)
      .join(' ') ??
    null;
  const deadline = pairs.get('报名截止') ?? '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : null;
  const instant =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      deadline,
    )
      ? deadline
      : null;
  const availability = pairs.get('报名状态') ?? '';
  const body = BodyStateSchema.parse({
    title: doc.heading,
    company,
    cities: (pairs.get('工作地点') ?? '')
      .split(/[、，,]/)
      .map((v) => v.trim())
      .filter(Boolean),
    recruitmentType:
      recruitment === '校招'
        ? 'campus'
        : recruitment === '社招'
          ? 'social'
          : 'unknown',
    blocks: bodyBlocks,
    deadline: {
      value: instant ?? date,
      precision: instant ? 'instant' : date ? 'date' : 'unknown',
      timezone: instant ? 'Asia/Shanghai' : null,
    },
    availability: /^(已截止|已关闭|停止招聘)$/.test(availability)
      ? 'closed'
      : /^(开放报名|报名中)$/.test(availability)
        ? 'open'
        : 'unknown',
    links: [...new Map(links.map((l) => [l.url, l])).values()].sort((a, b) =>
      a.url.localeCompare(b.url),
    ),
    parserVersion: INGESTION_POLICY.parserVersion,
  });
  return {
    kind: 'evidence',
    body,
    rawDigest: createHash('sha256').update(html).digest('hex'),
    httpStatus,
    fetchedAt,
  };
}
