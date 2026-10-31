import { z } from 'zod';
import { AuthError } from './errors.js';

export const AccountStateSchema = z.object({
  id: z.uuid().describe('账号标识'),
  usernameNormalized: z
    .string()
    .regex(/^[a-z0-9_]{3,32}$/)
    .describe('唯一规范化用户名'),
  passwordHash: z
    .string()
    .min(1)
    .max(512)
    .describe('内部带参数密码摘要，禁止进入公开DTO'),
  personalDataEpoch: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('个人资料删除屏障'),
  authEpoch: z
    .number()
    .int()
    .nonnegative()
    .describe('修改密码后递增的认证版本'),
  createdAt: z.date().describe('首次创建时间'),
  updatedAt: z.date().describe('最后密码或账号变化时间'),
  deletedAt: z.date().nullable().describe('非空时账号不可认证'),
});
export type AccountState = z.infer<typeof AccountStateSchema>;
export class AccountEntity {
  private readonly state: AccountState;
  constructor(state: z.input<typeof AccountStateSchema>) {
    this.state = structuredClone(AccountStateSchema.parse(state));
  }
  snapshot(): AccountState {
    return {
      ...this.state,
      createdAt: new Date(this.state.createdAt),
      updatedAt: new Date(this.state.updatedAt),
      deletedAt: this.state.deletedAt ? new Date(this.state.deletedAt) : null,
    };
  }
  assertActive(): void {
    if (this.state.deletedAt) throw new AuthError('AUTH_UNAUTHENTICATED');
  }
  assertEpoch(expected: number): void {
    if (this.state.authEpoch !== expected)
      throw new AuthError('AUTH_VERSION_CONFLICT');
  }
  acceptsCredentials(
    expectedEpoch: number | null,
    isPasswordCorrect: boolean,
  ): boolean {
    return (
      !this.state.deletedAt &&
      isPasswordCorrect &&
      expectedEpoch === this.state.authEpoch
    );
  }
  clearPersonalData(now: Date) {
    this.assertActive();
    return new AccountEntity({
      ...this.state,
      personalDataEpoch: this.state.personalDataEpoch + 1,
      updatedAt: now,
    });
  }
  close(now: Date) {
    this.assertActive();
    return new AccountEntity({
      ...this.state,
      usernameNormalized: `deleted_${this.state.id.replaceAll('-', '').slice(0, 24)}`,
      passwordHash: 'erased',
      authEpoch: this.state.authEpoch + 1,
      personalDataEpoch: this.state.personalDataEpoch + 1,
      updatedAt: now,
      deletedAt: now,
    });
  }
  replacePassword(
    passwordHash: string,
    expectedEpoch: number,
    now: Date,
  ): AccountEntity {
    this.assertActive();
    this.assertEpoch(expectedEpoch);
    return new AccountEntity({
      ...this.state,
      passwordHash,
      authEpoch: expectedEpoch + 1,
      updatedAt: now,
    });
  }
}
