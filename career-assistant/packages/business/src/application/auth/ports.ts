import type { AccountEntity } from '../../domain/auth/account.js';
import type { SessionEntity } from '../../domain/auth/session.js';
import type { ChallengeEntity } from '../../domain/auth/challenge.js';
import type { AttemptEntity } from '../../domain/auth/attempt.js';
import type {
  RateBucketEntity,
  RateBucketState,
} from '../../domain/auth/rate-bucket.js';
import type { TransactionContext, UnitOfWork } from '../ports.js';

export interface AccountRepository {
  getByUsername(username: string): Promise<AccountEntity | null>;
  getById(id: string): Promise<AccountEntity | null>;
  getForUpdate(id: string): Promise<AccountEntity | null>;
  getByUsernameForUpdate(username: string): Promise<AccountEntity | null>;
  insertIfAbsent(account: AccountEntity): Promise<boolean>;
  updatePasswordIfEpoch(
    account: AccountEntity,
    expectedEpoch: number,
  ): Promise<boolean>;
}
export interface SessionRepository {
  getByDigest(digest: string): Promise<SessionEntity | null>;
  getById(id: string): Promise<SessionEntity | null>;
  insert(session: SessionEntity): Promise<void>;
  setRevokedAtIfUnset(session: SessionEntity): Promise<number>;
  setAllRevokedAt(userId: string, revokedAt: Date): Promise<number>;
}
export interface ChallengeRepository {
  getForUpdate(id: string): Promise<ChallengeEntity | null>;
  insert(challenge: ChallengeEntity): Promise<void>;
  markConsumedIfUnused(challenge: ChallengeEntity): Promise<boolean>;
}
export interface AttemptRepository {
  insertIfAbsent(attempt: AttemptEntity): Promise<void>;
  getForUpdate(identityDigest: string): Promise<AttemptEntity>;
  update(attempt: AttemptEntity): Promise<void>;
}
export interface RateRepository {
  insertIfAbsent(bucket: RateBucketEntity): Promise<void>;
  getForUpdate(
    key: Pick<RateBucketState, 'scope' | 'subjectDigest' | 'windowStart'>,
  ): Promise<RateBucketEntity>;
  updateCountIfCurrent(
    bucket: RateBucketEntity,
    previousCount: number,
  ): Promise<boolean>;
}
export interface AuthRepositories {
  accounts: AccountRepository;
  sessions: SessionRepository;
  challenges: ChallengeRepository;
  attempts: AttemptRepository;
  rates: RateRepository;
  pruneExpired(now: Date, limit: number): Promise<void>;
}
export interface Clock {
  now(): Date;
}
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encoded: string): Promise<boolean>;
  readonly dummyHash: string;
}
export interface TokenCodec {
  credential(): string;
  digest(purpose: string, ...parts: string[]): string;
  csrf(purpose: 'visitor' | 'session', credential: string): string;
  matches(first: string, second: string): boolean;
}
export interface CaptchaImage {
  answer(): string;
  render(answer: string): Promise<string>;
}
export interface AuthDependencies {
  unitOfWork: UnitOfWork;
  repositories(context: TransactionContext): AuthRepositories;
  clock: Clock;
  passwords: PasswordHasher;
  tokens: TokenCodec;
  images: CaptchaImage;
}
