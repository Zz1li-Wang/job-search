import { z } from "zod";

/** 能力状态：passed=证据通过；failed=断言失败；blocked=依赖阻塞；
 * unsupported=明确不支持；interrupted=结果未知；not_run=没有执行。 */
export const CapabilityStatus = z.enum([
  "passed",
  "failed",
  "blocked",
  "unsupported",
  "interrupted",
  "not_run",
]);
/** 单项执行类型：source=来源，document=文档，model=模型，all=全部独立项。 */
export const ProbeKind = z.enum(["source", "document", "model", "all"]);
/** 验证请求DTO，调用前完成结构和预算校验。 */
export const ProbeInputSchema = z.object({
  runId: z.uuid().describe("本次不可覆盖的验证标识"),
  kind: ProbeKind.describe("明确执行的能力项"),
  outputRoot: z.string().min(1).describe("报告父目录"),
  requestLimit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(20)
    .describe("包含重定向的来源请求上限"),
});
export type ProbeInput = z.infer<typeof ProbeInputSchema>;
/** 文字证据只表示提取，不表示已经理解学历或经历。 */
export const SpanSchema = z.object({
  locator: z.string().min(1).describe("原始页或段位置"),
  text: z.string().describe("对应位置的文字"),
});
export type TextSpan = z.infer<typeof SpanSchema>;
const capabilityShape = {
  status: CapabilityStatus.describe("本项实际能力验证状态"),
  summary: z.string().describe("明确区分成功与缺口的结论"),
  evidenceFiles: z.array(z.string()).describe("相对运行目录的证据文件路径"),
  limitations: z.array(z.string()).describe("不能由本次样本证明的范围"),
};
/** 招聘类型campus为校招、social为社招、unknown为未能识别；不等于报名资格。 */
export const SourcePageSchema = z.object({
  url: z.url().describe("实际请求的允许来源地址"),
  fetchedAt: z.iso.datetime().describe("本次请求启动时间"),
  transport: z.string().describe("实际网络传输方式"),
  httpStatus: z
    .number()
    .int()
    .nonnegative()
    .describe("HTTP状态；0表示没有有效响应"),
  snapshot: z.string().optional().describe("原始公开响应的相对保存位置"),
  title: z.string().optional().describe("实际HTML标题，不凭URL猜测"),
  recruitmentType: z
    .enum(["campus", "social", "unknown"])
    .optional()
    .describe("由正文招聘标签识别的类型"),
  jobLinks: z.array(z.string()).describe("实际HTML中出现的同站岗位链接"),
  announcementLinks: z
    .array(z.string())
    .describe("实际HTML中出现的同站公告链接"),
  paginationLinks: z
    .array(z.string())
    .describe("实际HTML中出现的分页链接，不保证可匿名访问"),
  errorCode: z.string().optional().describe("网络或响应失败分类"),
});
export type SourcePage = z.infer<typeof SourcePageSchema>;
export const DocumentResultSchema = z.object({
  fixtureId: z.string().describe("虚构文档样本标识"),
  format: z.string().describe("输入文件扩展名"),
  status: CapabilityStatus.describe("正例提取或负例正确拒绝的测试结果"),
  expected: z
    .enum(["readable", "rejected"])
    .describe("readable应可读，rejected应被明确拒绝"),
  spans: z.array(SpanSchema).describe("成功提取的页段文字，拒绝时为空"),
  errorCode: z.string().optional().describe("拒绝或提取失败的稳定原因"),
});
export type DocumentResult = z.infer<typeof DocumentResultSchema>;
export const CapabilityResultSchema = z.object(capabilityShape);
export type CapabilityResult = z.infer<typeof CapabilityResultSchema>;
export const SourceResultSchema = z.object({
  ...capabilityShape,
  requestCount: z
    .number()
    .int()
    .nonnegative()
    .describe("实际来源请求尝试数，含重定向"),
  pages: z
    .array(SourcePageSchema)
    .describe("逐请求证据，不把HTTP200当作业务通过"),
});
export type SourceResult = z.infer<typeof SourceResultSchema>;
export const DocumentProbeResultSchema = z.object({
  ...capabilityShape,
  fixtures: z.array(DocumentResultSchema).describe("各虚构文档正负例结果"),
});
export type DocumentProbeResult = z.infer<typeof DocumentProbeResultSchema>;
export const ModelResultSchema = z.object({
  ...capabilityShape,
  requestCount: z
    .number()
    .int()
    .nonnegative()
    .describe("实际模型请求数，未接通为0"),
  missingConfiguration: z
    .array(z.string())
    .describe("只列缺失配置名，不输出密钥值"),
});
export type ModelResult = z.infer<typeof ModelResultSchema>;
/** 报告是能力事实，不是步骤验收；落盘和重放共用同一运行时契约。 */
export const ProbeReportSchema = z.object({
  runId: z.uuid().describe("不可覆盖运行标识"),
  kind: ProbeKind.describe("本次请求能力项"),
  requestLimit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .describe("本次来源预算，重放时必须相同"),
  startedAt: z.iso.datetime().describe("验证开始UTC时间"),
  endedAt: z.iso.datetime().describe("完成报告UTC时间，不代表能力全部通过"),
  overall: z
    .enum(["passed", "blocked", "failed"])
    .describe("所有请求项通过才是passed；依赖缺失为blocked"),
  source: SourceResultSchema.optional().describe("未请求来源项时缺省"),
  document: DocumentProbeResultSchema.optional().describe("未请求文档项时缺省"),
  model: ModelResultSchema.optional().describe("未请求模型项时缺省"),
});
export type ProbeReport = z.infer<typeof ProbeReportSchema>;
