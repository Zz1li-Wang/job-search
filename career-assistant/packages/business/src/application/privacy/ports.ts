import type { JobsDependencies } from '../jobs/ports.js';
import type { TransactionContext } from '../ports.js';
import type { AuthDependencies } from '../auth/ports.js';
import type { AccountEntity } from '../../domain/auth/account.js';
import type {
  PrivateCollection,
  DeletionRecord,
} from '../../domain/privacy/entity.js';
import type { ResumeRepository } from '../resume/ports.js';
export interface PrivacyRepository {
  insert(record: DeletionRecord): Promise<void>;
  get(id: string, userId: string): Promise<DeletionRecord | null>;
  listFileKeys(userId: string): Promise<string[]>;
  pendingFiles(userId: string): Promise<number>;
  cancelRuns(userId: string, now: Date): Promise<void>;
  deleteOwnedCollections(
    userId: string,
    collections: PrivateCollection[],
  ): Promise<void>;
  saveAccount(entity: AccountEntity, expectedEpoch: number): Promise<boolean>;
  revokeSessions(userId: string, now: Date): Promise<void>;
}
export interface PrivacyDependencies extends JobsDependencies {
  privacy(c: TransactionContext): PrivacyRepository;
  resumes(c: TransactionContext): ResumeRepository;
  auth: AuthDependencies;
}
