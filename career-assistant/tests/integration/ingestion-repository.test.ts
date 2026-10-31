import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  createPersistence,
  newSourceTask,
  SourceResourceEntity,
} from '@career/business';
import { isolatedDatabaseUrl } from '../fixtures/auth.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
function persistence() {
  const p = createPersistence(isolatedDatabaseUrl());
  cleanups.push(p.close);
  return p;
}
describe('采集仓储真实PostgreSQL', () => {
  it('活跃自然键唯一，独立连接并发登记返回同一任务', async () => {
    const first = persistence();
    const second = persistence();
    const key = randomUUID();
    const now = new Date();
    const make = () =>
      newSourceTask(
        randomUUID(),
        randomUUID(),
        key,
        { kind: 'fetch', resourceId: randomUUID() },
        now,
      );
    const values = await Promise.all(
      [first, second].map((p) =>
        p.unitOfWork.run(async (c) =>
          (await p.ingestion(c).insertTaskIfAbsent(make())).snapshot(),
        ),
      ),
    );
    expect(values[0]!.id).toBe(values[1]!.id);
  });
  it('锁住候选时另一个Worker跳过，过期token不能覆盖新token', async () => {
    const first = persistence(),
      second = persistence();
    const now = new Date();
    const entity = newSourceTask(
      randomUUID(),
      randomUUID(),
      randomUUID(),
      { kind: 'fetch', resourceId: randomUUID() },
      now,
    );
    await first.unitOfWork.run((c) =>
      first.ingestion(c).insertTaskIfAbsent(entity),
    );
    let release: () => void = () => {};
    let ready: () => void = () => {};
    const locked = new Promise<void>((r) => (ready = r)),
      wait = new Promise<void>((r) => (release = r));
    const claiming = first.unitOfWork.run(async (c) => {
      const repo = first.ingestion(c);
      const row = await repo.getTask(entity.snapshot().id, true);
      ready();
      await wait;
      const next = row!.claim(now);
      expect(await repo.saveTask(next, 0)).toBe(true);
      return next;
    });
    await locked;
    await second.unitOfWork.run(async (c) => {
      const row = await second.ingestion(c).claimCandidate(now, false);
      expect(row?.snapshot().id).not.toBe(entity.snapshot().id);
    });
    release();
    const claimed = await claiming;
    const expiryClient = new Client({
      connectionString: isolatedDatabaseUrl(),
    });
    await expiryClient.connect();
    try {
      await expiryClient.query(
        "UPDATE task_outbox SET lease_until=NOW()-interval '1 second' WHERE id=$1",
        [entity.snapshot().id],
      );
    } finally {
      await expiryClient.end();
    }
    await second.unitOfWork.run(async (c) => {
      const repo = second.ingestion(c);
      const current = await repo.getTask(entity.snapshot().id, true);
      const newer = current!.claim(await repo.now());
      expect(await repo.saveTask(newer, 1)).toBe(true);
    });
    await first.unitOfWork.run(async (c) =>
      expect(await first.ingestion(c).saveTask(claimed, 1)).toBe(false),
    );
  });
  it('预算原子封顶，重建持久化连接不清零', async () => {
    const first = persistence(),
      second = persistence();
    const id = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => {
        const p = i % 2 ? first : second;
        return p.unitOfWork.run((c) => p.ingestion(c).reserveBudget(id, 2));
      }),
    );
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(
      await second.unitOfWork.run((c) => second.ingestion(c).budgetUsed(id)),
    ).toBe(2);
  });
  it('即使没有新Worker领取，过期租约也无法直接完成写入', async () => {
    const p = persistence();
    const now = new Date();
    const original = newSourceTask(
      randomUUID(),
      randomUUID(),
      randomUUID(),
      { kind: 'fetch', resourceId: randomUUID() },
      now,
    );
    const claimed = original.claim(now);
    await p.unitOfWork.run(async (c) => {
      const repo = p.ingestion(c);
      await repo.insertTaskIfAbsent(original);
      expect(await repo.saveTask(claimed, 0)).toBe(true);
    });
    const client = new Client({ connectionString: isolatedDatabaseUrl() });
    await client.connect();
    try {
      await client.query(
        "UPDATE task_outbox SET lease_until=NOW()-interval '1 second' WHERE id=$1",
        [original.snapshot().id],
      );
    } finally {
      await client.end();
    }
    await p.unitOfWork.run(async (c) =>
      expect(await p.ingestion(c).saveTask(claimed.finish(1, now), 1)).toBe(
        false,
      ),
    );
  });
  it('来源ID不是标准UUID仍可存储，唯一约束与映射不丢失', async () => {
    const p = persistence();
    const now = new Date();
    const sourceId = `opaque_${randomUUID()}`;
    const make = () =>
      new SourceResourceEntity({
        id: randomUUID(),
        kind: 'job',
        sourceId,
        canonicalUrl: `https://www.zhidianmijin.com.cn/jobs/${sourceId}`,
        currentVersionId: null,
        lastAttemptAt: null,
        lastFetchedAt: null,
        nextRefreshAt: now,
        reviewVersion: 0,
        currentReviewId: null,
        stateVersion: 0,
      });
    const values = await p.unitOfWork.run(async (c) => {
      const repo = p.ingestion(c);
      return [
        (await repo.ensureResource(make())).snapshot(),
        (await repo.ensureResource(make())).snapshot(),
      ];
    });
    expect(values[0]!.id).toBe(values[1]!.id);
    expect(values[0]!.sourceId).toBe(sourceId);
  });
  it('数据库拒绝负预算和负版本，失败事务不遗留源记录', async () => {
    const client = new Client({ connectionString: isolatedDatabaseUrl() });
    await client.connect();
    cleanups.push(() => client.end());
    await expect(
      client.query(
        'INSERT INTO source_request_budgets(id,"limit",used) VALUES($1,1,2)',
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const p = persistence();
    const streamKey = 'backfill' as const;
    await expect(
      p.unitOfWork.run(async (c) => {
        await p.ingestion(c).lockStream(streamKey);
        throw Error('测试中止');
      }),
    ).rejects.toThrow('测试中止');
  });
});
