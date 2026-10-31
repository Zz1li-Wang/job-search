import { randomUUID } from 'node:crypto';
import {
  CaptchaServiceResultSchema,
  type CaptchaServiceResultDto,
  type IssueCaptchaInputDto,
  type AuthContextDto,
  type RegisterInputDto,
} from '@career/contracts';
import type { AuthDependencies } from './ports.js';
import { AUTH_POLICY } from '../../domain/auth/policy.js';
import { ChallengeEntity } from '../../domain/auth/challenge.js';
import { AuthError } from '../../domain/auth/errors.js';
import { AuthRateLimiter, authOperation } from './support.js';

export class CaptchaService {
  constructor(
    private readonly dependencies: AuthDependencies,
    private readonly limiter: AuthRateLimiter,
  ) {}
  issue(input: IssueCaptchaInputDto): Promise<CaptchaServiceResultDto> {
    return authOperation(async () => {
      await this.limiter.consume('captcha', input.requesterDigest);
      const { tokens, images, clock } = this.dependencies;
      const visitorCredential = input.visitorCredential ?? tokens.credential();
      const id = randomUUID();
      const answer = images.answer();
      const imageDataUrl = await images.render(answer);
      const now = clock.now();
      const expiresAt = new Date(now.getTime() + AUTH_POLICY.captchaLifetimeMs);
      const challenge = new ChallengeEntity({
        id,
        visitorDigest: tokens.digest('visitor', visitorCredential),
        answerDigest: tokens.digest('captcha-answer', id, answer),
        createdAt: now,
        expiresAt,
        consumedAt: null,
      });
      const output = CaptchaServiceResultSchema.parse({
        captcha: {
          captchaId: id,
          imageDataUrl,
          expiresAt: expiresAt.toISOString(),
          csrfToken: tokens.csrf('visitor', visitorCredential),
        },
        visitorCredential,
      });
      await this.dependencies.unitOfWork.run(async (context) => {
        const repositories = this.dependencies.repositories(context);
        await repositories.pruneExpired(now, AUTH_POLICY.cleanupBatchSize);
        await repositories.challenges.insert(challenge);
      });
      return output;
    });
  }
  async consume(
    input: Pick<RegisterInputDto, 'captchaId' | 'captchaAnswer'>,
    caller: AuthContextDto,
  ): Promise<void> {
    const valid = await authOperation(() =>
      this.dependencies.unitOfWork.run(async (context) => {
        const repository = this.dependencies.repositories(context).challenges;
        const challenge = await repository.getForUpdate(input.captchaId);
        if (!challenge) return false;
        const snapshot = challenge.snapshot();
        const result = challenge.evaluate(
          this.dependencies.tokens.matches(
            caller.visitorDigest ?? '',
            snapshot.visitorDigest,
          ),
          this.dependencies.tokens.matches(
            this.dependencies.tokens.digest(
              'captcha-answer',
              input.captchaId,
              input.captchaAnswer,
            ),
            snapshot.answerDigest,
          ),
          this.dependencies.clock.now(),
        );
        if (
          result.shouldPersist &&
          !(await repository.markConsumedIfUnused(result.challenge))
        )
          return false;
        return result.isValid;
      }),
    );
    // 业务拒绝必须在事务提交后抛出，答错也保留一次性消费记录。
    if (!valid) throw new AuthError('AUTH_INVALID_CAPTCHA');
  }
}
