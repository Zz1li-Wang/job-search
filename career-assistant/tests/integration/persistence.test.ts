import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  createPersistence,
  IdempotencyRecord,
  IdempotencyConflictError,
  type TransactionContext,
} from '@career/business';

const databaseUrl = process.env.DATABASE_URL;
if (
  process.env.TEST_DATABASE_ISOLATED !== 'true' ||
  !databaseUrl ||
  new URL(databaseUrl).pathname !== '/career_test'
)
  throw Error('集成测试只能使用新建的隔离测试数据库');
const first = createPersistence(databaseUrl);
const second = createPersistence(databaseUrl);
afterAll(async () => {
  await first.close();
  await second.close();
});
const snapshot = (key = randomUUID()) => ({
  scope: `test:${randomUUID()}`,
  key,
  requestHash: 'a'.repeat(64),
  responseReference: 'first-reference',
  createdAt: new Date('2026-10-30T08:00:00.000Z'),
});

describe('真实PostgreSQL Repository与UnitOfWork', () => {
  it('Entity映射、提交及数据库关闭重连后持久化', async () => {
    const input = snapshot();
    const inserted = await first.unitOfWork.run((tx) =>
      first.records(tx).insertIfAbsent(new IdempotencyRecord(input)),
    );
    expect(inserted.wasInserted).toBe(true);
    expect(inserted.record).toBeInstanceOf(IdempotencyRecord);
    const loaded = await second.unitOfWork.run((tx) =>
      second.records(tx).getRecord(input.scope, input.key),
    );
    expect(loaded?.snapshot()).toEqual(input);
    expect(
      await second.unitOfWork.run((tx) =>
        second.records(tx).getRecord(input.scope, randomUUID()),
      ),
    ).toBeNull();
  });
  it('事务抛错回滚，提交后上下文和伪造上下文都拒绝使用', async () => {
    const input = snapshot();
    let expired: TransactionContext | undefined;
    await expect(
      first.unitOfWork.run(async (tx) => {
        expired = tx;
        await first.records(tx).insertIfAbsent(new IdempotencyRecord(input));
        throw Error('test rollback');
      }),
    ).rejects.toThrow('test rollback');
    expect(
      await second.unitOfWork.run((tx) =>
        second.records(tx).getRecord(input.scope, input.key),
      ),
    ).toBeNull();
    if (!expired) throw Error('回调未执行');
    await expect(
      first.records(expired).getRecord(input.scope, input.key),
    ).rejects.toThrow('事务上下文');
    await expect(
      first
        .records({ transactionId: randomUUID() })
        .getRecord(input.scope, input.key),
    ).rejects.toThrow('事务上下文');
  });
  it('两个独立连接并发插入，同键只创建一次并返回首次结果', async () => {
    const input = snapshot();
    let arrived = 0;
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = (persistence: typeof first) =>
      persistence.unitOfWork.run(async (tx) => {
        arrived++;
        if (arrived === 2) release();
        await barrier;
        const inserted = await persistence
          .records(tx)
          .insertIfAbsent(new IdempotencyRecord(input));
        inserted.record.assertSameRequest(input.requestHash);
        return inserted;
      });
    const outcomes = await Promise.all([create(first), create(second)]);
    expect(arrived).toBe(2);
    expect(outcomes.filter((outcome) => outcome.wasInserted)).toHaveLength(1);
    expect(outcomes.map((outcome) => outcome.record.snapshot())).toEqual([
      input,
      input,
    ]);
  });
  it('同键不同请求的领域冲突不覆盖结果，不同作用域可分别写入', async () => {
    const input = snapshot();
    await first.unitOfWork.run((tx) =>
      first.records(tx).insertIfAbsent(new IdempotencyRecord(input)),
    );
    await expect(
      second.unitOfWork.run(async (tx) => {
        const repeated = await second.records(tx).insertIfAbsent(
          new IdempotencyRecord({
            ...input,
            requestHash: 'b'.repeat(64),
            responseReference: 'overwrite',
          }),
        );
        repeated.record.assertSameRequest('b'.repeat(64));
      }),
    ).rejects.toThrow(IdempotencyConflictError);
    expect(
      (
        await first.unitOfWork.run((tx) =>
          first.records(tx).getRecord(input.scope, input.key),
        )
      )?.snapshot().responseReference,
    ).toBe('first-reference');
    expect(
      (
        await second.unitOfWork.run((tx) =>
          second
            .records(tx)
            .insertIfAbsent(
              new IdempotencyRecord({ ...input, scope: 'other-scope' }),
            ),
        )
      ).wasInserted,
    ).toBe(true);
  });
  it('迁移包含公共任务和审计表，任务事件唯一约束真实生效', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const tables = await client.query<{ name: string }>(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname='public'",
      );
      expect(tables.rows.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          'idempotency_records',
          'task_outbox',
          'audit_events',
        ]),
      );
      const event = randomUUID();
      await client.query(
        'INSERT INTO task_outbox(id,event_key,kind,resource_reference,available_at) VALUES($1,$2,$3,$4,NOW())',
        [randomUUID(), event, 'test', 'test-reference'],
      );
      await expect(
        client.query(
          'INSERT INTO task_outbox(id,event_key,kind,resource_reference,available_at) VALUES($1,$2,$3,$4,NOW())',
          [randomUUID(), event, 'test', 'test-reference'],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    } finally {
      await client.end();
    }
  });
});
