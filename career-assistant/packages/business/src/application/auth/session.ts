import type {
  ResolvedSessionDto,
  SessionCredentialInputDto,
} from '@career/contracts';
import type { AuthDependencies } from './ports.js';
import { AuthError } from '../../domain/auth/errors.js';
import { authOperation, publicUser } from './support.js';

export class AuthSessionService {
  constructor(private readonly dependencies: AuthDependencies) {}
  resolve(input: SessionCredentialInputDto): Promise<ResolvedSessionDto> {
    return authOperation(async () => {
      const credential = input.sessionCredential;
      if (!credential) throw new AuthError('AUTH_UNAUTHENTICATED');
      return this.dependencies.unitOfWork.run(async (context) => {
        const repositories = this.dependencies.repositories(context);
        const session = await repositories.sessions.getByDigest(
          this.dependencies.tokens.digest('session', credential),
        );
        if (!session) throw new AuthError('AUTH_UNAUTHENTICATED');
        const account = await repositories.accounts.getById(
          session.snapshot().userId,
        );
        session.authorize(account, this.dependencies.clock.now());
        if (!account) throw new AuthError('AUTH_UNAUTHENTICATED');
        const snapshot = account.snapshot();
        return {
          actor: {
            userId: snapshot.id,
            sessionId: session.snapshot().id,
            authEpoch: snapshot.authEpoch,
            personalDataEpoch: snapshot.personalDataEpoch,
          },
          user: publicUser(
            account,
            this.dependencies.tokens.csrf('session', credential),
          ),
        };
      });
    });
  }
}
export class LogoutService {
  constructor(private readonly dependencies: AuthDependencies) {}
  execute(input: SessionCredentialInputDto): Promise<void> {
    return authOperation(async () => {
      if (!input.sessionCredential) return;
      const digest = this.dependencies.tokens.digest(
        'session',
        input.sessionCredential,
      );
      await this.dependencies.unitOfWork.run(async (context) => {
        const repository = this.dependencies.repositories(context).sessions;
        const session = await repository.getByDigest(digest);
        if (session)
          await repository.setRevokedAtIfUnset(
            session.revoke(this.dependencies.clock.now()),
          );
      });
    });
  }
}
