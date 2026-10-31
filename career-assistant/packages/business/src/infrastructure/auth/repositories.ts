import type { Prisma } from '../generated/client.js';
import { AccountEntity } from '../../domain/auth/account.js';
import { SessionEntity } from '../../domain/auth/session.js';
import { ChallengeEntity } from '../../domain/auth/challenge.js';
import { AttemptEntity } from '../../domain/auth/attempt.js';
import {
  RateBucketEntity,
  RateBucketStateSchema,
} from '../../domain/auth/rate-bucket.js';
import type { AuthRepositories } from '../../application/auth/ports.js';

/** 每次操作重新校验事务上下文；ORM行立即转为Entity，不离开此适配器。 */
export function createAuthRepositories(
  database: () => Prisma.TransactionClient,
): AuthRepositories {
  return {
    accounts: {
      async getByUsername(username) {
        const row = await database().user.findUnique({
          where: { usernameNormalized: username },
        });
        return row ? new AccountEntity(row) : null;
      },
      async getById(id) {
        const row = await database().user.findUnique({ where: { id } });
        return row ? new AccountEntity(row) : null;
      },
      async getForUpdate(id) {
        const rows = await database().$queryRaw<
          { id: string }[]
        >`SELECT id FROM users WHERE id=${id}::uuid FOR UPDATE`;
        if (!rows.length) return null;
        return new AccountEntity(
          await database().user.findUniqueOrThrow({ where: { id } }),
        );
      },
      async getByUsernameForUpdate(username) {
        const rows = await database().$queryRaw<
          { id: string }[]
        >`SELECT id FROM users WHERE username_normalized=${username} FOR UPDATE`;
        if (!rows[0]) return null;
        return new AccountEntity(
          await database().user.findUniqueOrThrow({
            where: { id: rows[0].id },
          }),
        );
      },
      async insertIfAbsent(account) {
        return (
          (
            await database().user.createMany({
              data: [account.snapshot()],
              skipDuplicates: true,
            })
          ).count === 1
        );
      },
      async updatePasswordIfEpoch(account, expectedEpoch) {
        const snapshot = account.snapshot();
        return (
          (
            await database().user.updateMany({
              where: {
                id: snapshot.id,
                authEpoch: expectedEpoch,
                deletedAt: null,
              },
              data: {
                passwordHash: snapshot.passwordHash,
                authEpoch: snapshot.authEpoch,
                updatedAt: snapshot.updatedAt,
              },
            })
          ).count === 1
        );
      },
    },
    sessions: {
      async getByDigest(tokenDigest) {
        const row = await database().session.findUnique({
          where: { tokenDigest },
        });
        return row ? new SessionEntity(row) : null;
      },
      async getById(id) {
        const row = await database().session.findUnique({ where: { id } });
        return row ? new SessionEntity(row) : null;
      },
      async insert(session) {
        await database().session.create({ data: session.snapshot() });
      },
      async setRevokedAtIfUnset(session) {
        const snapshot = session.snapshot();
        return (
          await database().session.updateMany({
            where: { id: snapshot.id, revokedAt: null },
            data: { revokedAt: snapshot.revokedAt },
          })
        ).count;
      },
      async setAllRevokedAt(userId, revokedAt) {
        return (
          await database().session.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt },
          })
        ).count;
      },
    },
    challenges: {
      async getForUpdate(id) {
        const rows = await database().$queryRaw<
          { id: string }[]
        >`SELECT id FROM captcha_challenges WHERE id=${id}::uuid FOR UPDATE`;
        if (!rows.length) return null;
        return new ChallengeEntity(
          await database().captchaChallenge.findUniqueOrThrow({
            where: { id },
          }),
        );
      },
      async insert(challenge) {
        await database().captchaChallenge.create({
          data: challenge.snapshot(),
        });
      },
      async markConsumedIfUnused(challenge) {
        const snapshot = challenge.snapshot();
        return (
          (
            await database().captchaChallenge.updateMany({
              where: {
                id: snapshot.id,
                visitorDigest: snapshot.visitorDigest,
                consumedAt: null,
              },
              data: { consumedAt: snapshot.consumedAt },
            })
          ).count === 1
        );
      },
    },
    attempts: {
      async insertIfAbsent(attempt) {
        await database().authAttempt.createMany({
          data: [attempt.snapshot()],
          skipDuplicates: true,
        });
      },
      async getForUpdate(identityDigest) {
        await database()
          .$queryRaw`SELECT identity_digest FROM auth_attempts WHERE identity_digest=${identityDigest} FOR UPDATE`;
        return new AttemptEntity(
          await database().authAttempt.findUniqueOrThrow({
            where: { identityDigest },
          }),
        );
      },
      async update(attempt) {
        const snapshot = attempt.snapshot();
        await database().authAttempt.update({
          where: { identityDigest: snapshot.identityDigest },
          data: snapshot,
        });
      },
    },
    rates: {
      async insertIfAbsent(bucket) {
        await database().authRateBucket.createMany({
          data: [bucket.snapshot()],
          skipDuplicates: true,
        });
      },
      async getForUpdate(key) {
        await database()
          .$queryRaw`SELECT scope FROM auth_rate_buckets WHERE scope=${key.scope} AND subject_digest=${key.subjectDigest} AND window_start=${key.windowStart} FOR UPDATE`;
        return new RateBucketEntity(
          RateBucketStateSchema.parse(
            await database().authRateBucket.findUniqueOrThrow({
              where: {
                scope_subjectDigest_windowStart: {
                  scope: key.scope,
                  subjectDigest: key.subjectDigest,
                  windowStart: key.windowStart,
                },
              },
            }),
          ),
        );
      },
      async updateCountIfCurrent(bucket, previousCount) {
        const snapshot = bucket.snapshot();
        return (
          (
            await database().authRateBucket.updateMany({
              where: {
                scope: snapshot.scope,
                subjectDigest: snapshot.subjectDigest,
                windowStart: snapshot.windowStart,
                attemptCount: previousCount,
              },
              data: { attemptCount: snapshot.attemptCount },
            })
          ).count === 1
        );
      },
    },
    async pruneExpired(now, limit) {
      let remaining = limit;
      remaining -= await database()
        .$executeRaw`DELETE FROM captcha_challenges WHERE id IN (SELECT id FROM captcha_challenges WHERE expires_at<=${now} ORDER BY expires_at LIMIT ${remaining} FOR UPDATE SKIP LOCKED)`;
      if (remaining <= 0) return;
      remaining -= await database()
        .$executeRaw`DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at<=${now} ORDER BY expires_at LIMIT ${remaining} FOR UPDATE SKIP LOCKED)`;
      if (remaining <= 0) return;
      await database()
        .$executeRaw`DELETE FROM auth_rate_buckets WHERE (scope,subject_digest,window_start) IN (SELECT scope,subject_digest,window_start FROM auth_rate_buckets WHERE expires_at<=${now} ORDER BY expires_at LIMIT ${remaining} FOR UPDATE SKIP LOCKED)`;
    },
  };
}
