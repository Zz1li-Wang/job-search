import { z } from 'zod';
import type { AccountEntity } from './account.js';
import { AUTH_POLICY } from './policy.js';
import { AuthError } from './errors.js';

export const AttemptStateSchema = z.object({
  identityDigest: z
    .string()
    .regex(/^[a-f\d]{64}$/)
    .describe('规范化用户名的隔离摘要'),
  consecutiveFailures: z
    .number()
    .int()
    .nonnegative()
    .describe('连续密码失败次数'),
  cooldownUntil: z
    .date()
    .nullable()
    .describe('冷却结束时间，不存在账号同样登记'),
  updatedAt: z.date().describe('最近一次尝试结果时间'),
});
export type AttemptState = z.infer<typeof AttemptStateSchema>;
export class AttemptEntity {
  private readonly state: AttemptState;
  constructor(state: AttemptState) {
    this.state = structuredClone(AttemptStateSchema.parse(state));
  }
  static fresh(identityDigest: string, now: Date) {
    return new AttemptEntity({
      identityDigest,
      consecutiveFailures: 0,
      cooldownUntil: null,
      updatedAt: now,
    });
  }
  snapshot(): AttemptState {
    return {
      ...this.state,
      cooldownUntil: this.state.cooldownUntil
        ? new Date(this.state.cooldownUntil)
        : null,
      updatedAt: new Date(this.state.updatedAt),
    };
  }
  assertAvailable(now: Date): void {
    if (this.state.cooldownUntil && this.state.cooldownUntil > now)
      throw new AuthError(
        'AUTH_RATE_LIMITED',
        Math.ceil((this.state.cooldownUntil.getTime() - now.getTime()) / 1000),
      );
  }
  failed(now: Date): AttemptEntity {
    this.assertAvailable(now);
    const previous =
      this.state.cooldownUntil && this.state.cooldownUntil <= now
        ? 0
        : this.state.consecutiveFailures;
    const consecutiveFailures = previous + 1;
    return new AttemptEntity({
      ...this.state,
      consecutiveFailures,
      cooldownUntil:
        consecutiveFailures >= AUTH_POLICY.failureLimit
          ? new Date(now.getTime() + AUTH_POLICY.cooldownMs)
          : null,
      updatedAt: now,
    });
  }
  succeeded(now: Date): AttemptEntity {
    return AttemptEntity.fresh(this.state.identityDigest, now);
  }
  decideLogin(
    account: AccountEntity | null,
    expectedEpoch: number | null,
    verified: boolean,
    now: Date,
  ):
    | { isAccepted: true; attempt: AttemptEntity; account: AccountEntity }
    | { isAccepted: false; attempt: AttemptEntity } {
    this.assertAvailable(now);
    if (!account || !account.acceptsCredentials(expectedEpoch, verified))
      return { isAccepted: false, attempt: this.failed(now) };
    return { isAccepted: true, attempt: this.succeeded(now), account };
  }
}
