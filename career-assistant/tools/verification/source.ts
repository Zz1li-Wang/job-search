import { ProbeErrorCode } from "./error-codes.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  ProbeError,
  SourceBudget,
  SOURCE_HOST,
  SOURCE_POLICY,
} from "./domain.ts";
import type { SourcePage, SourceResult } from "./dto.ts";

export type SourceFetch = (url: string, init: RequestInit) => Promise<Response>;
/** robots-parser的CommonJS入口；仅适配库声明，不接受调用方提供可执行对象。 */
const robotsParser: (
  url: string,
  content: string,
) => {
  isAllowed(url: string, agent: string): boolean | undefined;
  getCrawlDelay(agent: string): number | undefined;
} = createRequire(import.meta.url)("robots-parser");
/** 只抽取实际HTML可见的链接和标签；不把推测的API称为已验证。 */
export function inspectHtml(html: string, url: string) {
  const links = [...html.matchAll(/href=["']([^"']+)["']/gi)]
    .flatMap((match) => {
      try {
        return [new URL(match[1].replaceAll("&amp;", "&"), url).href];
      } catch {
        return [];
      }
    })
    .filter((link) => new URL(link).hostname === SOURCE_HOST);
  const title =
    /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ??
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ??
    "";
  const visible = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ");
  return {
    title: title.replace(/<[^>]+>/g, "").trim(),
    recruitmentType: (/招聘类型\s*[:：]?\s*社招/.test(visible)
      ? "social"
      : /招聘类型\s*[:：]?\s*校招/.test(visible)
        ? "campus"
        : "unknown") as SourcePage["recruitmentType"],
    jobLinks: [
      ...new Set(links.filter((link) => /\/jobs\/[a-f\d-]{36}/i.test(link))),
    ],
    announcementLinks: [
      ...new Set(
        links.filter((link) => /\/announcements\/[a-f\d-]{36}/i.test(link)),
      ),
    ],
    paginationLinks: [
      ...new Set(links.filter((link) => /[?&]page=\d+/.test(link))),
    ],
  };
}

/** 网络适配器逐请求授权，手动跟踪重定向计数，不发送登录Cookie。 */
export class SourceAdapter {
  readonly budget: SourceBudget;
  readonly pages: SourcePage[] = [];
  readonly directory: string;
  private readonly fetchPage: SourceFetch;
  private readonly pause: (milliseconds: number) => Promise<void>;
  constructor(
    directory: string,
    limit: number,
    fetchPage: SourceFetch = fetch,
    pause = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {
    this.directory = directory;
    this.budget = new SourceBudget(limit);
    this.fetchPage = fetchPage;
    this.pause = pause;
  }
  async request(url: string): Promise<{ page: SourcePage; body: string }> {
    const delay = this.budget.authorize(url, Date.now());
    await this.pause(delay > 0 ? delay + SOURCE_POLICY.timerMarginMs : 0);
    this.budget.recordStartedAt(Date.now());
    const page: SourcePage = {
      url,
      fetchedAt: new Date().toISOString(),
      transport: "node-native-fetch",
      httpStatus: 0,
      jobLinks: [],
      announcementLinks: [],
      paginationLinks: [],
    };
    this.pages.push(page);
    try {
      const response = await this.fetchPage(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(SOURCE_POLICY.timeoutMs),
        headers: {
          "user-agent": "CareerVerification/0.2",
          accept: "text/html,text/plain",
        },
      });
      page.httpStatus = response.status;
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get("location")
      ) {
        await response.body?.cancel();
        return this.request(
          new URL(response.headers.get("location")!, url).href,
        );
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > SOURCE_POLICY.maxBytes)
              throw new ProbeError(ProbeErrorCode.SourceBodyTooLarge);
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel();
        }
      }
      const body = Buffer.concat(chunks).toString("utf8");
      await mkdir(join(this.directory, "source"), { recursive: true });
      page.snapshot = `source/${String(this.pages.length).padStart(2, "0")}.html`;
      await writeFile(join(this.directory, page.snapshot), body);
      Object.assign(page, inspectHtml(body, url));
      if (!response.ok) page.errorCode = `http_${response.status}`;
      return { page, body };
    } catch (error) {
      page.errorCode =
        error instanceof ProbeError
          ? error.code
          : error instanceof Error && error.name === "TimeoutError"
            ? ProbeErrorCode.SourceTimeout
            : ProbeErrorCode.SourceUnavailable;
      return { page, body: "" };
    }
  }
  async probe(): Promise<SourceResult> {
    const base = `https://${SOURCE_HOST}`;
    const robots = await this.request(`${base}/robots.txt`);
    if (
      robots.page.httpStatus !== 404 &&
      (robots.page.httpStatus !== 200 || robots.page.errorCode)
    )
      return this.result("blocked", "无法确认来源访问约束；未继续抓取岗位。");
    const policy = robotsParser(
      `${base}/robots.txt`,
      robots.page.httpStatus === 200 ? robots.body : "",
    );
    const requestAllowed = async (url: string) => {
      if (this.budget.requestCount >= this.budget.limit) return undefined;
      if (policy.isAllowed(url, "CareerVerification") === false)
        return undefined;
      const delay = policy.getCrawlDelay("CareerVerification");
      if (delay) await this.pause(delay * 1000);
      return this.request(url);
    };
    const home = await requestAllowed(base + "/");
    const list = await requestAllowed(base + "/jobs");
    // 两个URL来自前期公开页面调查，不假定其当前仍开放或仍是对应招聘类型。
    const knownSamples = [
      "/jobs/787b1a4b-53c0-9d9a-be12-2c5e1f8042a9",
      "/jobs/01d3988d-6c30-0d20-2c09-0f15085e21b2",
    ];
    const samples = [
      ...new Set([
        ...(list?.page.jobLinks ?? []).slice(0, 2),
        ...knownSamples.map((path) => base + path),
      ]),
    ];
    for (const url of samples) {
      if (this.budget.requestCount >= this.budget.limit) break;
      const sample = await requestAllowed(url);
      for (const announcement of sample?.page.announcementLinks.slice(0, 1) ??
        []) {
        if (this.budget.requestCount < this.budget.limit)
          await requestAllowed(announcement);
      }
    }
    // 首页公开公告也单独取样，但不能冒充已建立每个岗位的公告关联。
    for (const announcement of home?.page.announcementLinks.slice(0, 2) ?? []) {
      if (this.budget.requestCount < this.budget.limit)
        await requestAllowed(announcement);
    }
    const nextPage = list?.page.paginationLinks.find(
      (url) => url !== list.page.url,
    );
    const next =
      nextPage && this.budget.requestCount < this.budget.limit
        ? await requestAllowed(nextPage)
        : undefined;
    const hasCampus = this.pages.some(
      (page) => page.httpStatus === 200 && page.recruitmentType === "campus",
    );
    const hasSocial = this.pages.some(
      (page) => page.httpStatus === 200 && page.recruitmentType === "social",
    );
    const hasAnnouncement = this.pages.some(
      (page) => page.httpStatus === 200 && /\/announcements\//.test(page.url),
    );
    const passed =
      hasCampus &&
      hasSocial &&
      hasAnnouncement &&
      Boolean(next?.page.jobLinks.length) &&
      !/登录后/.test(next?.page.title ?? "");
    return this.result(
      passed ? "passed" : "blocked",
      passed
        ? "HTML样本及分页可获取；岗位公告关联和完整条件仍需人工核对。"
        : "尚未同时验证两种招聘类型、公告和可用分页；200响应不代表登录限制已解除。",
    );
  }
  private result(
    status: SourceResult["status"],
    summary: string,
  ): SourceResult {
    return {
      status,
      summary,
      requestCount: this.budget.requestCount,
      pages: this.pages,
      evidenceFiles: this.pages.flatMap((page) =>
        page.snapshot ? [page.snapshot] : [],
      ),
      limitations: [
        "只验证有限公开样本，不代表全站覆盖或岗位资格已经核验。",
        "使用Node原生fetch；网络失败不等于网站不存在，未使用搜索缓存替代本机采集。",
        "未验证源站内部API及浏览器采集；未把未出现的分页链接猜作可用。",
      ],
    };
  }
}
