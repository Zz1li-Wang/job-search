import { z } from 'zod';
import { ProfileContentSchema, ProfileSchema } from './profile.js';
export const ResumeTextInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(100).describe('资料标题'),
  text: z.string().trim().min(1).max(50000).describe('粘贴的本人简历内容'),
});
export const TextSpanSchema = z.strictObject({
  locator: z.string().max(100).describe('页或段落定位'),
  text: z.string().max(50000).describe('本地工具提取原文'),
});
export type TextSpan = z.infer<typeof TextSpanSchema>;
export const FieldEvidenceSchema = z.strictObject({
  path: z
    .string()
    .regex(
      /^\/(educationEntries|formalEmploymentEntries|internshipEntries|certificates|skills|jobPreferences|birthDate)\//,
    )
    .max(200)
    .describe(
      '相对于content的事实叶子JSON Pointer，如/skills/0或/educationEntries/0/graduationDate/value；日期必须定位到/value，不带/content前缀',
    ),
  locator: z.string().max(100).describe('原文页段'),
  excerpt: z.string().min(1).max(2000).describe('逐字引用的事实依据'),
});
export type FieldEvidence = z.infer<typeof FieldEvidenceSchema>;
export const ResumeSchema = z.strictObject({
  id: z.uuid().describe('本人简历'),
  title: z.string().describe('资料标题'),
  format: z.enum(['pdf', 'docx', 'txt']).describe('本地格式'),
  version: z.number().int().positive().describe('文件版本'),
  status: z
    .enum(['queued', 'extracting', 'structuring', 'ready', 'failed'])
    .describe('解析阶段'),
  taskId: z.uuid().nullable().describe('当前解析运行'),
  draftId: z.uuid().nullable().describe('待确认草稿'),
  errorCode: z.string().nullable().describe('安全失败代码'),
  createdAt: z.iso.datetime().describe('建立时间'),
});
export type ResumeDto = z.infer<typeof ResumeSchema>;
export const ResumeContentSchema = z.strictObject({
  resumeId: z.uuid().describe('资料ID'),
  version: z.number().int().positive().describe('原文版本'),
  spans: z.array(TextSpanSchema).max(3000).describe('提取文字及定位'),
});
export const ParseResumeSchema = z
  .strictObject({
    expectedResumeVersion: z
      .number()
      .int()
      .positive()
      .describe('看到的文件版本'),
    expectedTaskId: z
      .uuid()
      .optional()
      .describe('显式重试时所见的上一解析运行，阻止旧重试再次计费'),
    retry: z
      .boolean()
      .default(false)
      .describe('失败后用户明确同意重新调用模型'),
  })
  .superRefine((input, context) => {
    if (input.retry && !input.expectedTaskId)
      context.addIssue({
        code: 'custom',
        path: ['expectedTaskId'],
        message: '显式重试需要上一解析运行',
      });
  });
export const DraftInputSchema = z.strictObject({
  content: ProfileContentSchema.describe('用户输入或修正的画像'),
  baseProfileVersion: z
    .number()
    .int()
    .nonnegative()
    .describe('编辑时的正式画像版本'),
});
export const DraftPatchSchema = DraftInputSchema.extend({
  expectedDraftVersion: z
    .number()
    .int()
    .positive()
    .describe('已看到的草稿版本'),
});
export const DraftConfirmSchema = z.strictObject({
  expectedDraftVersion: z.number().int().positive().describe('草稿版本'),
  expectedProfileVersion: z
    .number()
    .int()
    .nonnegative()
    .describe('当前正式版本'),
});
export const DraftSchema = z.strictObject({
  id: z.uuid().describe('草稿标识'),
  version: z.number().int().positive().describe('草稿版本'),
  baseProfileVersion: z
    .number()
    .int()
    .nonnegative()
    .describe('创建或修正时的正式版本'),
  content: ProfileContentSchema,
  status: z.enum(['draft', 'confirmed']).describe('未确认或已确认'),
  sourceResumeId: z.uuid().nullable().describe('原文简历，手填为空'),
  sourceResumeVersion: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe('原文版本'),
  evidence: z
    .array(FieldEvidenceSchema)
    .max(2000)
    .describe('模型字段原文依据，用户手填项不伪造证据'),
  confirmedProfileVersion: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe('确认产生的正式版本'),
});
export type DraftDto = z.infer<typeof DraftSchema>;
export const ExtractionInputSchema = z.strictObject({
  runId: z.uuid().describe('受限运行'),
  resumeId: z.uuid().describe('只允许读取此文件'),
  version: z.number().int().positive().describe('文件版本'),
  grant: z.string().max(5000).describe('后端签名授权'),
});
export type ExtractionInputDto = z.infer<typeof ExtractionInputSchema>;
export const ExtractionResultSchema = z.strictObject({
  content: ProfileContentSchema,
  evidence: z
    .array(FieldEvidenceSchema)
    .max(2000)
    .describe('每个非空事实必须有原文依据'),
});
export type ExtractionResultDto = z.infer<typeof ExtractionResultSchema>;
export const ProposeProfileSchema = DraftInputSchema.extend({
  operationKey: z.string().min(8).max(100).describe('稳定草稿幂等键'),
});

export const ProfileConfirmationSchema = ProfileSchema.extend({
  isCurrent: z.boolean().describe('首次确认版本是否仍为当前'),
});

/** 已登记的提取失败；仅这些代码允许跨内部HTTP保留，未知错误不能伪装成确定失败。 */
export const ExtractionFailureCodeSchema = z.enum([
  'MODEL_UNAVAILABLE', // 模型服务拒绝或不可用，明确重试可能计费。
  'MODEL_INTERRUPTED', // 运行中断或结果未知，不自动重复调用。
  'MODEL_OUTPUT_INVALID', // 返回JSON、字段或日期格式不符合契约。
  'TOOL_UNAUTHORIZED', // 原文工具授权失效或不属于本次运行。
  'TOOL_BUDGET_EXHAUSTED', // 输入/工具预算超限，应缩小资料或重新发起。
]);
