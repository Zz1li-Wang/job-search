import { SOURCE_POLICY } from "./domain.ts";
import {
  SessionConfigSchema,
  SessionInputSchema,
  SESSION_PAGE_URL,
  type SessionReport,
} from "./session-dto.ts";
import { SessionPageReader } from "./session-reader.ts";
import { SessionStore } from "./session-store.ts";
import { compareSessionPages } from "./session-page.ts";
import type { SourceFetch } from "./source.ts";

/** 当前授权用例只编排两次GET，失败无自动重试，不触发模型或批量采集。 */
export async function probeSession(
  input: unknown,
  environment: NodeJS.ProcessEnv,
  send?: SourceFetch,
  pause = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<SessionReport> {
  const request = SessionInputSchema.parse(input);
  const store = new SessionStore(request.outputRoot, request.runId);
  const previous = await store.load();
  if (previous) return previous;
  const config = SessionConfigSchema.safeParse(environment);
  if (!config.success) throw Error("source_cookie_configuration_invalid");
  await store.acquire();
  let completed = false;
  try {
    const saved = await store.load();
    if (saved) {
      completed = true;
      return saved;
    }
    const count = await store.inspectBudgetAndPolicy();
    const startedAt = new Date().toISOString();
    const reader = new SessionPageReader(config.data.SOURCE_COOKIE, send);
    await store.reserve(request.runId, count + 1, "anonymous");
    const before = await reader.read(false);
    await pause(SOURCE_POLICY.minIntervalMs + SOURCE_POLICY.timerMarginMs);
    await store.reserve(request.runId, count + 2, "authenticated");
    const after = await reader.read(true);
    const status = compareSessionPages(before, after);
    const report: SessionReport = {
      runId: request.runId,
      url: SESSION_PAGE_URL,
      startedAt,
      endedAt: new Date().toISOString(),
      status,
      before,
      after,
      requestCount: 2,
      cumulativeSourceRequests: count + 2,
      rawAuthenticatedHtmlSaved: false,
      summary:
        status === "passed"
          ? "匿名第2页需登录，带Cookie后可见公开岗位ID；仅证明该会话此时可读该页，不代表全站或长期权限。"
          : "未形成匿名受限而带Cookie可读岗位的充分证据；可能仍受限、已过期或页面需要其他验证，不自动重试。",
    };
    await store.save(report);
    completed = true;
    return report;
  } finally {
    if (completed) await store.release();
  }
}
