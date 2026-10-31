import { z } from 'zod';
import { AUTH_POLICY, type AuthRateScope } from './policy.js';
import { AuthError } from './errors.js';

export const RateBucketStateSchema = z.object({
  scope: z
    .enum(['captcha', 'credentials', 'password'])
    .describe('验证码、注册登录或改密的独立计数范围'),
  subjectDigest: z
    .string()
    .regex(/^[a-f\d]{64}$/)
    .describe('来源隔离摘要，不保存IP明文'),
  windowStart: z.date().describe('固定分钟窗口起点'),
  attemptCount: z.number().int().nonnegative().describe('窗口内已允许次数'),
  expiresAt: z.date().describe('窗口终点'),
});
export type RateBucketState = z.infer<typeof RateBucketStateSchema>;
export class RateBucketEntity {
  private readonly state: RateBucketState;
  constructor(state: RateBucketState) {
    this.state = structuredClone(RateBucketStateSchema.parse(state));
  }
  static start(
    scope: AuthRateScope,
    subjectDigest: string,
    now: Date,
  ): RateBucketEntity {
    const start =
      Math.floor(now.getTime() / AUTH_POLICY.rateWindowMs) *
      AUTH_POLICY.rateWindowMs;
    return new RateBucketEntity({
      scope,
      subjectDigest,
      windowStart: new Date(start),
      attemptCount: 0,
      expiresAt: new Date(start + AUTH_POLICY.rateWindowMs),
    });
  }
  snapshot(): RateBucketState {
    return {
      ...this.state,
      windowStart: new Date(this.state.windowStart),
      expiresAt: new Date(this.state.expiresAt),
    };
  }
  reserve(now: Date): RateBucketEntity {
    if (this.state.attemptCount >= AUTH_POLICY.limits[this.state.scope])
      throw new AuthError(
        'AUTH_RATE_LIMITED',
        Math.max(
          1,
          Math.ceil((this.state.expiresAt.getTime() - now.getTime()) / 1000),
        ),
      );
    return new RateBucketEntity({
      ...this.state,
      attemptCount: this.state.attemptCount + 1,
    });
  }
}
