import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  DiscoverInputSchema,
  ReviewInputSchema,
  RuleTreeSchema,
} from '@career/contracts';
import {
  newSourceTask,
  SourceStreamEntity,
  freshness,
  SourceResourceEntity,
  INGESTION_POLICY,
  IngestionError,
  RefreshQuotaEntity,
} from '@career/business';
const now = new Date('2026-10-30T10:00:00Z');
const target = { kind: 'fetch' as const, resourceId: randomUUID() };
function task() {
  return newSourceTask(randomUUID(), randomUUID(), randomUUID(), target, now);
}
describe('采集领域契约与状态', () => {
  it('刷新分钟额度与岗位60秒间隔由领域规则判断边界', () => {
    expect(
      new RefreshQuotaEntity({
        occupiedSlots: [true, false, false, false, false],
        previousRequestedAt: null,
      }).availableSlot(),
    ).toBe(1);
    expect(() =>
      new RefreshQuotaEntity({
        occupiedSlots: [true, true, true, true, true],
        previousRequestedAt: null,
      }).availableSlot(),
    ).toThrow();
    expect(() =>
      new RefreshQuotaEntity({
        occupiedSlots: [false, false, false, false, false],
        previousRequestedAt: new Date(now.getTime() - 59_999),
      }).assertMayCreate(now),
    ).toThrow();
    expect(() =>
      new RefreshQuotaEntity({
        occupiedSlots: [false, false, false, false, false],
        previousRequestedAt: new Date(now.getTime() - 60_000),
      }).assertMayCreate(now),
    ).not.toThrow();
  });

  it('发现页数及游标必须受版本保护，不允许额外身份', () => {
    expect(
      DiscoverInputSchema.safeParse({
        sourceKey: 'zhidianmijin',
        stream: 'new',
        runId: randomUUID(),
        checkpoint: 2,
      }).success,
    ).toBe(false);
    expect(
      DiscoverInputSchema.safeParse({
        sourceKey: 'zhidianmijin',
        stream: 'new',
        runId: randomUUID(),
        pageLimit: 21,
      }).success,
    ).toBe(false);
    expect(
      DiscoverInputSchema.safeParse({
        sourceKey: 'zhidianmijin',
        stream: 'new',
        runId: randomUUID(),
        userId: randomUUID(),
      }).success,
    ).toBe(false);
  });
  it('租约到期旧token不可提交，重新领取递增围栏', () => {
    const claimed = task().claim(now);
    const expired = new Date(now.getTime() + INGESTION_POLICY.leaseMs);
    expect(() =>
      claimed.finish(claimed.snapshot().fencingToken, expired),
    ).toThrow(IngestionError);
    const reclaimed = claimed.claim(expired);
    expect(reclaimed.snapshot().fencingToken).toBe(2);
    expect(() => reclaimed.renew(1, expired)).toThrow(IngestionError);
  });
  it('领取后新刷新需要后继，而领取前请求已覆盖', () => {
    const requested = task().request(now).claim(now);
    expect(requested.needsSuccessor()).toBe(false);
    expect(requested.request(now).needsSuccessor()).toBe(true);
  });
  it('可重试失败退避并封顶，人工恢复保留累计尝试', () => {
    let current = task();
    let time = now;
    for (let i = 0; i < 3; i++) {
      current = current.claim(time);
      current = current.fail(
        current.snapshot().fencingToken,
        time,
        new IngestionError('SOURCE_UNAVAILABLE'),
        0,
      );
      time = current.snapshot().availableAt;
    }
    expect(current.snapshot().status).toBe('failed');
    const restored = current.retry(3, time);
    expect(restored.snapshot().attempt).toBe(3);
    expect(restored.claim(time).snapshot().attempt).toBe(4);
    expect(() => current.retry(2, time)).toThrow(IngestionError);
  });
  it('来源访问受限暂停，不自动作为成功或关闭', () => {
    const current = task()
      .claim(now)
      .fail(1, now, new IngestionError('SOURCE_ACCESS_BLOCKED'), 0);
    expect(current.snapshot().status).toBe('paused');
    expect(current.request(now).snapshot().status).toBe('paused');
    expect(() => current.claim(now)).toThrow();
  });
  it('检查点只接受当前周期和版本', () => {
    const stream = new SourceStreamEntity({
      id: 'zhidianmijin:new',
      streamKey: 'new',
      generation: 1,
      checkpoint: 1,
      checkpointVersion: 1,
      nextDiscoveryAt: now,
      pauseReason: null,
      stateVersion: 1,
    });
    expect(stream.advance(1, 1, 2).snapshot().checkpoint).toBe(2);
    expect(() => stream.advance(0, 1, 2)).toThrow();
    expect(() => stream.advance(1, 0, 2)).toThrow();
  });
  it('条件树前置拒绝过深与错误类型，未知不被消除', () => {
    let node: unknown = { type: 'unknown', reason: '经验未写明', evidence: [] };
    expect(RuleTreeSchema.parse(node)).toMatchObject({ type: 'unknown' });
    for (let i = 0; i < 9; i++)
      node = { type: 'all', children: [node], evidence: [] };
    expect(RuleTreeSchema.safeParse(node).success).toBe(false);
    expect(
      ReviewInputSchema.safeParse({
        tree: {
          type: 'condition',
          condition: { field: 'age', operator: 'gte', value: ['本科'] },
          evidence: [],
        },
      }).success,
    ).toBe(false);
  });
  it('成功获取时间与核验分开，日期截止当天及过期均不新鲜', () => {
    const body = {
      title: '测试岗位',
      company: null,
      cities: [],
      recruitmentType: 'social' as const,
      blocks: ['经验未明确'],
      deadline: { value: null, precision: 'unknown' as const, timezone: null },
      availability: 'open' as const,
      links: [],
      parserVersion: 'test',
    };
    expect(freshness(body, new Date(now.getTime() - 86_400_001), now)).toBe(
      'pending',
    );
    expect(
      freshness(
        {
          ...body,
          deadline: {
            value: '2026-10-30',
            precision: 'date',
            timezone: 'Asia/Shanghai',
          },
        },
        now,
        now,
      ),
    ).toBe('pending');
    const id = randomUUID();
    const original = new SourceResourceEntity({
      id,
      kind: 'job',
      sourceId: 'not-standard-uuid',
      canonicalUrl: 'https://www.zhidianmijin.com.cn/jobs/example',
      currentVersionId: null,
      lastAttemptAt: null,
      lastFetchedAt: null,
      nextRefreshAt: now,
      reviewVersion: 0,
      currentReviewId: null,
      stateVersion: 0,
    });
    expect(
      original.observe(randomUUID(), now, body).snapshot().lastFetchedAt,
    ).toEqual(now);
    expect(original.snapshot().lastFetchedAt).toBe(null);
  });
});
