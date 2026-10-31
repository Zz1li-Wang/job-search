import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  JobPageSchema,
  JobDetailSchema,
  EvidenceBundleSchema,
  ProfileSchema,
  EligibilitySchema,
} from '@career/contracts';
import { makeJobsFixture } from '../fixtures/jobs.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function fixture() {
  const f = await makeJobsFixture();
  cleanups.push(f.close);
  return f;
}
async function firstJob(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.request('/jobs');
  return JobPageSchema.parse((await response.json()).payload).entries[0]!;
}
describe('岗位画像资格逐接口', () => {
  it('JOB-01 筛选分页签名与会话校验', async () => {
    const f = await fixture();
    const response = await f.request('/jobs?limit=1');
    expect(response.status).toBe(200);
    const page = JobPageSchema.parse((await response.json()).payload);
    expect(page.entries).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    expect(
      (await f.request('/jobs?limit=1&cursor=' + page.nextCursor)).status,
    ).toBe(200);
    expect((await f.request('/jobs?cursor=invalid')).status).toBe(400);
    const filtered = await f.request('/jobs?recruitmentType=social');
    expect(
      JobPageSchema.parse((await filtered.json()).payload).entries.every(
        (j) => j.recruitmentType === 'social',
      ),
    ).toBe(true);
    expect((await fetch(f.api.base + '/api/v1/jobs')).status).toBe(401);
  });
  it('JOB-02 详情安全字段与不存在岗位', async () => {
    const f = await fixture();
    const job = await firstJob(f);
    const response = await f.request('/jobs/' + job.id);
    expect(response.status).toBe(200);
    const detail = JobDetailSchema.parse((await response.json()).payload);
    expect(detail.title).toBeTruthy();
    expect(detail.isComplete).toBe(false);
    expect((await f.request('/jobs/' + randomUUID())).status).toBe(404);
    expect(
      (await f.request('/jobs/' + job.id + '?userId=' + f.user.id)).status,
    ).toBe(400);
  });
  it('JOB-03 原文证据与版本冲突不输出存储路径', async () => {
    const f = await fixture();
    const job = await firstJob(f);
    const response = await f.request('/jobs/' + job.id + '/evidence');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      EvidenceBundleSchema.parse(body.payload).entries.length,
    ).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toMatch(/storageKey|password|cookie/);
    expect(
      (
        await f.request(
          '/jobs/' + job.id + '/evidence?expectedJobVersion=' + randomUUID(),
        )
      ).status,
    ).toBe(409);
  });
  it('PROFILE-01 正式画像为空不创建假资料且只返回本人', async () => {
    const f = await fixture();
    const response = await f.request('/profile');
    expect(response.status).toBe(200);
    expect(ProfileSchema.parse((await response.json()).payload)).toEqual({
      content: null,
      version: 0,
      confirmedAt: null,
    });
    expect((await f.request('/profile?userId=' + randomUUID())).status).toBe(
      400,
    );
    await f.confirmProfile();
    expect(
      ProfileSchema.parse((await (await f.request('/profile')).json()).payload)
        .version,
    ).toBe(1);
  });
  it('ELIG-01 三态结果幂等社招应届与版本冲突', async () => {
    const f = await fixture();
    const page = JobPageSchema.parse(
      (await (await f.request('/jobs?recruitmentType=social')).json()).payload,
    );
    const job = page.entries[0]!;
    await f.review(job.id);
    let detail = JobDetailSchema.parse(
      (await (await f.request('/jobs/' + job.id)).json()).payload,
    );
    const input = {
      jobId: job.id,
      expectedJobVersion: detail.jobVersionId,
      expectedProfileVersion: 0,
      expectedReviewVersion: detail.reviewVersion,
      expectedEvidenceDependencyHash: detail.evidenceDependencyHash,
    };
    const key = randomUUID();
    const response = await f.request('/eligibility-checks', 'POST', input, key);
    expect(response.status).toBe(201);
    const pending = EligibilitySchema.parse((await response.json()).payload);
    expect(pending.status).toBe('pending');
    expect(
      EligibilitySchema.parse(
        (
          await (
            await f.request('/eligibility-checks', 'POST', input, key)
          ).json()
        ).payload,
      ).checkId,
    ).toBe(pending.checkId);
    await f.confirmProfile();
    detail = JobDetailSchema.parse(
      (await (await f.request('/jobs/' + job.id)).json()).payload,
    );
    const success = await f.request(
      '/eligibility-checks',
      'POST',
      { ...input, expectedProfileVersion: 1 },
      randomUUID(),
    );
    expect(success.status).toBe(201);
    expect(EligibilitySchema.parse((await success.json()).payload).status).toBe(
      'eligible',
    );
    expect(
      (
        await f.request(
          '/eligibility-checks',
          'POST',
          { ...input, expectedProfileVersion: 1 },
          key,
        )
      ).status,
    ).toBe(409);
  });
  it('ELIG-02 历史记录随画像变化失效且其他账号不可见', async () => {
    const f = await fixture();
    const job = await firstJob(f);
    const detail = JobDetailSchema.parse(
      (await (await f.request('/jobs/' + job.id)).json()).payload,
    );
    const response = await f.request(
      '/eligibility-checks',
      'POST',
      {
        jobId: job.id,
        expectedJobVersion: detail.jobVersionId,
        expectedProfileVersion: 0,
        expectedReviewVersion: detail.reviewVersion,
        expectedEvidenceDependencyHash: detail.evidenceDependencyHash,
      },
      randomUUID(),
    );
    const check = EligibilitySchema.parse((await response.json()).payload);
    await f.confirmProfile();
    const read = await f.request('/eligibility-checks/' + check.checkId);
    expect(read.status).toBe(200);
    expect(EligibilitySchema.parse((await read.json()).payload).isCurrent).toBe(
      false,
    );
    const other = f.api.client();
    await other.signedIn();
    expect(
      (
        await fetch(
          f.api.base + '/api/v1/eligibility-checks/' + check.checkId,
          { headers: { cookie: other.cookieHeader() } },
        )
      ).status,
    ).toBe(404);
  });
});
