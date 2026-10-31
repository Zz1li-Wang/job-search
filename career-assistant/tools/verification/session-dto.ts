import { z } from "zod";
/** 用户批准再做两次会话对照；累计来源上限含此前20次预留，不影响模型额度。 */
export const SESSION_SOURCE_TOTAL_LIMIT = 22;
export const SESSION_PAGE_URL =
  "https://www.zhidianmijin.com.cn/jobs?sort=latest&direction=desc&page=2";
/** 只接受本次明确授权的同站会话，不将Cookie发到重定向或其他来源。 */
export const SessionConfigSchema = z.object({
  SOURCE_BASE_URL: z
    .literal("https://www.zhidianmijin.com.cn")
    .describe("唯一允许来源"),
  SOURCE_COOKIE: z
    .string()
    .trim()
    .min(1)
    .refine((value) => !/^Cookie\s*:/i.test(value) && !/[\r\n]/.test(value))
    .describe("本地私有Cookie值，不含Cookie前缀与换行"),
});
export const SessionInputSchema = z.object({
  runId: z.uuid().describe("不可覆盖运行标识"),
  outputRoot: z.string().min(1).describe("来源验证报告父目录"),
});
export const SessionPageSchema = z.object({
  httpStatus: z.number().int().nonnegative().describe("0表示没有有效HTTP响应"),
  category: z
    .enum([
      "login_required",
      "jobs_visible",
      "membership_required",
      "redirect",
      "unknown",
      "network_error",
    ])
    .describe("标题类别，不保存可能包含个人信息的原文"),
  jobIds: z
    .array(
      z
        .string()
        .regex(/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i),
    )
    .describe(
      "源站不透明岗位标识，形似UUID但不限制UUID版本或variant；不是系统内部UUID",
    ),
  fetchedAt: z.iso.datetime().describe("实际请求启动时刻"),
  errorCode: z
    .enum(["response_too_large", "response_processing_failed"])
    .optional()
    .describe("已收到HTTP后本地处理失败，不误报为网络错误"),
});
export type SessionPage = z.infer<typeof SessionPageSchema>;
export const SessionReportSchema = z.object({
  runId: z.uuid().describe("本次访问验证标识"),
  url: z.literal(SESSION_PAGE_URL).describe("对照的唯一URL"),
  startedAt: z.iso.datetime().describe("开始时刻"),
  endedAt: z.iso.datetime().describe("报告完成时刻"),
  status: z
    .enum(["passed", "blocked", "inconclusive"])
    .describe("只验证该页该时刻，不承诺全站可采"),
  before: SessionPageSchema.describe("匿名对照"),
  after: SessionPageSchema.describe("已授权Cookie对照"),
  requestCount: z
    .number()
    .int()
    .min(0)
    .max(2)
    .describe("本轮最多两次请求，无重定向跟随或重试"),
  cumulativeSourceRequests: z
    .number()
    .int()
    .max(SESSION_SOURCE_TOTAL_LIMIT)
    .describe("含之前公开验证及所有会话请求预留，累计最多22次"),
  summary: z.string().describe("可复查结论，不含Cookie或个人页面内容"),
  rawAuthenticatedHtmlSaved: z
    .literal(false)
    .describe("不保存认证原始HTML和响应头"),
});
export type SessionReport = z.infer<typeof SessionReportSchema>;
