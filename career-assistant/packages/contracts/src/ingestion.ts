import { z } from 'zod';

export const SourceKeySchema = z
  .literal('zhidianmijin')
  .describe('获准的岗位来源');
export const SourceIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/)
  .describe('源站不透明标识，不要求UUID版本');
export const RecruitmentTypeSchema = z
  .enum(['campus', 'social', 'unknown'])
  .describe('campus校招、social社招、unknown原文未明确');
export const TaskStatusSchema = z
  .enum(['queued', 'running', 'retry_wait', 'paused', 'failed', 'succeeded'])
  .describe(
    'queued等待领取、running执行、retry_wait退避、paused暂停、failed失败、succeeded已提交成功',
  );
export const EmptyInputSchema = z.strictObject({});
export const ResourcePathSchema = z.strictObject({
  id: z.uuid().describe('本地岗位或任务UUID'),
});
export const OperationKeySchema = z
  .uuid()
  .describe('调用方唯一操作标识，同内容重放不重复执行');
export const DiscoverInputSchema = z
  .strictObject({
    sourceKey: SourceKeySchema,
    stream: z.enum(['new', 'backfill']).describe('新增扫描或历史回填游标'),
    runId: OperationKeySchema,
    pageLimit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe('本轮最多列表页数'),
    checkpoint: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('受版本保护的起始页'),
    expectedCheckpointVersion: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('指定游标时必须提供当前版本'),
  })
  .refine(
    (v) =>
      (v.checkpoint === undefined) ===
      (v.expectedCheckpointVersion === undefined),
    '游标和版本必须同时提供',
  );
export type DiscoverInputDto = z.infer<typeof DiscoverInputSchema>;
export const DiscoverResultSchema = z.strictObject({
  taskId: z.uuid().describe('已持久化发现任务'),
  generation: z.number().int().nonnegative().describe('当前发现周期'),
  checkpointVersion: z
    .number()
    .int()
    .nonnegative()
    .describe('登记后的游标版本'),
});
export type DiscoverResultDto = z.infer<typeof DiscoverResultSchema>;
export const TaskSchema = z.strictObject({
  id: z.uuid().describe('公共任务标识'),
  kind: z.string().max(100).describe('发现或详情采集种类'),
  status: TaskStatusSchema,
  attempt: z.number().int().nonnegative().describe('已经领取次数'),
  updatedAt: z.iso.datetime().describe('最后状态变化'),
  relatedResourceId: z.string().max(200).describe('相关本地资源或来源流引用'),
  errorCode: z.string().max(100).optional().describe('脱敏稳定错误码'),
  nextRetryAt: z.iso.datetime().optional().describe('最早重试时间'),
  successorTaskId: z.uuid().optional().describe('较晚刷新请求对应的后继任务'),
});
export type TaskDto = z.infer<typeof TaskSchema>;
export const EvidenceRefSchema = z
  .strictObject({
    resourceId: z.uuid().describe('稳定证据资源'),
    versionId: z.uuid().describe('引用的不可变正文版本'),
    observationId: z.uuid().describe('实际获取观察'),
    block: z.number().int().nonnegative().describe('正文块编号'),
    start: z.number().int().nonnegative().describe('块内UTF16起始偏移'),
    end: z.number().int().positive().describe('不包含的结束偏移'),
    excerpt: z.string().min(1).max(4000).describe('精确对应正文片段'),
  })
  .refine((v) => v.end > v.start, '结束位置必须大于起点');
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
const RuleValueSchema = z
  .discriminatedUnion('field', [
    z.strictObject({
      field: z
        .enum([
          'degree',
          'major',
          'graduation_status',
          'certificate',
          'availability',
        ])
        .describe('原文条件约束的用户事实字段'),
      operator: z.enum(['eq', 'in']).describe('该事实字段允许的比较方式'),
      credentialRequirement: z
        .enum(['awarded', 'enrolled', 'expected_by_date', 'unknown'])
        .optional()
        .describe('学历取得要求，缺失不可猜测'),
      byDate: z.iso
        .date()
        .optional()
        .describe('公告允许预计取得学历的明确截止'),
      majorMatchMode: z
        .enum(['exact', 'group', 'related'])
        .optional()
        .describe('专业准确匹配方式'),
      certificateValidAt: z.iso
        .date()
        .optional()
        .describe('证书必须有效的公告日期'),
      value: z
        .array(z.string().min(1).max(200))
        .min(1)
        .max(30)
        .describe('与事实字段相符的类型化约束值'),
    }),
    z.strictObject({
      field: z
        .enum(['age', 'formal_experience_months'])
        .describe('原文条件约束的用户事实字段'),
      operator: z
        .enum(['gte', 'lte', 'between'])
        .describe('该事实字段允许的比较方式'),
      value: z
        .tuple([z.number().nonnegative(), z.number().nonnegative().nullable()])
        .describe('与事实字段相符的类型化约束值'),
      calculationDate: z.iso
        .date()
        .nullable()
        .describe('原文指定的计算日期，未说明为空'),
      ageBirthdayConvention: z
        .enum(['march_1', 'feb_28', 'unknown'])
        .optional()
        .describe('公告明确的闰日生日计算约定'),
      allowedExperience: z
        .enum(['formal', 'explicitly_includes_internship'])
        .describe('是否仅正式工作或原文明确允许实习'),
    }),
    z.strictObject({
      field: z
        .literal('graduation_date')
        .describe('原文条件约束的用户事实字段'),
      operator: z
        .enum(['before', 'after', 'between'])
        .describe('该事实字段允许的比较方式'),
      value: z
        .tuple([z.iso.date(), z.iso.date().nullable()])
        .describe('与事实字段相符的类型化约束值'),
    }),
  ])
  .superRefine((condition, context) => {
    if (
      condition.field === 'age' ||
      condition.field === 'formal_experience_months'
    ) {
      const [minimum, maximum] = condition.value;
      if (
        !Number.isInteger(minimum) ||
        (maximum !== null && !Number.isInteger(maximum)) ||
        (condition.operator === 'between'
          ? maximum === null || maximum < minimum
          : maximum !== null)
      )
        context.addIssue({
          code: 'custom',
          message: '数值条件范围或操作符不一致',
        });
    } else if (condition.field === 'graduation_date') {
      if (
        condition.operator === 'between'
          ? condition.value[1] === null ||
            condition.value[1] < condition.value[0]
          : condition.value[1] !== null
      )
        context.addIssue({
          code: 'custom',
          message: '日期条件范围或操作符不一致',
        });
    } else if (condition.operator === 'eq' && condition.value.length !== 1)
      context.addIssue({ code: 'custom', message: '等值条件只能提供一个值' });
  })
  .describe('按业务字段区分的条件值，资格计算留给岗位模块');
export type RuleCondition = z.infer<typeof RuleValueSchema>;
export type RuleNode =
  | { type: 'condition'; condition: RuleCondition; evidence: EvidenceRef[] }
  | { type: 'unknown'; reason: string; evidence: EvidenceRef[] }
  | { type: 'all' | 'any'; children: RuleNode[]; evidence: EvidenceRef[] }
  | {
      type: 'except';
      effect?: 'allow' | 'exclude' | undefined;
      base: RuleNode;
      exception: RuleNode;
      evidence: EvidenceRef[];
    };
const rule: z.ZodType<RuleNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('condition').describe('条件树节点语义'),
      condition: RuleValueSchema,
      evidence: z
        .array(EvidenceRefSchema)
        .min(1)
        .max(100)
        .describe('支撑节点的原文版本和定位引用'),
    }),
    z.strictObject({
      type: z.literal('unknown').describe('条件树节点语义'),
      reason: z.string().min(1).max(2000).describe('未能表达或核验的具体原因'),
      evidence: z
        .array(EvidenceRefSchema)
        .max(100)
        .describe('支撑节点的原文版本和定位引用'),
    }),
    z.strictObject({
      type: z.enum(['all', 'any']).describe('条件树节点语义'),
      children: z
        .array(rule)
        .min(1)
        .max(100)
        .describe('全部条件或任选条件的子节点'),
      evidence: z
        .array(EvidenceRefSchema)
        .max(100)
        .describe('支撑节点的原文版本和定位引用'),
    }),
    z.strictObject({
      effect: z
        .enum(['allow', 'exclude'])
        .optional()
        .describe('豁免或排除，缺失时未知'),
      type: z.literal('except').describe('例外条件节点'),
      base: rule,
      exception: rule,
      evidence: z
        .array(EvidenceRefSchema)
        .max(100)
        .describe('支撑节点的原文版本和定位引用'),
    }),
  ]),
);
// 在递归Schema前检查深度/节点，防止恶意深嵌套消耗调用栈。
export const RuleTreeSchema = z
  .unknown()
  .transform((input, context) => {
    const pending = [{ value: input, depth: 1 }];
    let count = 0;
    while (pending.length) {
      const current = pending.pop()!;
      if (++count > 100 || current.depth > 8) {
        context.addIssue({
          code: 'custom',
          message: '条件树超过节点或深度限制',
        });
        return z.NEVER;
      }
      if (current.value && typeof current.value === 'object') {
        const node = current.value as {
          children?: unknown;
          base?: unknown;
          exception?: unknown;
        };
        for (const child of [
          ...(Array.isArray(node.children) ? node.children : []),
          ...(node.base ? [node.base] : []),
          ...(node.exception ? [node.exception] : []),
        ])
          pending.push({ value: child, depth: current.depth + 1 });
      }
    }
    return input;
  })
  .pipe(rule)
  .describe('最多100节点、深度8的带依据条件树');
export const ReviewInputSchema = z.strictObject({
  jobId: z.uuid().describe('要核验的本地岗位'),
  expectedJobVersion: z.uuid().describe('审阅的岗位正文版本'),
  expectedReviewVersion: z
    .number()
    .int()
    .nonnegative()
    .describe('当前核验指针版本'),
  evidenceVersions: z
    .array(
      z.strictObject({
        resourceId: z.uuid().describe('证据资源'),
        versionId: z.uuid().describe('审阅版本'),
      }),
    )
    .min(1)
    .max(100)
    .describe('完整依赖版本向量'),
  tree: RuleTreeSchema,
  isComplete: z.boolean().describe('声明已审阅全部限制，仍由领域规则验证'),
  gaps: z
    .array(z.string().min(1).max(2000))
    .max(100)
    .describe('缺失或未能表达的条件'),
  conflicts: z
    .array(z.string().min(1).max(2000))
    .max(100)
    .describe('尚未解决的来源冲突'),
  reason: z.string().min(1).max(2000).describe('核验理由和审阅范围'),
  operationKey: OperationKeySchema,
});
export type ReviewInputDto = z.infer<typeof ReviewInputSchema>;
export const ReviewResultSchema = z.strictObject({
  reviewId: z.uuid().describe('不可变核验记录'),
  reviewVersion: z.number().int().positive().describe('新核验指针版本'),
  reviewedAt: z.iso.datetime().describe('实际审阅时刻'),
  isComplete: z.boolean().describe('结构和证据检查后的完整性'),
  warnings: z.array(z.string()).describe('尚待确认的范围'),
});
export type ReviewResultDto = z.infer<typeof ReviewResultSchema>;
export const RetryInputSchema = z.strictObject({
  taskId: z.uuid().describe('原任务'),
  expectedAttempt: z.number().int().nonnegative().describe('防止重试过时任务'),
  operationKey: OperationKeySchema,
});
export type RetryInputDto = z.infer<typeof RetryInputSchema>;
export const ExportInputSchema = z.union([
  z.strictObject({
    scope: z.literal('all').describe('全部实际采集公共记录'),
    operationKey: OperationKeySchema,
  }),
  z.strictObject({
    existingExportId: z.uuid().describe('已固定一致视图的导出编号'),
  }),
]);
export type ExportInputDto = z.infer<typeof ExportInputSchema>;
export const ExportResultSchema = z.strictObject({
  exportId: z.uuid().describe('稳定导出编号'),
  snapshotAt: z.iso.datetime().describe('一致视图取时'),
  status: z.enum(['pending', 'completed']).describe('是否已原子发布文件'),
  manifestDigest: z.string().nullable().describe('固定内容摘要，未完成为空'),
  recordCount: z.number().int().nonnegative().describe('公共资源数量'),
  fileName: z.string().nullable().describe('配置目录内受控文件名'),
});
export type ExportResultDto = z.infer<typeof ExportResultSchema>;
export const TrustSchema = z.strictObject({
  computedAt: z.iso.datetime().describe('统计实际计算时刻'),
  firstFetchedAt: z.iso.datetime().nullable().describe('首次成功获取'),
  lastFetchedAt: z.iso.datetime().nullable().describe('最近成功获取'),
  counts: z
    .strictObject({
      campus: z.number().int().nonnegative().describe('实际获取的校招岗位数量'),
      social: z.number().int().nonnegative().describe('实际获取的社招岗位数量'),
      unknown: z
        .number()
        .int()
        .nonnegative()
        .describe('实际获取且招聘类型未明确的岗位数量'),
      fetched: z
        .number()
        .int()
        .nonnegative()
        .describe('已经成功获取有效正文的岗位数量'),
      reviewed: z
        .number()
        .int()
        .nonnegative()
        .describe('当前具有完整核验记录的岗位数量'),
      fresh: z
        .number()
        .int()
        .nonnegative()
        .describe('完整核验且尚在有效新鲜度内的岗位数量'),
    })
    .describe('招聘类型、已获取、完整已核验与当前新鲜数量'),
  queues: z
    .array(
      z.strictObject({
        status: TaskStatusSchema,
        count: z
          .number()
          .int()
          .nonnegative()
          .describe('对应状态的实际任务条数'),
      }),
    )
    .describe('采集任务状态聚合'),
  pausedSources: z.array(z.string()).describe('脱敏暂停类别'),
  coverageWarnings: z.array(z.string()).describe('实际覆盖缺口'),
  verifiedScope: z.array(z.string()).describe('真实证据支持的覆盖范围'),
});
export type TrustDto = z.infer<typeof TrustSchema>;
