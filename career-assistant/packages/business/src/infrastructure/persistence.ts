import { createPrivacyRepository } from './privacy/repository.js';
import { createCareerRepository } from './career/repository.js';
import { createResumeRepository } from './resume/repository.js';
import { createChatRepository } from './chat/repository.js';
import { createJobsRepository } from './jobs/repository.js';
import { createIngestionRepository } from './ingestion/repository.js';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from './generated/client.js';
import { IdempotencyRecord } from '../domain/idempotency.js';
import { createAuthRepositories } from './auth/repositories.js';
import type {
  TransactionContext,
  UnitOfWork,
  IdempotencyRepository,
} from '../application/ports.js';

const TRANSACTION_TIMEOUT_MS = 10000;
/** Prisma及其类型封闭在基础设施内部，应用仅接收端口与Entity。 */
export function createPersistence(databaseUrl: string) {
  const adapter = new PrismaPg({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 1500,
    query_timeout: 1500,
    idleTimeoutMillis: 5000,
  });
  const client = new PrismaClient({ adapter });
  const transactions = new WeakMap<
    TransactionContext,
    Prisma.TransactionClient
  >();
  function transactionFor(
    context: TransactionContext,
  ): Prisma.TransactionClient {
    const transaction = transactions.get(context);
    if (!transaction) throw Error('事务上下文不存在或已结束');
    return transaction;
  }
  function runTransaction<T>(
    operation: (context: TransactionContext) => Promise<T>,
    repeatable = false,
  ): Promise<T> {
    return client.$transaction(
      async (transaction) => {
        const context = Object.freeze({ transactionId: randomUUID() });
        transactions.set(context, transaction);
        try {
          return await operation(context);
        } finally {
          transactions.delete(context);
        }
      },
      {
        timeout: repeatable ? 30000 : TRANSACTION_TIMEOUT_MS,
        isolationLevel: repeatable ? 'RepeatableRead' : 'ReadCommitted',
      },
    );
  }
  const unitOfWork: UnitOfWork = {
    run: (operation) => runTransaction(operation),
  };
  const records = (context: TransactionContext): IdempotencyRepository => ({
    async getRecord(scope, key) {
      const row = await transactionFor(context).idempotencyRecord.findUnique({
        where: { scope_key: { scope, key } },
      });
      return row ? new IdempotencyRecord(row) : null;
    },
    async insertIfAbsent(record) {
      const snapshot = record.snapshot();
      const transaction = transactionFor(context);
      const inserted = await transaction.idempotencyRecord.createMany({
        data: [snapshot],
        skipDuplicates: true,
      });
      const row = await transaction.idempotencyRecord.findUniqueOrThrow({
        where: { scope_key: { scope: snapshot.scope, key: snapshot.key } },
      });
      return {
        record: new IdempotencyRecord(row),
        wasInserted: inserted.count === 1,
      };
    },
  });
  return {
    unitOfWork,
    privacy: (context: TransactionContext) =>
      createPrivacyRepository(transactionFor(context)),
    career: (context: TransactionContext) =>
      createCareerRepository(transactionFor(context)),
    resumes: (context: TransactionContext) =>
      createResumeRepository(transactionFor(context)),
    chat: (context: TransactionContext) =>
      createChatRepository(transactionFor(context)),
    jobs: (context: TransactionContext) =>
      createJobsRepository(transactionFor(context)),
    repeatableRead: <T>(
      operation: (context: TransactionContext) => Promise<T>,
    ) => runTransaction(operation, true),
    ingestion: (context: TransactionContext) =>
      createIngestionRepository(
        () => transactionFor(context),
        createAuthRepositories(() => transactionFor(context)),
        records(context),
      ),
    records,
    auth: (context: TransactionContext) =>
      createAuthRepositories(() => transactionFor(context)),
    probe: {
      name: 'database',
      async isAvailable(): Promise<boolean> {
        try {
          await client.$queryRaw`SELECT 1`;
          return true;
        } catch {
          return false;
        }
      },
    },
    ingestionProbe: {
      name: 'ingestion_storage',
      async isAvailable(): Promise<boolean> {
        try {
          await client.$queryRaw`SELECT r.id,v.id,s.id,t.fencing_token,a.id,rv.id FROM source_resources r,source_versions v,source_snapshots s,task_outbox t,task_attempts a,requirement_reviews rv LIMIT 0`;
          return true;
        } catch {
          return false;
        }
      },
    },
    applicationProbe: {
      name: 'application_storage',
      async isAvailable() {
        try {
          await client.$queryRaw`SELECT p.user_id,e.id,c.id,m.id,a.personal_data_epoch,r.id,d.id,f.user_id,j.id,h.id,x.id FROM profiles p,eligibility_checks e,conversations c,messages m,agent_runs a,resumes r,profile_drafts d,favorites f,job_applications j,application_history h,deletion_requests x LIMIT 0`;
          return true;
        } catch {
          return false;
        }
      },
    },
    authProbe: {
      name: 'auth_storage',
      async isAvailable(): Promise<boolean> {
        try {
          // 只验证迁移所需表列可解析，不读取用户业务记录。
          await client.$queryRaw`SELECT u.id,s.id,c.id,a.identity_digest,r.scope FROM users u,sessions s,captcha_challenges c,auth_attempts a,auth_rate_buckets r LIMIT 0`;
          return true;
        } catch {
          return false;
        }
      },
    },
    close: () => client.$disconnect(),
  };
}
