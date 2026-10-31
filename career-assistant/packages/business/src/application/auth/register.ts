import { randomUUID } from 'node:crypto';
import type {
  RegisterInputDto,
  AuthContextDto,
  UserDto,
} from '@career/contracts';
import type { AuthDependencies } from './ports.js';
import { AccountEntity } from '../../domain/auth/account.js';
import { AuthError } from '../../domain/auth/errors.js';
import { AuthRateLimiter, authOperation, publicUser } from './support.js';
import { CaptchaService } from './captcha.js';

export class RegisterService {
  constructor(
    private readonly dependencies: AuthDependencies,
    private readonly limiter: AuthRateLimiter,
    private readonly captcha: CaptchaService,
  ) {}
  execute(input: RegisterInputDto, caller: AuthContextDto): Promise<UserDto> {
    return authOperation(async () => {
      await this.limiter.consume('credentials', caller.requesterDigest);
      await this.captcha.consume(input, caller);
      const passwordHash = await this.dependencies.passwords.hash(
        input.password,
      );
      const now = this.dependencies.clock.now();
      const account = new AccountEntity({
        id: randomUUID(),
        usernameNormalized: input.username.toLowerCase(),
        passwordHash,
        authEpoch: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      const inserted = await this.dependencies.unitOfWork.run((context) =>
        this.dependencies
          .repositories(context)
          .accounts.insertIfAbsent(account),
      );
      if (!inserted) throw new AuthError('AUTH_USERNAME_CONFLICT');
      return publicUser(account, caller.csrfToken ?? '');
    });
  }
}
