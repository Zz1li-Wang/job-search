import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SessionConfigSchema, SESSION_PAGE_URL } from "./session-dto.ts";
import { summarizeSessionPage, compareSessionPages } from "./session-page.ts";
import { SessionPageReader } from "./session-reader.ts";
import { probeSession } from "./session-service.ts";
import type { SourceFetch } from "./source.ts";

const fakeCookie = "session=fictional-cookie-only";
const environment = {
  SOURCE_BASE_URL: "https://www.zhidianmijin.com.cn",
  SOURCE_COOKIE: fakeCookie,
};
const job = "aabbccdd-1234-4123-8123-123456abcdef";
let temporary: string;
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "career-session-tests-"));
});
afterAll(async () => {
  await rm(temporary, { recursive: true, force: true });
});
async function makeRoot(count = 18, robots = "User-agent: *\nAllow: /") {
  const root = join(temporary, randomUUID());
  const run = join(root, randomUUID());
  await mkdir(join(run, "source"), { recursive: true });
  await writeFile(join(run, "source/robots.txt"), robots);
  await writeFile(
    join(run, "report.json"),
    JSON.stringify({
      runId: randomUUID(),
      kind: "source",
      requestLimit: 20,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      overall: "blocked",
      source: {
        status: "blocked",
        summary: "fixture",
        evidenceFiles: [],
        limitations: [],
        requestCount: count,
        pages: [
          {
            url: "https://www.zhidianmijin.com.cn/robots.txt",
            httpStatus: 200,
            fetchedAt: new Date().toISOString(),
            transport: "fixture",
            snapshot: "source/robots.txt",
            jobLinks: [],
            announcementLinks: [],
            paginationLinks: [],
          },
        ],
      },
    }),
  );
  return root;
}
describe("已授权会话的输入与隐私边界", () => {
  it("接受源站真实的不透明岗位ID，不能误报网络错误", async () => {
    const sourceId = "1abab653-6ba7-dfe0-05e2-e1909b96523c";
    const result = await new SessionPageReader(
      fakeCookie,
      async () =>
        new Response(`<h1>找岗位</h1><a href="/jobs/${sourceId}">job</a>`),
    ).read(true);
    expect(result.httpStatus).toBe(200);
    expect(result.category).toBe("jobs_visible");
    expect(result.jobIds).toEqual([sourceId]);
  });
  it("已有HTTP响应的正文失败保留状态，不误报传输失败", async () => {
    const result = await new SessionPageReader(
      fakeCookie,
      async () => new Response("x".repeat(3 * 1024 * 1024 + 1)),
    ).read(true);
    expect(result.httpStatus).toBe(200);
    expect(result.category).toBe("unknown");
    expect(result.errorCode).toBe("response_too_large");
  });
  it.each(["", "Cookie: session=abc", "session=abc\nX: injected"])(
    "拒绝空值、前缀和换行",
    (cookie) => {
      expect(
        SessionConfigSchema.safeParse({ ...environment, SOURCE_COOKIE: cookie })
          .success,
      ).toBe(false);
    },
  );
  it("其他来源不能携带Cookie", () => {
    expect(
      SessionConfigSchema.safeParse({
        ...environment,
        SOURCE_BASE_URL: "https://evil.invalid",
      }).success,
    ).toBe(false);
  });
  it("个人标题和响应正文不进入摘要", () => {
    const summary = summarizeSessionPage(
      200,
      `<h1>private-person</h1><script>${fakeCookie}</script>`,
      new Date().toISOString(),
    );
    expect(summary.category).toBe("unknown");
    expect(JSON.stringify(summary)).not.toContain("private-person");
    expect(JSON.stringify(summary)).not.toContain(fakeCookie);
  });
  it("200登录、会员和不确定页面不会当成成功", () => {
    const date = new Date().toISOString();
    const login = summarizeSessionPage(
      200,
      "<h1>登录后查看第 2 页岗位</h1>",
      date,
    );
    expect(compareSessionPages(login, login)).toBe("blocked");
    expect(
      compareSessionPages(
        login,
        summarizeSessionPage(200, "<h1>开通会员</h1>", date),
      ),
    ).toBe("blocked");
    expect(
      compareSessionPages(
        login,
        summarizeSessionPage(200, "<h1>未确定页面</h1>", date),
      ),
    ).toBe("inconclusive");
  });
  it("Cookie只进入第二个固定同站请求且不跟随重定向", async () => {
    const network = vi.fn<SourceFetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.invalid" },
        }),
    );
    const reader = new SessionPageReader(fakeCookie, network);
    await reader.read(false);
    await reader.read(true);
    expect(network).toHaveBeenCalledTimes(2);
    expect(new Headers(network.mock.calls[0][1].headers).has("cookie")).toBe(
      false,
    );
    expect(new Headers(network.mock.calls[1][1].headers).get("cookie")).toBe(
      fakeCookie,
    );
    for (const [url, init] of network.mock.calls) {
      expect(url).toBe(SESSION_PAGE_URL);
      expect(init.redirect).toBe("manual");
    }
  });
  it("网络错误不回显Cookie", async () => {
    const result = await new SessionPageReader(fakeCookie, async () => {
      throw Error(fakeCookie);
    }).read(true);
    expect(result.category).toBe("network_error");
    expect(JSON.stringify(result)).not.toContain(fakeCookie);
  });
});
describe("会话验证编排及预算", () => {
  it("缺Cookie在网络和持久化前拒绝", async () => {
    const network = vi.fn<SourceFetch>();
    await expect(
      probeSession({ runId: randomUUID(), outputRoot: temporary }, {}, network),
    ).rejects.toThrow("source_cookie_configuration_invalid");
    expect(network).not.toHaveBeenCalled();
  });
  it("完整入口对照、总预算22及报告重放不联网", async () => {
    const root = await makeRoot(20);
    const input = { runId: randomUUID(), outputRoot: root };
    const network = vi.fn<SourceFetch>(
      async (_url, init) =>
        new Response(
          new Headers(init.headers).has("cookie")
            ? `<h1>找岗位</h1><a href="/jobs/${job}">job</a><script>${fakeCookie}</script>`
            : "<h1>登录后查看第 2 页岗位</h1>",
        ),
    );
    const report = await probeSession(
      input,
      environment,
      network,
      async () => {},
    );
    expect(report.status).toBe("passed");
    expect(report.requestCount).toBe(2);
    expect(report.cumulativeSourceRequests).toBe(22);
    expect(report.after.jobIds).toEqual([job]);
    expect(JSON.stringify(report)).not.toContain(fakeCookie);
    expect(
      await readFile(join(root, input.runId, "session-report.json"), "utf8"),
    ).not.toContain(fakeCookie);
    expect(await probeSession(input, {}, network)).toEqual(report);
    expect(network).toHaveBeenCalledTimes(2);
    await expect(
      probeSession(
        { runId: randomUUID(), outputRoot: root },
        environment,
        network,
      ),
    ).rejects.toThrow("insufficient_source_budget");
    expect(network).toHaveBeenCalledTimes(2);
  });
  it("robots拒绝时不发送认证请求", async () => {
    const root = await makeRoot(18, "User-agent: *\nDisallow: /jobs");
    const network = vi.fn<SourceFetch>();
    await expect(
      probeSession(
        { runId: randomUUID(), outputRoot: root },
        environment,
        network,
      ),
    ).rejects.toThrow("cached_robots_not_verified");
    expect(network).not.toHaveBeenCalled();
  });
});
