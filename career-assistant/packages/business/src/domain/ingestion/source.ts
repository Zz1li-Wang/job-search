import { z } from 'zod';
import { IngestionError } from './errors.js';
import { INGESTION_POLICY } from './policy.js';

export const SourceStreamStateSchema = z.object({
  id: z.string().describe('来源与扫描流唯一键'),
  streamKey: z.enum(['new', 'backfill']).describe('扫描流类别'),
  generation: z.number().int().nonnegative().describe('发现周期'),
  checkpoint: z.number().int().positive().describe('下一待登记页'),
  checkpointVersion: z.number().int().nonnegative().describe('游标CAS版本'),
  nextDiscoveryAt: z.date().describe('下一周期最早时间'),
  pauseReason: z.string().nullable().describe('来源暂停原因'),
  stateVersion: z.number().int().nonnegative().describe('并发编辑版本'),
});
export type SourceStreamState = z.infer<typeof SourceStreamStateSchema>;
export class SourceStreamEntity {
  private readonly state: SourceStreamState;
  constructor(state: SourceStreamState) {
    this.state = structuredClone(SourceStreamStateSchema.parse(state));
  }
  snapshot(): SourceStreamState {
    return structuredClone(this.state);
  }
  start(now: Date, page?: number, expected?: number): SourceStreamEntity {
    if (expected !== undefined && expected !== this.state.checkpointVersion)
      throw new IngestionError('TASK_VERSION_CONFLICT');
    return new SourceStreamEntity({
      ...this.state,
      generation: this.state.generation + 1,
      checkpoint:
        page ?? (this.state.streamKey === 'new' ? 1 : this.state.checkpoint),
      checkpointVersion: this.state.checkpointVersion + 1,
      stateVersion: this.state.stateVersion + 1,
      nextDiscoveryAt: new Date(now.getTime() + INGESTION_POLICY.discoveryMs),
    });
  }
  advance(
    expected: number,
    generation: number,
    nextPage: number,
  ): SourceStreamEntity {
    if (
      expected !== this.state.checkpointVersion ||
      generation !== this.state.generation ||
      nextPage <= this.state.checkpoint
    )
      throw new IngestionError('TASK_VERSION_CONFLICT');
    return new SourceStreamEntity({
      ...this.state,
      checkpoint: nextPage,
      checkpointVersion: expected + 1,
      stateVersion: this.state.stateVersion + 1,
    });
  }
  pause(reason: string | null): SourceStreamEntity {
    return new SourceStreamEntity({
      ...this.state,
      pauseReason: reason,
      stateVersion: this.state.stateVersion + 1,
    });
  }
}
export const BodyStateSchema = z.object({
  title: z.string().min(1).max(1000).describe('原文标题'),
  company: z.string().max(1000).nullable().describe('原文招聘单位，缺失不猜测'),
  cities: z.array(z.string().max(200)).describe('原文明确地点'),
  recruitmentType: z
    .enum(['campus', 'social', 'unknown'])
    .describe('招聘类型不代表资格'),
  blocks: z
    .array(z.string().max(100000))
    .min(1)
    .max(2000)
    .describe('已去敏且可定位的正文块'),
  deadline: z
    .object({
      value: z.string().nullable().describe('与事实字段相符的类型化约束值'),
      precision: z
        .enum(['instant', 'date', 'unknown'])
        .describe('精确时刻、日期或尚未明确'),
      timezone: z.string().nullable().describe('原文明确时区，未确认时为空'),
    })
    .describe('保留原文日期精度与时区'),
  availability: z
    .enum(['open', 'closed', 'unknown'])
    .describe('只有明确原文才标关闭或开放'),
  links: z
    .array(
      z.object({
        kind: z
          .enum(['job', 'announcement', 'external'])
          .describe('来源资源或任务的明确类别'),
        sourceId: z
          .string()
          .nullable()
          .describe('不透明来源标识，外站入口为空'),
        url: z.string().max(4000).describe('原文实际出现且已规范化的来源入口'),
      }),
    )
    .max(1000)
    .describe('实际出现的关联或外部入口'),
  parserVersion: z.string().describe('定位及字段解析规则版本'),
});
export type EvidenceBody = z.infer<typeof BodyStateSchema>;
export const ResourceStateSchema = z.object({
  id: z.uuid().describe('证据资源稳定UUID'),
  kind: z.enum(['job', 'announcement']).describe('岗位或公告'),
  sourceId: z.string().max(200).describe('源站不透明ID'),
  canonicalUrl: z.string().describe('受控规范化URL'),
  currentVersionId: z.uuid().nullable().describe('当前正文版本'),
  lastAttemptAt: z.date().nullable().describe('最近尝试'),
  lastFetchedAt: z.date().nullable().describe('最近成功获取有效正文'),
  nextRefreshAt: z.date().describe('下一次目标复查时间'),
  reviewVersion: z.number().int().nonnegative().describe('当前核验指针版本'),
  currentReviewId: z.uuid().nullable().describe('当前核验，变化时清空'),
  stateVersion: z.number().int().nonnegative().describe('乐观更新版本'),
});
export type ResourceState = z.infer<typeof ResourceStateSchema>;
export class SourceResourceEntity {
  private readonly state: ResourceState;
  constructor(state: ResourceState) {
    this.state = structuredClone(ResourceStateSchema.parse(state));
  }
  snapshot(): ResourceState {
    return structuredClone(this.state);
  }
  refreshPriority(body: EvidenceBody | null, now: Date): number {
    const deadline =
      body?.deadline.precision === 'instant' && body.deadline.value
        ? new Date(body.deadline.value).getTime()
        : null;
    if (
      deadline !== null &&
      deadline > now.getTime() &&
      deadline - now.getTime() <= INGESTION_POLICY.urgentWindowMs
    )
      return 1;
    return this.state.currentReviewId ? 2 : 4;
  }
  observe(
    versionId: string,
    now: Date,
    body: EvidenceBody,
  ): SourceResourceEntity {
    const deadline =
      body.deadline.precision === 'instant' && body.deadline.value
        ? new Date(body.deadline.value).getTime()
        : null;
    const urgent =
      deadline !== null &&
      deadline > now.getTime() &&
      deadline - now.getTime() <= INGESTION_POLICY.urgentWindowMs;
    return new SourceResourceEntity({
      ...this.state,
      currentVersionId: versionId,
      lastAttemptAt: now,
      lastFetchedAt: now,
      nextRefreshAt: new Date(
        now.getTime() +
          (urgent ? INGESTION_POLICY.urgentMs : INGESTION_POLICY.refreshMs),
      ),
      currentReviewId:
        this.state.currentVersionId === versionId
          ? this.state.currentReviewId
          : null,
      stateVersion: this.state.stateVersion + 1,
    });
  }
  attempt(now: Date): SourceResourceEntity {
    return new SourceResourceEntity({
      ...this.state,
      lastAttemptAt: now,
      stateVersion: this.state.stateVersion + 1,
    });
  }
  invalidate(): SourceResourceEntity {
    return new SourceResourceEntity({
      ...this.state,
      currentReviewId: null,
      stateVersion: this.state.stateVersion + 1,
    });
  }
  reviewed(id: string, expected: number): SourceResourceEntity {
    if (expected !== this.state.reviewVersion)
      throw new IngestionError('EVIDENCE_VERSION_CONFLICT');
    return new SourceResourceEntity({
      ...this.state,
      currentReviewId: id,
      reviewVersion: expected + 1,
      stateVersion: this.state.stateVersion + 1,
    });
  }
}
export function freshness(
  body: EvidenceBody,
  verifiedAt: Date | null,
  now: Date,
): 'closed' | 'fresh' | 'pending' {
  if (body.availability === 'closed') return 'closed';
  const cutoff = body.deadline.value;
  if (
    body.deadline.precision === 'instant' &&
    cutoff &&
    new Date(cutoff) <= now
  )
    return 'closed';
  if (
    body.deadline.precision === 'date' &&
    cutoff &&
    new Intl.DateTimeFormat('en-CA', {
      timeZone: body.deadline.timezone ?? 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now) >= cutoff
  )
    return 'pending';
  if (body.availability !== 'open' || !verifiedAt) return 'pending';
  const urgent =
    body.deadline.precision === 'instant' &&
    cutoff &&
    new Date(cutoff).getTime() - now.getTime() <=
      INGESTION_POLICY.urgentWindowMs;
  return now.getTime() - verifiedAt.getTime() >
    (urgent ? INGESTION_POLICY.urgentMs : INGESTION_POLICY.refreshMs)
    ? 'pending'
    : 'fresh';
}
