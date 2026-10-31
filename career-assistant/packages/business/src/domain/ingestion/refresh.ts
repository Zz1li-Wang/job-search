import { z } from 'zod';
import { IngestionError } from './errors.js';
import { INGESTION_POLICY } from './policy.js';
const RefreshQuotaStateSchema = z.object({
  occupiedSlots: z
    .array(z.boolean())
    .length(INGESTION_POLICY.refreshRatePerMinute)
    .describe('本账号当前分钟的持久化占用槽位'),
  previousRequestedAt: z
    .date()
    .nullable()
    .describe('上一个已终结刷新任务的请求时间'),
});
type RefreshQuotaState = z.infer<typeof RefreshQuotaStateSchema>;
/** 刷新频率属于领域决策，应用层只负责读取分钟槽和持久化决定。 */
export class RefreshQuotaEntity {
  private readonly state: RefreshQuotaState;
  constructor(state: RefreshQuotaState) {
    this.state = structuredClone(RefreshQuotaStateSchema.parse(state));
  }
  availableSlot(): number {
    const index = this.state.occupiedSlots.findIndex((occupied) => !occupied);
    if (index < 0) throw new IngestionError('INGESTION_RATE_LIMITED');
    return index;
  }
  assertMayCreate(now: Date): void {
    if (
      this.state.previousRequestedAt &&
      now.getTime() - this.state.previousRequestedAt.getTime() <
        INGESTION_POLICY.minimumRefreshMs
    )
      throw new IngestionError('INGESTION_RATE_LIMITED');
  }
}
