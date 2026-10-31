import { randomUUID } from 'node:crypto';
import type {
  LoginInputDto,
  AuthContextDto,
  LoginServiceResultDto,
} from '@career/contracts';
import type { AuthDependencies } from './ports.js';
import { AUTH_POLICY } from '../../domain/auth/policy.js';
import { AttemptEntity } from '../../domain/auth/attempt.js';
import { SessionEntity } from '../../domain/auth/session.js';
import { AuthError } from '../../domain/auth/errors.js';
import { AuthRateLimiter, authOperation, publicUser } from './support.js';
import { CaptchaService } from './captcha.js';

export class LoginService {
  constructor(
    private readonly dependencies: AuthDependencies,
    private readonly limiter: AuthRateLimiter,
    private readonly captcha: CaptchaService,
  ) {}
  execute(
    input: LoginInputDto,
    caller: AuthContextDto,
  ): Promise<LoginServiceResultDto> {
    return authOperation(async () => {
      await this.limiter.consume('credentials', caller.requesterDigest);
      await this.captcha.consume(input, caller);
      const username = input.username.toLowerCase();
      const identityDigest = this.dependencies.tokens.digest(
        'identity',
        username,
      );
      const snapshot = await this.dependencies.unitOfWork.run(
        async (context) => {
          const repositories = this.dependencies.repositories(context);
          const now = this.dependencies.clock.now();
          await repositories.attempts.insertIfAbsent(
            AttemptEntity.fresh(identityDigest, now),
          );
          (
            await repositories.attempts.getForUpdate(identityDigest)
          ).assertAvailable(now);
          return repositories.accounts.getByUsername(username);
        },
      );
      const verified = await this.dependencies.passwords.verify(
        input.password,
        snapshot?.snapshot().passwordHash ??
          this.dependencies.passwords.dummyHash,
      );
      const sessionCredential = this.dependencies.tokens.credential();
      const result = await this.dependencies.unitOfWork.run(async (context) => {
        const repositories = this.dependencies.repositories(context);
        const now = this.dependencies.clock.now();
        const attempt =
          await repositories.attempts.getForUpdate(identityDigest);
        const account =
          await repositories.accounts.getByUsernameForUpdate(username);
        const decision = attempt.decideLogin(
          account,
          snapshot?.snapshot().authEpoch ?? null,
          verified,
          now,
        );
        await repositories.attempts.update(decision.attempt);
        if (!decision.isAccepted) return null;
        const current = decision.account.snapshot();
        await repositories.sessions.insert(
          new SessionEntity({
            id: randomUUID(),
            userId: current.id,
            tokenDigest: this.dependencies.tokens.digest(
              'session',
              sessionCredential,
            ),
            authEpoch: current.authEpoch,
            createdAt: now,
            expiresAt: new Date(now.getTime() + AUTH_POLICY.sessionLifetimeMs),
            revokedAt: null,
          }),
        );
        return decision.account;
      });
      if (!result) throw new AuthError('AUTH_INVALID_CREDENTIALS');
      return {
        user: publicUser(
          result,
          this.dependencies.tokens.csrf('session', sessionCredential),
        ),
        sessionCredential,
      };
    });
  }
}
