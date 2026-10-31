import { SOURCE_POLICY } from "./domain.ts";
import {
  SESSION_PAGE_URL,
  SessionPageSchema,
  type SessionPage,
} from "./session-dto.ts";
import { summarizeSessionPage } from "./session-page.ts";
import type { SourceFetch } from "./source.ts";

/** 与公开采集器分离：认证响应仅在内存摘要，禁止原始快照及Cookie输出。 */
export class SessionPageReader {
  private readonly cookie: string;
  private readonly send: SourceFetch;
  constructor(cookie: string, send: SourceFetch = fetch) {
    this.cookie = cookie;
    this.send = send;
  }
  async read(withCookie: boolean): Promise<SessionPage> {
    const fetchedAt = new Date().toISOString();
    let response: Response;
    try {
      const headers: { "user-agent": string; accept: string; cookie?: string } =
        { "user-agent": "CareerVerification/0.2", accept: "text/html" };
      if (withCookie) headers.cookie = this.cookie;
      response = await this.send(SESSION_PAGE_URL, {
        method: "GET",
        redirect: "manual",
        headers,
        signal: AbortSignal.timeout(SOURCE_POLICY.timeoutMs),
      });
    } catch {
      return summarizeSessionPage(0, "", fetchedAt);
    }
    try {
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return summarizeSessionPage(response.status, "", fetchedAt);
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > SOURCE_POLICY.maxBytes)
              throw Error("response_too_large");
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel();
        }
      }
      return summarizeSessionPage(
        response.status,
        Buffer.concat(chunks).toString("utf8"),
        fetchedAt,
      );
    } catch (error) {
      return SessionPageSchema.parse({
        httpStatus: response.status,
        category: "unknown",
        jobIds: [],
        fetchedAt,
        errorCode:
          error instanceof Error && error.message === "response_too_large"
            ? "response_too_large"
            : "response_processing_failed",
      });
    }
  }
}
