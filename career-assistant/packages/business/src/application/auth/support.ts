import type { UserDto } from '@career/contracts';
import type { AuthDependencies } from './ports.js';
import type { AccountEntity } from '../../domain/auth/account.js';
import { AuthError } from '../../domain/auth/errors.js';
import { RateBucketEntity } from '../../domain/auth/rate-bucket.js';
import type { AuthRateScope } from '../../domain/auth/policy.js';

/** 外部错误转换不保留可能携带SQL参数、连接串或密码的异常内容。 */
export async function authOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('AUTH_DEPENDENCY_UNAVAILABLE');
  }
}
export function publicUser(account: AccountEntity, csrfToken: string): UserDto {
  const snapshot = account.snapshot();
  return {
    id: snapshot.id,
    username: snapshot.usernameNormalized,
    createdAt: snapshot.createdAt.toISOString(),
    csrfToken,
  };
}
export class AuthRateLimiter {
  constructor(private readonly dependencies: AuthDependencies) {}
  consume(scope: AuthRateScope, requesterDigest: string): Promise<void> {
    return authOperation(() =>
      this.dependencies.unitOfWork.run(async (context) => {
        const now = this.dependencies.clock.now();
        const repository = this.dependencies.repositories(context).rates;
        const fresh = RateBucketEntity.start(scope, requesterDigest, now);
        await repository.insertIfAbsent(fresh);
        const current = await repository.getForUpdate(fresh.snapshot());
        const reserved = current.reserve(now);
        if (
          !(await repository.updateCountIfCurrent(
            reserved,
            current.snapshot().attemptCount,
          ))
        )
          throw new AuthError('AUTH_DEPENDENCY_UNAVAILABLE');
      }),
    );
  }
}
