import { z } from 'zod';
import {
  RecruitmentTypeSchema,
  RuleTreeSchema,
  EvidenceRefSchema,
} from './ingestion.js';
export const JobQuerySchema = z.strictObject({
  keyword: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe('标题或单位关键词'),
  city: z.string().trim().min(1).max(100).optional().describe('明确地点'),
  recruitmentType: RecruitmentTypeSchema.optional(),
  degree: z
    .enum([
      'high_school',
      'secondary_vocational',
      'associate',
      'bachelor',
      'master',
      'doctor',
    ])
    .optional()
    .describe('学历候选筛选，未知条件仍保留'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('单页条数'),
  cursor: z.string().max(2048).optional().describe('签名且绑定筛选的分页游标'),
  sort: z
    .literal('recorded_desc')
    .default('recorded_desc')
    .describe('不可变首次收录时间倒序'),
});
export type JobQueryDto = z.infer<typeof JobQuerySchema>;
export const DeadlineSchema = z.strictObject({
  value: z.string().nullable().describe('原文明示日期/时刻'),
  precision: z.enum(['instant', 'date', 'unknown']).describe('截止精度'),
  timezone: z.string().nullable().describe('原文明示时区'),
});
export const JobSummarySchema = z.strictObject({
  id: z.uuid().describe('本地岗位'),
  jobVersionId: z.uuid().describe('当前正文版本'),
  title: z.string().describe('原文岗位标题'),
  company: z.string().nullable().describe('单位，未知为空'),
  cities: z.array(z.string()).describe('原文明示地点'),
  recruitmentType: RecruitmentTypeSchema,
  recordedAt: z.iso.datetime().describe('首次收录时间，不等于源站发布时间'),
  lastFetchedAt: z.iso.datetime().nullable().describe('最近成功获取'),
  verifiedAt: z.iso.datetime().nullable().describe('当前完整核验依据时间'),
  deadline: DeadlineSchema,
  availability: z
    .enum(['open', 'closed', 'unknown'])
    .describe('当前已收录版本报名状态'),
  reviewState: z.enum(['reviewed', 'pending']).describe('条件是否完整核验'),
  freshness: z
    .enum(['fresh', 'pending', 'closed'])
    .describe('证据新鲜度与截止状态'),
  warnings: z.array(z.string()).describe('缺口与限制'),
});
export type JobSummaryDto = z.infer<typeof JobSummarySchema>;
export const JobPageSchema = z.strictObject({
  entries: z.array(JobSummarySchema).describe('候选岗位，不等于可报名'),
  nextCursor: z.string().nullable().describe('无下一页为空'),
});
export const EvidenceEntrySchema = z.strictObject({
  resourceId: z.uuid().describe('证据资源'),
  versionId: z.uuid().describe('不可变版本'),
  observationId: z.uuid().describe('实际获取观察'),
  sourceUrl: z.url().describe('公开源站URL'),
  blocks: z.array(z.string()).describe('可定位的去敏原文'),
  fetchedAt: z.iso.datetime().describe('获取时间'),
});
export type EvidenceEntryDto = z.infer<typeof EvidenceEntrySchema>;
export const EvidenceBundleSchema = z.strictObject({
  jobId: z.uuid().describe('岗位'),
  jobVersionId: z.uuid().describe('当前岗位版本'),
  reviewId: z.uuid().nullable().describe('当前核验记录'),
  reviewVersion: z.number().int().nonnegative().describe('当前核验指针版本'),
  dependencyHash: z.string().length(64).describe('当前证据和关联摘要'),
  entries: z.array(EvidenceEntrySchema).describe('当前已获取依据'),
  unvisitedUrls: z.array(z.url()).describe('未访问的外站入口或未获取公告'),
});
export type EvidenceBundleDto = z.infer<typeof EvidenceBundleSchema>;
export const JobDetailSchema = JobSummarySchema.extend({
  blocks: z.array(z.string()).describe('正文'),
  tree: RuleTreeSchema.nullable().describe('当前核验条件树'),
  reviewId: z.uuid().nullable().describe('当前人工核验'),
  reviewVersion: z.number().int().nonnegative().describe('核验指针版本'),
  evidenceDependencyHash: z.string().length(64).describe('当前证据依赖摘要'),
  isComplete: z.boolean().describe('条件完整性'),
  gaps: z.array(z.string()).describe('尚缺材料'),
  conflicts: z.array(z.string()).describe('来源冲突'),
  sourceLinks: z.array(z.url()).describe('来源和原文入口'),
});
export type JobDetailDto = z.infer<typeof JobDetailSchema>;
export const EvaluateInputSchema = z.strictObject({
  jobId: z.uuid().describe('要判断的岗位'),
  expectedJobVersion: z.uuid().describe('用户已看到的正文'),
  expectedProfileVersion: z
    .number()
    .int()
    .nonnegative()
    .describe('正式画像版本，无资料为0'),
  expectedReviewVersion: z
    .number()
    .int()
    .nonnegative()
    .describe('已见核验版本'),
  expectedEvidenceDependencyHash: z
    .string()
    .regex(/^[a-f\d]{64}$/)
    .describe('已见证据依赖'),
});
export type EvaluateInputDto = z.infer<typeof EvaluateInputSchema>;
export const NodeDecisionSchema = z
  .enum(['true', 'false', 'unknown'])
  .describe('明确满足、明确不符或资料不足');
export const EligibilityCheckItemSchema = z.strictObject({
  path: z.string().describe('条件树节点路径'),
  field: z.string().describe('节点或事实名称'),
  decision: NodeDecisionSchema,
  reason: z.string().describe('可解释依据与限制'),
  userFact: z.string().nullable().describe('仅本次判断必要的本人事实'),
  evidenceRefs: z.array(EvidenceRefSchema).describe('原文版本和定位'),
  missingFields: z.array(z.string()).describe('需要用户或运营补齐的内容'),
});
export type EligibilityCheckItem = z.infer<typeof EligibilityCheckItemSchema>;
export const EligibilitySchema = z.strictObject({
  checkId: z.uuid().describe('本人核验记录'),
  status: z
    .enum(['eligible', 'not_eligible', 'pending'])
    .describe('符合已核验条件、不符合或待核验'),
  checks: z
    .array(EligibilityCheckItemSchema)
    .describe('保留组合关系的逐节点结果'),
  jobId: z.uuid().describe('岗位'),
  jobVersionId: z.uuid().describe('所依赖正文'),
  profileVersion: z.number().int().nonnegative().describe('所用正式画像版本'),
  reviewVersion: z.number().int().nonnegative().describe('所用核验版本'),
  evidenceDependencyHash: z.string().describe('依据依赖摘要'),
  rulesVersion: z.string().describe('服务端规则版本'),
  evaluatedAt: z.iso.datetime().describe('首次判断时间'),
  isCurrent: z.boolean().describe('依赖和时间是否仍有效'),
  invalidatedReasons: z.array(z.string()).describe('历史结果失效原因'),
  warnings: z.array(z.string()).describe('判断范围和限制'),
});
export type EligibilityDto = z.infer<typeof EligibilitySchema>;
