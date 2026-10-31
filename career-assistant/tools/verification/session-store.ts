import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { ProbeReportSchema } from "./dto.ts";
import {
  SESSION_PAGE_URL,
  SESSION_SOURCE_TOTAL_LIMIT,
  SessionReportSchema,
  type SessionReport,
} from "./session-dto.ts";

const parseRobots: (
  url: string,
  body: string,
) => { isAllowed(url: string, agent: string): boolean | undefined } =
  createRequire(import.meta.url)("robots-parser");
/** 文件适配器维护跨本次及此前公开探测的总预算，不保存任何认证数据。 */
export class SessionStore {
  readonly root: string;
  readonly directory: string;
  constructor(root: string, runId: string) {
    this.root = root;
    this.directory = join(root, runId);
  }
  async load(): Promise<SessionReport | undefined> {
    try {
      return SessionReportSchema.parse(
        JSON.parse(
          await readFile(join(this.directory, "session-report.json"), "utf8"),
        ),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw Error("invalid_session_report", { cause: error });
    }
  }
  async acquire(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const lock = await open(
      join(this.root, ".source-session.lock"),
      "wx",
      0o600,
    );
    await lock.close();
  }
  async release(): Promise<void> {
    await unlink(join(this.root, ".source-session.lock"));
  }
  async inspectBudgetAndPolicy(): Promise<number> {
    let total = 0;
    let allowed = false;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let text;
      try {
        text = await readFile(
          join(this.root, entry.name, "report.json"),
          "utf8",
        );
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          continue;
        throw error;
      }
      const report = ProbeReportSchema.parse(JSON.parse(text));
      total += report.source?.requestCount ?? 0;
      const robots = report.source?.pages.find(
        (page) =>
          page.url === "https://www.zhidianmijin.com.cn/robots.txt" &&
          page.httpStatus === 200 &&
          page.snapshot,
      );
      if (robots?.snapshot) {
        const body = await readFile(
          join(this.root, entry.name, robots.snapshot),
          "utf8",
        );
        if (
          parseRobots(robots.url, body).isAllowed(
            SESSION_PAGE_URL,
            "CareerVerification",
          ) === true
        )
          allowed = true;
      }
    }
    try {
      const lines = (
        await readFile(
          join(this.root, "source-session-request-ledger.jsonl"),
          "utf8",
        )
      )
        .split("\n")
        .filter(Boolean);
      for (const line of lines) JSON.parse(line);
      total += lines.length;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    if (!allowed) throw Error("cached_robots_not_verified");
    if (total + 2 > SESSION_SOURCE_TOTAL_LIMIT)
      throw Error("insufficient_source_budget");
    return total;
  }
  async reserve(
    runId: string,
    ordinal: number,
    mode: "anonymous" | "authenticated",
  ): Promise<void> {
    await appendFile(
      join(this.root, "source-session-request-ledger.jsonl"),
      JSON.stringify({
        runId,
        ordinal,
        mode,
        url: SESSION_PAGE_URL,
        reservedAt: new Date().toISOString(),
      }) + "\n",
      { mode: 0o600 },
    );
  }
  async save(report: SessionReport): Promise<void> {
    SessionReportSchema.parse(report);
    await mkdir(this.directory, { recursive: true });
    await writeFile(
      join(this.directory, ".session-report.tmp"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
    await rename(
      join(this.directory, ".session-report.tmp"),
      join(this.directory, "session-report.json"),
    );
  }
}
