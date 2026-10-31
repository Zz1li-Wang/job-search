import { z } from 'zod';

export const IdempotencyRecordSchema = z.object({
  scope: z.string().min(1).max(100).describe('调用身份与操作组成的稳定作用域'),
  key: z.uuid().describe('请求幂等键'),
  requestHash: z
    .string()
    .regex(/^[a-f\d]{64}$/)
    .describe('规范化请求摘要'),
  responseReference: z
    .string()
    .max(200)
    .describe('已持久化结果的引用，不保存敏感响应全文'),
  createdAt: z.date().describe('首次登记时刻，由用例显式提供'),
});
export type IdempotencyRecordSnapshot = z.infer<typeof IdempotencyRecordSchema>;
/** 同键内容不同应返回冲突，调用方需换键或恢复原请求，不得覆盖首次结果。 */
export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor() {
    super('幂等键已对应其他请求');
  }
}
export class IdempotencyRecord {
  private readonly record: IdempotencyRecordSnapshot;
  constructor(snapshot: IdempotencyRecordSnapshot) {
    const parsed = IdempotencyRecordSchema.parse(snapshot);
    this.record = { ...parsed, createdAt: new Date(parsed.createdAt) };
  }
  snapshot(): IdempotencyRecordSnapshot {
    return { ...this.record, createdAt: new Date(this.record.createdAt) };
  }
  assertSameRequest(requestHash: string): void {
    if (requestHash !== this.record.requestHash)
      throw new IdempotencyConflictError();
  }
}
