import { z } from 'zod';
import { IngestionError } from './errors.js';
import { INGESTION_POLICY } from './policy.js';

const TargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('discover').describe('来源资源或任务的明确类别'),
    streamKey: z.enum(['new', 'backfill']).describe('新增扫描或历史回填流'),
    page: z.number().int().positive().describe('当前实际请求页码'),
    remaining: z.number().int().positive().describe('本周期剩余允许页数'),
    generation: z.number().int().nonnegative().describe('来源发现周期版本'),
    checkpointVersion: z
      .number()
      .int()
      .nonnegative()
      .describe('当前页登记对应游标版本'),
  }),
  z.object({
    kind: z.literal('fetch').describe('来源资源或任务的明确类别'),
    resourceId: z.uuid().describe('稳定来源证据资源UUID'),
  }),
]);
export type TaskTarget = z.infer<typeof TargetSchema>;
export const SourceTaskStateSchema = z.object({
  id: z.uuid().describe('稳定任务UUID'),
  eventKey: z.string().max(200).describe('首次事件唯一键'),
  dedupeKey: z.string().max(200).describe('活跃任务自然合并键'),
  sourceKey: z.literal('zhidianmijin').describe('任务允许来源'),
  kind: z.string().max(100).describe('采集任务种类'),
  resourceReference: z.string().max(200).describe('业务资源引用'),
  target: TargetSchema.describe('经校验的执行目标，不含任意URL'),
  status: z
    .enum(['queued', 'running', 'retry_wait', 'paused', 'failed', 'succeeded'])
    .describe('任务当前状态'),
  priority: z.number().int().nonnegative().describe('较小值优先'),
  attempt: z.number().int().nonnegative().describe('执行次数'),
  attemptLimit: z
    .number()
    .int()
    .positive()
    .describe('本次恢复允许的累计尝试上限'),
  fencingToken: z
    .number()
    .int()
    .nonnegative()
    .describe('每次领取递增的写入围栏'),
  leaseUntil: z.date().nullable().describe('执行租约截止'),
  availableAt: z.date().describe('最早可执行时刻'),
  completedAt: z.date().nullable().describe('成功提交时刻'),
  updatedAt: z.date().describe('最近状态变化'),
  requestedAt: z.date().describe('最后刷新请求时刻'),
  refreshGeneration: z.number().int().nonnegative().describe('请求代次'),
  claimedRefreshGeneration: z
    .number()
    .int()
    .nonnegative()
    .describe('领取时请求代次'),
  errorCode: z.string().nullable().describe('脱敏错误分类'),
  successorTaskId: z.uuid().nullable().describe('领取后新请求的后继任务'),
});
export type SourceTaskState = z.infer<typeof SourceTaskStateSchema>;
export class SourceTaskEntity {
  private readonly state: SourceTaskState;
  constructor(state: SourceTaskState) {
    this.state = structuredClone(SourceTaskStateSchema.parse(state));
  }
  snapshot(): SourceTaskState {
    return structuredClone(this.state);
  }
  assertLease(token: number, now: Date): void {
    if (
      this.state.status !== 'running' ||
      this.state.fencingToken !== token ||
      !this.state.leaseUntil ||
      this.state.leaseUntil <= now
    )
      throw new IngestionError('TASK_VERSION_CONFLICT');
  }
  claim(now: Date): SourceTaskEntity {
    const s = this.state;
    const ready =
      (s.status === 'queued' || s.status === 'retry_wait') &&
      s.availableAt <= now;
    const expired =
      s.status === 'running' && s.leaseUntil !== null && s.leaseUntil <= now;
    if ((!ready && !expired) || s.attempt >= s.attemptLimit)
      throw new IngestionError('TASK_VERSION_CONFLICT');
    return new SourceTaskEntity({
      ...s,
      status: 'running',
      attempt: s.attempt + 1,
      fencingToken: s.fencingToken + 1,
      leaseUntil: new Date(now.getTime() + INGESTION_POLICY.leaseMs),
      claimedRefreshGeneration: s.refreshGeneration,
      updatedAt: now,
      errorCode: null,
    });
  }
  renew(token: number, now: Date): SourceTaskEntity {
    this.assertLease(token, now);
    return new SourceTaskEntity({
      ...this.state,
      leaseUntil: new Date(now.getTime() + INGESTION_POLICY.leaseMs),
      updatedAt: now,
    });
  }
  request(now: Date): SourceTaskEntity {
    if (
      !['queued', 'retry_wait', 'running', 'paused'].includes(this.state.status)
    )
      throw new IngestionError('TASK_VERSION_CONFLICT');
    return new SourceTaskEntity({
      ...this.state,
      requestedAt: now,
      refreshGeneration: this.state.refreshGeneration + 1,
    });
  }
  finish(
    token: number,
    now: Date,
    successorTaskId: string | null = null,
  ): SourceTaskEntity {
    this.assertLease(token, now);
    return new SourceTaskEntity({
      ...this.state,
      status: 'succeeded',
      completedAt: now,
      leaseUntil: null,
      errorCode: null,
      updatedAt: now,
      successorTaskId,
    });
  }
  needsSuccessor(): boolean {
    return this.state.refreshGeneration > this.state.claimedRefreshGeneration;
  }
  fail(
    token: number,
    now: Date,
    error: IngestionError,
    jitter: number,
  ): SourceTaskEntity {
    this.assertLease(token, now);
    const isPaused = [
      'SOURCE_ACCESS_BLOCKED',
      'SOURCE_BUDGET_EXHAUSTED',
    ].includes(error.code);
    const canRetry =
      [
        'SOURCE_UNAVAILABLE',
        'SOURCE_RATE_LIMITED',
        'INGESTION_STORAGE_UNAVAILABLE',
      ].includes(error.code) && this.state.attempt < this.state.attemptLimit;
    const delay = Math.max(
      this.state.attempt === 1 ? 5000 : 30000,
      Math.min(error.retryAfterMs ?? 0, 86_400_000),
    );
    return new SourceTaskEntity({
      ...this.state,
      status: isPaused ? 'paused' : canRetry ? 'retry_wait' : 'failed',
      errorCode: error.code,
      leaseUntil: null,
      updatedAt: now,
      availableAt: new Date(
        now.getTime() + delay * (1 + Math.max(0, Math.min(0.2, jitter))),
      ),
    });
  }
  retry(expectedAttempt: number, now: Date): SourceTaskEntity {
    if (
      this.state.attempt !== expectedAttempt ||
      !['failed', 'paused'].includes(this.state.status)
    )
      throw new IngestionError('TASK_VERSION_CONFLICT');
    if (
      ![
        'SOURCE_ACCESS_BLOCKED',
        'SOURCE_BUDGET_EXHAUSTED',
        'SOURCE_PARSE_UNSUPPORTED',
        'SOURCE_UNAVAILABLE',
        'SOURCE_RATE_LIMITED',
        'INGESTION_STORAGE_UNAVAILABLE',
      ].includes(this.state.errorCode ?? '')
    )
      throw new IngestionError('TASK_VERSION_CONFLICT');
    // 人工恢复保留尝试历史，自动尝试预算按恢复后的基线由执行器记录。
    return new SourceTaskEntity({
      ...this.state,
      status: 'queued',
      attemptLimit: this.state.attempt + INGESTION_POLICY.maxAttempts,
      availableAt: now,
      leaseUntil: null,
      errorCode: null,
      updatedAt: now,
    });
  }
}
export function newSourceTask(
  id: string,
  eventKey: string,
  dedupeKey: string,
  target: TaskTarget,
  now: Date,
  priority = 4,
): SourceTaskEntity {
  return new SourceTaskEntity({
    id,
    eventKey,
    dedupeKey,
    target,
    sourceKey: 'zhidianmijin',
    kind: `source.${target.kind}`,
    resourceReference:
      target.kind === 'fetch' ? target.resourceId : target.streamKey,
    status: 'queued',
    priority,
    attempt: 0,
    attemptLimit: INGESTION_POLICY.maxAttempts,
    fencingToken: 0,
    leaseUntil: null,
    availableAt: now,
    completedAt: null,
    updatedAt: now,
    requestedAt: now,
    refreshGeneration: 0,
    claimedRefreshGeneration: 0,
    errorCode: null,
    successorTaskId: null,
  });
}
