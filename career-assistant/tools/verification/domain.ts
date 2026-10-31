import { ProbeErrorCode } from "./error-codes.ts";
/** 来源策略是固定配置；不允许任意URL变成探测入口。 */
export const SOURCE_HOST = "www.zhidianmijin.com.cn";
/** 验证来源的全局限制，避免复查预算被重定向绕过。 */
export const SOURCE_POLICY = Object.freeze({
  maxRequests: 20,
  minIntervalMs: 1_000,
  // 定时器及ISO毫秒时间存在量化误差，额外留出启动余量。
  timerMarginMs: 5,
  timeoutMs: 20_000,
  maxBytes: 3 * 1024 * 1024,
});
/** 文档资源限制；测试与提取共用此有业务含义的配置。 */
export const DOCUMENT_POLICY = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxPages: 30,
  maxCharacters: 50_000,
  maxUncompressedBytes: 20 * 1024 * 1024,
});

/** 领域失败对调用方稳定表达拒绝原因，不带文件正文或密钥。 */
export class ProbeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
/** 预算与允许来源由领域方法维护；适配器只传入请求事实。 */
export class SourceBudget {
  private used = 0;
  private lastStartedAt = 0;
  readonly limit: number;
  constructor(limit: number) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > SOURCE_POLICY.maxRequests
    )
      throw new ProbeError(ProbeErrorCode.InvalidRequestBudget);
    this.limit = limit;
  }
  authorize(url: string, now: number): number {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== SOURCE_HOST ||
      parsed.username ||
      parsed.password ||
      (parsed.port && parsed.port !== "443")
    )
      throw new ProbeError(ProbeErrorCode.SourceUrlForbidden);
    if (this.used >= this.limit)
      throw new ProbeError(ProbeErrorCode.SourceBudgetExhausted);
    const delay = Math.max(
      0,
      this.lastStartedAt + SOURCE_POLICY.minIntervalMs - now,
    );
    this.lastStartedAt = now + delay;
    this.used += 1;
    return delay;
  }
  get requestCount(): number {
    return this.used;
  }
  /** 定时器可能晚唤醒，以实际启动时刻作为下一次间隔依据。 */
  recordStartedAt(now: number): void {
    this.lastStartedAt = Math.max(this.lastStartedAt, now);
  }
}
