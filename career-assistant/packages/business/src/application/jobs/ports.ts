import type { UnitOfWork, TransactionContext } from '../ports.js';
import type { IngestionRepository } from '../ingestion/ports.js';
import type { TokenCodec } from '../auth/ports.js';
import type {
  ConfirmedProfileEntity,
  EligibilityCheckEntity,
} from '../../domain/jobs/entities.js';
export interface JobRecord {
  id: string;
  resourceId: string;
  recordedAt: Date;
}
export interface JobsRepository {
  listJobs(): Promise<JobRecord[]>;
  getJob(id: string): Promise<JobRecord | null>;
  getProfile(userId: string): Promise<ConfirmedProfileEntity | null>;
  getCheckOwned(
    id: string,
    userId: string,
  ): Promise<EligibilityCheckEntity | null>;
  insertCheck(check: EligibilityCheckEntity): Promise<void>;
}
export interface JobsDependencies {
  unitOfWork: UnitOfWork;
  repeatableRead<T>(
    operation: (context: TransactionContext) => Promise<T>,
  ): Promise<T>;
  repositories(context: TransactionContext): JobsRepository;
  source(context: TransactionContext): IngestionRepository;
  tokens: TokenCodec;
  id(): string;
  digest(text: string): string;
  now(): Date;
}
