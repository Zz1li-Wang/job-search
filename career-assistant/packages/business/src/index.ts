export {
  IdempotencyRecord,
  IdempotencyRecordSchema,
  IdempotencyConflictError,
  type IdempotencyRecordSnapshot,
} from './domain/idempotency.js';
export type {
  UnitOfWork,
  TransactionContext,
  IdempotencyRepository,
  PrivateFileStore,
} from './application/ports.js';
export { createPersistence } from './infrastructure/persistence.js';
export { createPrivateFileStore } from './infrastructure/private-files.js';
export {
  createAuthServices,
  type AuthServices,
  type AuthDependencies,
  type AuthRepositories,
  type Clock,
  type PasswordHasher,
  type TokenCodec,
  type CaptchaImage,
} from './application/auth/index.js';
export {
  createAuthSecurity,
  type AuthSecuritySettings,
} from './infrastructure/auth/security.js';
export {
  createPasswordHasher,
  HashCalculationGate,
} from './infrastructure/auth/password-hasher.js';
export {
  AccountEntity,
  AccountStateSchema,
  type AccountState,
} from './domain/auth/account.js';
export { SessionEntity, SessionStateSchema } from './domain/auth/session.js';
export {
  ChallengeEntity,
  ChallengeStateSchema,
} from './domain/auth/challenge.js';
export { AttemptEntity, AttemptStateSchema } from './domain/auth/attempt.js';
export {
  RateBucketEntity,
  RateBucketStateSchema,
} from './domain/auth/rate-bucket.js';
export { AuthError, AUTH_ERROR_MESSAGES } from './domain/auth/errors.js';
export { AUTH_POLICY } from './domain/auth/policy.js';

export * from './domain/ingestion/task.js';
export * from './domain/ingestion/source.js';
export * from './domain/ingestion/evidence.js';
export * from './domain/ingestion/errors.js';
export * from './domain/ingestion/policy.js';
export type * from './application/ingestion/ports.js';
export * from './infrastructure/ingestion/html.js';
export * from './infrastructure/ingestion/source.js';
export * from './infrastructure/ingestion/files.js';
export {
  createIngestionServices,
  type IngestionServices,
} from './application/ingestion/index.js';
export {
  createIngestionRuntime,
  readSourceCookie,
  type IngestionRuntimeSettings,
} from './infrastructure/ingestion/runtime.js';

export { RefreshQuotaEntity } from './domain/ingestion/refresh.js';

export * from './domain/jobs/entities.js';
export * from './domain/jobs/eligibility.js';
export * from './domain/shared/errors.js';
export {
  createJobsServices,
  type JobQueryService,
  type ProfileQueryService,
  type EligibilityService,
} from './application/jobs/services.js';
export type * from './application/jobs/ports.js';

export * from './application/chat/services.js';
export * from './application/chat/grants.js';
export type * from './application/chat/ports.js';
export * from './domain/chat/entities.js';
export * from './infrastructure/chat/client.js';
export * from './infrastructure/chat/runtime.js';

export * from './application/resume/services.js';
export type * from './application/resume/ports.js';
export * from './domain/resume/entities.js';
export * from './infrastructure/resume/documents.js';
export * from './infrastructure/resume/client.js';

export * from './application/career/services.js';
export type * from './application/career/ports.js';
export * from './domain/career/entities.js';

export * from './application/privacy/service.js';
export type * from './application/privacy/ports.js';
export * from './domain/privacy/entity.js';
