import type { TransactionContext } from '../ports.js';
import type { JobsDependencies } from '../jobs/ports.js';
import type {
  ApplicationEntity,
  FavoriteRecord,
  ApplicationHistoryRecord,
} from '../../domain/career/entities.js';
export interface CareerRepository {
  listFavorites(userId: string): Promise<FavoriteRecord[]>;
  insertFavorite(record: FavoriteRecord): Promise<void>;
  deleteFavorite(userId: string, jobId: string): Promise<void>;
  getApplication(id: string, userId: string): Promise<ApplicationEntity | null>;
  findApplication(
    userId: string,
    jobId: string,
  ): Promise<ApplicationEntity | null>;
  listApplications(userId: string): Promise<ApplicationEntity[]>;
  insertApplication(entity: ApplicationEntity): Promise<void>;
  saveApplication(
    entity: ApplicationEntity,
    expectedVersion: number,
  ): Promise<boolean>;
  deleteApplication(id: string, userId: string): Promise<void>;
  insertHistory(record: ApplicationHistoryRecord): Promise<void>;
  getHistoryById(
    id: string,
    applicationId: string,
  ): Promise<ApplicationHistoryRecord | null>;
  getHistoryByVersion(
    applicationId: string,
    version: number,
  ): Promise<ApplicationHistoryRecord | null>;
  listHistory(applicationId: string): Promise<ApplicationHistoryRecord[]>;
}
export interface CareerDependencies extends JobsDependencies {
  career(context: TransactionContext): CareerRepository;
}
