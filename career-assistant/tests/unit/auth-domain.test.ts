import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  PasswordSchema,
  RegisterInputSchema,
  SessionCredentialInputSchema,
} from '@career/contracts';
import {
  AccountEntity,
  SessionEntity,
  ChallengeEntity,
  AttemptEntity,
  RateBucketEntity,
  AUTH_POLICY,
  AuthError,
} from '@career/business';
import { AuthConfigSchema } from '@career/config';

const now = new Date('2026-10-30T08:00:00.000Z');
function account() {
  return new AccountEntity({
    id: randomUUID(),
    usernameNormalized: 'example_user',
    passwordHash: 'internal-hash',
    authEpoch: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
}
describe('认证DTO与领域规则', () => {
  it('密码按Unicode码点校验而不裁剪，拒绝额外身份字段', () => {
    expect(PasswordSchema.safeParse('😀'.repeat(12)).success).toBe(true);
    expect(PasswordSchema.safeParse('😀'.repeat(6)).success).toBe(false);
    expect(PasswordSchema.safeParse('x'.repeat(129)).success).toBe(false);
    expect(PasswordSchema.parse(' '.repeat(12))).toBe(' '.repeat(12));
    const input = {
      username: 'Example_User',
      password: 'synthetic-password',
      captchaId: randomUUID(),
      captchaAnswer: '234567',
    };
    expect(RegisterInputSchema.safeParse(input).success).toBe(true);
    expect(
      RegisterInputSchema.safeParse({ ...input, userId: randomUUID() }).success,
    ).toBe(false);
    expect(
      RegisterInputSchema.safeParse({ ...input, username: ' bad ' }).success,
    ).toBe(false);
    expect(
      RegisterInputSchema.safeParse({ ...input, captchaAnswer: '012345' })
        .success,
    ).toBe(false);
    expect(
      SessionCredentialInputSchema.safeParse({ sessionCredential: 'invalid' })
        .success,
    ).toBe(false);
  });
  it('生产Origin禁止HTTP，秘密不能为空', () => {
    const config = {
      AUTH_TOKEN_PEPPER: 'p'.repeat(32),
      AUTH_CSRF_SECRET: 's'.repeat(32),
      NODE_ENV: 'production',
      AUTH_PUBLIC_ORIGIN: 'https://career.example',
    };
    expect(AuthConfigSchema.safeParse(config).success).toBe(true);
    expect(
      AuthConfigSchema.safeParse({
        ...config,
        AUTH_CSRF_SECRET: config.AUTH_TOKEN_PEPPER,
      }).success,
    ).toBe(false);
    expect(
      AuthConfigSchema.safeParse({
        ...config,
        AUTH_TOKEN_PEPPER: 'replace_with_an_independent_random_secret',
      }).success,
    ).toBe(false);
    expect(
      AuthConfigSchema.safeParse({
        ...config,
        AUTH_PUBLIC_ORIGIN: 'http://career.example',
      }).success,
    ).toBe(false);
    expect(
      AuthConfigSchema.safeParse({ ...config, AUTH_TOKEN_PEPPER: '' }).success,
    ).toBe(false);
    expect(
      AuthConfigSchema.safeParse({
        ...config,
        AUTH_PUBLIC_ORIGIN: 'https://career.example/path',
      }).success,
    ).toBe(false);
  });
  it('其他浏览器不能消费挑战，答错和到期尝试均消费', () => {
    const challenge = new ChallengeEntity({
      id: randomUUID(),
      visitorDigest: 'a'.repeat(64),
      answerDigest: 'b'.repeat(64),
      expiresAt: new Date(now.getTime() + 1000),
      consumedAt: null,
      createdAt: now,
    });
    expect(challenge.evaluate(false, true, now).shouldPersist).toBe(false);
    const failed = challenge.evaluate(true, false, now);
    expect(failed.shouldPersist).toBe(true);
    expect(failed.isValid).toBe(false);
    expect(failed.challenge.evaluate(true, true, now).shouldPersist).toBe(
      false,
    );
    const boundary = challenge.evaluate(
      true,
      true,
      new Date(now.getTime() + 1000),
    );
    expect(boundary.shouldPersist).toBe(true);
    expect(boundary.isValid).toBe(false);
    expect(challenge.evaluate(true, true, now).isValid).toBe(true);
  });
  it('改密版本不可覆盖，删除账号不能使用旧凭据', () => {
    const owner = account();
    const changed = owner.replacePassword('new-internal-hash', 0, now);
    expect(changed.snapshot().authEpoch).toBe(1);
    expect(owner.snapshot().authEpoch).toBe(0);
    expect(() => changed.replacePassword('other', 0, now)).toThrow(AuthError);
    expect(
      new AccountEntity({
        ...owner.snapshot(),
        deletedAt: now,
      }).acceptsCredentials(0, true),
    ).toBe(false);
    expect(changed.acceptsCredentials(0, true)).toBe(false);
  });
  it('会话到期、撤销、错误账号及旧epoch均不可用', () => {
    const owner = account();
    const session = new SessionEntity({
      id: randomUUID(),
      userId: owner.snapshot().id,
      tokenDigest: 'a'.repeat(64),
      authEpoch: 0,
      createdAt: now,
      revokedAt: null,
      expiresAt: new Date(now.getTime() + 1000),
    });
    session.authorize(owner, now);
    expect(() =>
      session.authorize(owner, new Date(now.getTime() + 1000)),
    ).toThrow(AuthError);
    expect(() => session.revoke(now).authorize(owner, now)).toThrow(AuthError);
    expect(() => session.authorize(account(), now)).toThrow(AuthError);
    expect(() =>
      session.authorize(owner.replacePassword('changed', 0, now), now),
    ).toThrow(AuthError);
    expect(
      session
        .revoke(now)
        .revoke(new Date(now.getTime() + 1))
        .snapshot().revokedAt,
    ).toEqual(now);
  });
  it('不存在用户名同样失败冷却，冷却边界恢复', () => {
    let attempt = AttemptEntity.fresh('a'.repeat(64), now);
    for (let failure = 0; failure < AUTH_POLICY.failureLimit; failure++)
      attempt = attempt.decideLogin(null, null, false, now).attempt;
    expect(() => attempt.assertAvailable(now)).toThrow(AuthError);
    const expired = new Date(now.getTime() + AUTH_POLICY.cooldownMs);
    attempt.assertAvailable(expired);
    expect(attempt.failed(expired).snapshot().consecutiveFailures).toBe(1);
    expect(attempt.succeeded(expired).snapshot().cooldownUntil).toBeNull();
  });
  it('固定窗口按来源和操作区分，满额不再递增', () => {
    let bucket = RateBucketEntity.start('credentials', 'a'.repeat(64), now);
    for (let request = 0; request < AUTH_POLICY.limits.credentials; request++)
      bucket = bucket.reserve(now);
    expect(() => bucket.reserve(now)).toThrow(AuthError);
    expect(bucket.snapshot().attemptCount).toBe(10);
    expect(
      RateBucketEntity.start('password', 'a'.repeat(64), now)
        .reserve(now)
        .snapshot().attemptCount,
    ).toBe(1);
    expect(
      RateBucketEntity.start(
        'credentials',
        'a'.repeat(64),
        new Date(now.getTime() + AUTH_POLICY.rateWindowMs),
      )
        .reserve(new Date(now.getTime() + AUTH_POLICY.rateWindowMs))
        .snapshot().attemptCount,
    ).toBe(1);
  });
});
