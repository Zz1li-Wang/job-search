import { z } from "zod";

/** 真实调用预算与请求限制，全局持久化统计，不随runId重置。 */
export const MODEL_POLICY = Object.freeze({
  maxRequests: 5,
  maxOutputTokens: 1500,
  maxInputCharacters: 6000,
  timeoutMs: 120_000,
  maxResponseBytes: 512 * 1024,
});
export const ModelConfigSchema = z.object({
  MODEL_BASE_URL: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === "api.deepseek.com" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (!url.port || url.port === "443") &&
        ["/", "/v1", "/v1/"].includes(url.pathname)
      );
    })
    .describe("仅接受已确认的DeepSeek官方根地址或v1路径，不发送密钥到任意主机"),
  MODEL_NAME: z
    .literal("deepseek-v4-pro")
    .describe("用户指定模型，禁止隐式替换"),
  MODEL_PROTOCOL: z
    .literal("deepseek-chat-completions")
    .describe("已确认的官方Chat Completions协议"),
  MODEL_API_KEY: z
    .string()
    .trim()
    .min(1)
    .describe("仅请求时使用，不输出或落盘"),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/** 请求消息仅保留工具回传所需字段；不读取或保存reasoning_content。 */
export interface ProbeMessage {
  /** 消息身份，不接受任意工具或系统角色注入。 */
  role: "system" | "user" | "assistant" | "tool";
  /** 固定虚构样本或工具结果；工具请求时可为null。 */
  content: string | null;
  /** 模型已发出的调用，结构和允许列表校验后才能回传。 */
  tool_calls?: ToolCall[];
  /** 回传必须绑定原调用ID。 */
  tool_call_id?: string;
}
export const ToolCallSchema = z.object({
  id: z.string().min(1).describe("模型发出的调用ID，回传必须保持相同"),
  type: z.literal("function").describe("唯一允许的工具类型"),
  function: z
    .object({
      name: z.string().describe("需经允许列表校验的函数名"),
      arguments: z.string().describe("需再次用DTO校验的JSON参数"),
    })
    .describe("待执行工具请求"),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;
export const UsageSchema = z.object({
  prompt_tokens: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("服务报告输入token"),
  completion_tokens: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("服务报告输出token"),
  total_tokens: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("服务报告合计token"),
});
export const CompletionSchema = z.object({
  model: z.string().describe("服务实际报告模型标识"),
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.string().nullable().optional().describe("仅最终回答"),
            tool_calls: z
              .array(ToolCallSchema)
              .optional()
              .describe("结构化工具请求"),
          })
          .describe("过滤后的助手消息"),
        finish_reason: z
          .string()
          .nullable()
          .describe("stop/tool_calls等结束原因；length不是完整成功"),
      }),
    )
    .min(1)
    .describe("服务返回的候选回答"),
  usage: UsageSchema.optional().describe("可选计量元数据"),
});
export type Completion = z.infer<typeof CompletionSchema>;
export const StreamChunkSchema = z.object({
  model: z.string().optional().describe("流中服务返回的模型标识"),
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z
              .string()
              .nullable()
              .optional()
              .describe("回答增量，不保存推理增量"),
          })
          .describe("流增量"),
        finish_reason: z.string().nullable().optional().describe("流完成标记"),
      }),
    )
    .describe("usage-only事件可为空列表"),
  usage: UsageSchema.optional().describe("可选流计量"),
});

/** 失败码同时说明恢复语义；不保留外部异常正文，防止凭据反射。 */
export const ModelFailure = {
  Budget: "model_budget_exhausted", // 已达5次，需要用户另行授权，不自动重试。
  Ledger: "model_ledger_conflict", // 账本锁或结构不安全，停止，不自动抢占。
  Network: "model_network_interrupted", // 外部结果未知，不自动再次计费。
  Timeout: "model_timeout_interrupted", // 超时可能已计费，记录中断。
  Http: "model_http_rejected", // 记录HTTP码，401/403/429需补配置或额度。
  Response: "model_response_invalid", // JSON/契约不合法，不当作能力通过。
  Model: "model_identifier_mismatch", // 服务返回其他模型，禁止自动接受替换。
  Stream: "model_stream_incomplete", // 缺DONE/stop或中途断流，不伪称完整回复。
  Output: "model_response_too_large", // 超过响应上限，取消读取。
  Facts: "model_evidence_mismatch", // 事实或原文定位不符，不通过语义验证。
  Tool: "model_tool_contract_invalid", // 非允许工具、参数或回传结果无效。
} as const;
export class ModelProbeError extends Error {
  readonly code: string;
  readonly httpStatus?: number;
  constructor(code: string, httpStatus?: number) {
    super(code);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
export interface ModelRequestRecord {
  /** 跨runId的真实请求预留序号。 */
  sequence: number;
  /** 本次验证能力名。 */
  capability: string;
  /** 网络请求前UTC时间。 */
  startedAt: string;
  /** 包含响应体消费的本次耗时。 */
  durationMs: number;
  /** HTTP响应状态，无响应则缺省。 */
  httpStatus?: number;
  /** 服务实际返回模型，不能自动接受Flash替换Pro。 */
  responseModel?: string;
  /** 服务报告的可选token计量，不推算未知费用。 */
  usage?: z.infer<typeof UsageSchema>;
  /** 脱敏稳定错误码，不包含外部错误正文。 */
  errorCode?: string;
}
export interface CapabilityCheck {
  /** 能力检查标识，非开发阶段编号。 */
  name: string;
  /** 通过、失败、结果未知或未执行。 */
  status: "passed" | "failed" | "interrupted" | "not_run";
  /** 可复查结论或稳定失败码，不含密钥。 */
  explanation: string;
}
