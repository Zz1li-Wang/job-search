import type { PasswordInputDto, AuthContextDto } from '@career/contracts';
import type { AuthDependencies } from './ports.js';
import { AttemptEntity } from '../../domain/auth/attempt.js';
import { AuthError } from '../../domain/auth/errors.js';
import { AuthRateLimiter, authOperation } from './support.js';

export class ChangePasswordService {
  constructor(
    private readonly dependencies: AuthDependencies,
    private readonly limiter: AuthRateLimiter,
  ) {}
  execute(input: PasswordInputDto, caller: AuthContextDto): Promise<void> {
    return authOperation(async () => {
      const actor = caller.actor;
      if (!actor?.sessionId) throw new AuthError('AUTH_UNAUTHENTICATED');
      await this.limiter.consume('password', caller.requesterDigest);
      const snapshot = await this.dependencies.unitOfWork.run(
        async (context) => {
          const repositories = this.dependencies.repositories(context);
          const account = await repositories.accounts.getById(actor.userId);
          const session = await repositories.sessions.getById(actor.sessionId!);
          if (!account || !session) throw new AuthError('AUTH_UNAUTHENTICATED');
          session.authorize(account, this.dependencies.clock.now());
          account.assertEpoch(actor.authEpoch);
          return account;
        },
      );
      const identityDigest = this.dependencies.tokens.digest(
        'identity',
        snapshot.snapshot().usernameNormalized,
      );
      await this.dependencies.unitOfWork.run(async (context) => {
        const repository = this.dependencies.repositories(context).attempts;
        await repository.insertIfAbsent(
          AttemptEntity.fresh(identityDigest, this.dependencies.clock.now()),
        );
        (await repository.getForUpdate(identityDigest)).assertAvailable(
          this.dependencies.clock.now(),
        );
      });
      const verified = await this.dependencies.passwords.verify(
        input.currentPassword,
        snapshot.snapshot().passwordHash,
      );
      const passwordHash = verified
        ? await this.dependencies.passwords.hash(input.newPassword)
        : null;
      const changed = await this.dependencies.unitOfWork.run(
        async (context) => {
          const repositories = this.dependencies.repositories(context);
          const now = this.dependencies.clock.now();
          const attempt =
            await repositories.attempts.getForUpdate(identityDigest);
          attempt.assertAvailable(now);
          const account = await repositories.accounts.getForUpdate(
            actor.userId,
          );
          if (!account) throw new AuthError('AUTH_UNAUTHENTICATED');
          account.assertEpoch(actor.authEpoch);
          const session = await repositories.sessions.getById(actor.sessionId!);
          if (!session) throw new AuthError('AUTH_UNAUTHENTICATED');
          session.authorize(account, now);
          if (!passwordHash) {
            await repositories.attempts.update(attempt.failed(now));
            return false;
          }
          const changedAccount = account.replacePassword(
            passwordHash,
            actor.authEpoch,
            now,
          );
          if (
            !(await repositories.accounts.updatePasswordIfEpoch(
              changedAccount,
              actor.authEpoch,
            ))
          )
            throw new AuthError('AUTH_VERSION_CONFLICT');
          await repositories.sessions.setAllRevokedAt(actor.userId, now);
          await repositories.attempts.update(attempt.succeeded(now));
          return true;
        },
      );
      if (!changed) throw new AuthError('AUTH_INVALID_CREDENTIALS');
    });
  }
}
