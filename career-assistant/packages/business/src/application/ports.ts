import type { IdempotencyRecord } from '../domain/idempotency.js';

/** 不透明上下文只在一次UnitOfWork回调中有效，不能跨请求复用。 */
export interface TransactionContext {
  readonly transactionId: string;
}
export interface UnitOfWork {
  run<T>(operation: (context: TransactionContext) => Promise<T>): Promise<T>;
}
export interface IdempotencyRepository {
  getRecord(scope: string, key: string): Promise<IdempotencyRecord | null>;
  /** 唯一约束下原子插入，冲突返回既有Entity，是否同一请求交由领域判断。 */
  insertIfAbsent(
    record: IdempotencyRecord,
  ): Promise<{ record: IdempotencyRecord; wasInserted: boolean }>;
}
export interface PrivateFileStore {
  put(key: string, content: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}
