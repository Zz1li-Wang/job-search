import { inspectHtml } from "./source.ts";
import {
  SESSION_PAGE_URL,
  SessionPageSchema,
  type SessionPage,
} from "./session-dto.ts";

/** 只产生不含账号信息的分类；完整认证HTML不能流入报告。 */
export function summarizeSessionPage(
  httpStatus: number,
  html: string,
  fetchedAt: string,
): SessionPage {
  const parsed = inspectHtml(html, SESSION_PAGE_URL);
  const jobIds = [
    ...new Set(
      parsed.jobLinks.flatMap(
        (link) => /\/jobs\/([a-f\d-]{36})/i.exec(link)?.slice(1) ?? [],
      ),
    ),
  ];
  const category =
    httpStatus === 0
      ? "network_error"
      : httpStatus >= 300 && httpStatus < 400
        ? "redirect"
        : /登录后查看|请先登录|登录后继续|^登录$/.test(parsed.title)
          ? "login_required"
          : /会员|订阅|付费/.test(parsed.title) && !jobIds.length
            ? "membership_required"
            : httpStatus === 200 &&
                ["找岗位", "岗位列表", "全部岗位"].includes(parsed.title) &&
                jobIds.length > 0
              ? "jobs_visible"
              : "unknown";
  return SessionPageSchema.parse({ httpStatus, category, jobIds, fetchedAt });
}
export function compareSessionPages(
  before: SessionPage,
  after: SessionPage,
): "passed" | "blocked" | "inconclusive" {
  if (before.category === "login_required" && after.category === "jobs_visible")
    return "passed";
  if (
    [
      "login_required",
      "membership_required",
      "network_error",
      "redirect",
    ].includes(after.category)
  )
    return "blocked";
  return "inconclusive";
}
