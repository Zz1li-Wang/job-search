import { z } from 'zod';
import type { AccountEntity } from './account.js';
import { AuthError } from './errors.js';

export const SessionStateSchema = z.object({
  id: z.uuid().describe('会话标识'),
  userId: z.uuid().describe('所属账号'),
  tokenDigest: z
    .string()
    .regex(/^[a-f\d]{64}$/)
    .describe('会话令牌的HMAC摘要'),
  authEpoch: z
    .number()
    .int()
    .nonnegative()
    .describe('会话创建时的账号认证版本'),
  expiresAt: z.date().describe('固定到期时间'),
  revokedAt: z.date().nullable().describe('主动撤销时间'),
  createdAt: z.date().describe('会话创建时间'),
});
export type SessionState = z.infer<typeof SessionStateSchema>;
export class SessionEntity {
  private readonly state: SessionState;
  constructor(state: SessionState) {
    this.state = structuredClone(SessionStateSchema.parse(state));
  }
  snapshot(): SessionState {
    return {
      ...this.state,
      createdAt: new Date(this.state.createdAt),
      expiresAt: new Date(this.state.expiresAt),
      revokedAt: this.state.revokedAt ? new Date(this.state.revokedAt) : null,
    };
  }
  authorize(account: AccountEntity | null, now: Date): void {
    if (
      !account ||
      this.state.revokedAt ||
      this.state.expiresAt <= now ||
      account.snapshot().id !== this.state.userId ||
      account.snapshot().authEpoch !== this.state.authEpoch ||
      account.snapshot().deletedAt
    )
      throw new AuthError('AUTH_UNAUTHENTICATED');
  }
  revoke(now: Date): SessionEntity {
    return new SessionEntity({
      ...this.state,
      revokedAt: this.state.revokedAt ?? now,
    });
  }
}
