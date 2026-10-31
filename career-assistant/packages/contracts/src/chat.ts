import { EXECUTION_POLICY } from './execution-policy.js';
import { z } from 'zod';
export const ConversationInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(100).optional().describe('会话标题'),
});
export const ConversationSchema = z.strictObject({
  id: z.uuid().describe('本人会话'),
  title: z.string().describe('会话标题'),
  createdAt: z.iso.datetime().describe('建立时间'),
  activeRunId: z.uuid().nullable().describe('串行执行中的运行'),
});
export type ConversationDto = z.infer<typeof ConversationSchema>;
export const MessageInputSchema = z.strictObject({
  clientMessageId: z.uuid().describe('同会话幂等消息ID'),
  text: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe('用户消息，不自动写正式画像'),
  jobId: z.uuid().optional().describe('本轮关联岗位'),
});
export type MessageInputDto = z.infer<typeof MessageInputSchema>;
export const RunStatusSchema = z
  .enum([
    'queued',
    'running',
    'completed',
    'failed',
    'interrupted',
    'cancelled',
  ])
  .describe('可靠排队、执行、完成、失败、未知中断或取消');
export const RunSchema = z.strictObject({
  id: z.uuid().describe('运行ID'),
  conversationId: z.uuid().describe('所属会话'),
  status: RunStatusSchema,
  attempt: z.number().int().positive().describe('执行尝试'),
  version: z.number().int().positive().describe('乐观并发版本'),
  lastSequence: z.number().int().nonnegative().describe('最后已提交事件序号'),
  errorCode: z.string().nullable().describe('安全失败分类'),
});
export type RunDto = z.infer<typeof RunSchema>;
export const CitationSchema = z.strictObject({
  resourceId: z.uuid().describe('工具实际返回的资源'),
  versionId: z.uuid().describe('引用正文版本'),
  observationId: z.uuid().describe('实际获取观察'),
  sourceUrl: z.url().describe('真实来源链接'),
});
export type CitationDto = z.infer<typeof CitationSchema>;
export const JobCardSchema = z.strictObject({
  jobId: z.uuid().describe('实际岗位'),
  checkId: z.uuid().nullable().describe('实际资格记录，未核验为空'),
  status: z
    .enum(['eligible', 'not_eligible', 'pending'])
    .describe('后端结论，模型不能覆盖'),
});
export const MessageSchema = z.strictObject({
  id: z.uuid().describe('消息'),
  conversationId: z.uuid().describe('所属会话'),
  role: z.enum(['user', 'assistant']).describe('发送者角色'),
  text: z.string().describe('消息正文'),
  runId: z.uuid().nullable().describe('关联运行'),
  status: z
    .enum(['submitted', 'completed', 'partial', 'failed'])
    .describe('持久消息状态'),
  citations: z.array(CitationSchema).describe('经过工具核验的引用'),
  createdAt: z.iso.datetime().describe('消息提交时间'),
});
export type MessageDto = z.infer<typeof MessageSchema>;
export const RunEventPayloadSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('text_delta'),
    text: z.string().max(20000).describe('模型文本增量'),
  }),
  z.strictObject({
    type: z.literal('citation'),
    citation: CitationSchema.describe('有效来源依据'),
  }),
  z.strictObject({
    type: z.literal('job_cards'),
    cards: z.array(JobCardSchema).max(20).describe('业务后端资格卡片'),
  }),
  z.strictObject({
    type: z.literal('profile_draft'),
    draftId: z.uuid().describe('待用户确认的草稿'),
  }),
  z.strictObject({
    type: z.literal('completed'),
    text: z.string().max(50000).describe('最终文本'),
    citations: z.array(CitationSchema).max(100).describe('实际证据引用'),
  }),
  z.strictObject({
    type: z.literal('failed'),
    errorCode: z.string().max(100).describe('脱敏错误分类'),
    isRetryable: z.boolean().describe('需用户显式重试'),
  }),
]);
export type RunEventPayload = z.infer<typeof RunEventPayloadSchema>;
export const RunEventInputSchema = z.strictObject({
  sequence: z.number().int().positive().describe('从1开始严格递增'),
  payload: RunEventPayloadSchema.describe('有界事件联合'),
});
export type RunEventInputDto = z.infer<typeof RunEventInputSchema>;
export const RunEventSchema = z.strictObject({
  runId: z.uuid().describe('运行'),
  sequence: z.number().int().positive().describe('持久化序号'),
  payload: RunEventPayloadSchema,
  createdAt: z.iso.datetime().describe('提交时间'),
});
export type RunEventDto = z.infer<typeof RunEventSchema>;
export const RetryRunSchema = z.strictObject({
  expectedRunVersion: z
    .number()
    .int()
    .positive()
    .describe('显式重试的运行版本'),
});
export const EventCursorSchema = z.strictObject({
  after: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('已经收到的事件序号'),
});
export const PageInputSchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('每页条数'),
  cursor: z.uuid().optional().describe('上页最后资源ID'),
});
export const ToolNameSchema = z
  .enum([
    'get_profile',
    'search_jobs',
    'get_job_evidence',
    'evaluate_eligibility',
    'request_job_refresh',
    'get_task_status',
    'read_resume',
    'propose_profile_update',
  ])
  .describe('白名单业务工具');
export type ToolName = z.infer<typeof ToolNameSchema>;
export const RunGrantClaimsSchema = z.strictObject({
  userId: z.uuid().describe('后端签发的身份'),
  runId: z.uuid().describe('授权运行或解析任务'),
  authEpoch: z.number().int().nonnegative().describe('认证版本'),
  personalDataEpoch: z
    .number()
    .int()
    .nonnegative()
    .describe('个人数据删除屏障'),
  kind: z.enum(['chat', 'resume']).describe('授权用途'),
  resourceId: z.uuid().nullable().describe('解析授权限定文件'),
  tools: z
    .array(ToolNameSchema)
    .max(EXECUTION_POLICY.maxToolCalls)
    .describe('本次允许工具'),
  expiresAt: z.number().int().positive().describe('短期到期毫秒'),
});
export type RunGrantClaims = z.infer<typeof RunGrantClaimsSchema>;
export const AgentRunInputSchema = z.strictObject({
  runId: z.uuid().describe('持久运行ID'),
  grant: z.string().max(5000).describe('后端签发的不透明授权'),
  messages: z
    .array(
      z.strictObject({
        role: z.enum(['user', 'assistant']).describe('历史消息角色'),
        content: z
          .string()
          .max(50000)
          .describe('本轮上下文，资料不作为系统指令'),
      }),
    )
    .min(1)
    .max(30)
    .describe('已持久消息与摘要'),
  callbackUrl: z.url().describe('仅服务器配置的业务回调地址'),
});
export type AgentRunInputDto = z.infer<typeof AgentRunInputSchema>;
export const AgentStateSchema = z.strictObject({
  runId: z.uuid().describe('运行'),
  status: z
    .enum(['running', 'completed', 'failed', 'cancelled', 'unknown'])
    .describe('Agent进程可知状态'),
});
