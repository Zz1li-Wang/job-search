import { randomUUID, createHash } from 'node:crypto';
import { Client } from 'pg';
import { makeIngestionFixture, fakeSource, jobHtml } from './ingestion.js';
import {
  makeAuthHttpFixture,
  isolatedDatabaseUrl,
  TEST_ORIGIN,
} from './auth.js';
import { emptyProfileContent, type ProfileContent } from '@career/contracts';
export async function makeJobsFixture() {
  const source = fakeSource();
  source.evidence = async (_kind, id) => {
    const { parseEvidenceHtml } = await import('@career/business');
    return parseEvidenceHtml(
      jobHtml(id.includes('social') ? 'social' : 'campus').replace(
        '学历不限，经验未写明。',
        '学历本科，明确允许2027年8月前预计毕业人员。',
      ),
      new Date(),
    );
  };
  const ingest = await makeIngestionFixture(source);
  await ingest.services.discover.execute({
    sourceKey: 'zhidianmijin',
    stream: 'new',
    runId: randomUUID(),
    pageLimit: 1,
  });
  for (let i = 0; i < 3; i++) await ingest.services.execution.runOne();
  const api = await makeAuthHttpFixture();
  const browser = api.client();
  const user = await browser.signedIn();
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    key?: string,
  ) {
    return fetch(api.base + '/api/v1' + path, {
      method,
      headers: {
        cookie: browser.cookieHeader(),
        origin: TEST_ORIGIN,
        'x-csrf-token': user.csrfToken,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function confirmProfile(
    content: ProfileContent = {
      ...emptyProfileContent(),
      educationCompleteness: 'complete',
      educationEntries: [
        {
          school: '虚构学校',
          major: '计算机科学与技术',
          degree: 'bachelor',
          awardStatus: 'studying',
          graduationDate: { value: '2027-06', precision: 'month' },
          dateKind: 'expected',
        },
      ],
    },
  ) {
    const db = new Client({ connectionString: isolatedDatabaseUrl() });
    await db.connect();
    try {
      await db.query(
        'INSERT INTO profiles(user_id,version,content,confirmed_at,updated_at) VALUES($1,1,$2,NOW(),NOW()) ON CONFLICT(user_id) DO UPDATE SET version=profiles.version+1,content=$2,confirmed_at=NOW(),updated_at=NOW()',
        [user.id, JSON.stringify(content)],
      );
    } finally {
      await db.end();
    }
  }
  async function review(jobId: string) {
    await ingest.dependencies.unitOfWork
      .run(async (c) => {
        const repo = ingest.dependencies.repositories(c);
        const job = await repo.getJob(jobId);
        if (!job) throw Error();
        const resource = await repo.getResource(job.resourceId);
        const version = await repo.getVersion(
          resource!.snapshot().currentVersionId!,
        );
        const observation = await repo.latestObservation(job.resourceId);
        const text = version!.snapshot().body.blocks.at(-1)!;
        const input = {
          jobId,
          expectedJobVersion: version!.snapshot().id,
          expectedReviewVersion: resource!.snapshot().reviewVersion,
          evidenceVersions: [
            { resourceId: job.resourceId, versionId: version!.snapshot().id },
          ],
          tree: {
            type: 'condition' as const,
            condition: {
              field: 'degree' as const,
              operator: 'in' as const,
              value: ['bachelor'],
              credentialRequirement: 'expected_by_date' as const,
              byDate: '2027-08-01',
            },
            evidence: [
              {
                resourceId: job.resourceId,
                versionId: version!.snapshot().id,
                observationId: observation!.id,
                block: version!.snapshot().body.blocks.length - 1,
                start: 0,
                end: text.length,
                excerpt: text,
              },
            ],
          },
          isComplete: true,
          gaps: [],
          conflicts: [],
          reason: '虚构测试核验',
          operationKey: randomUUID(),
        };
        return input;
      })
      .then((input) => ingest.services.review.execute(input));
  }
  return {
    api,
    ingest,
    user,
    browser,
    request,
    confirmProfile,
    review,
    digest: (text: string) => createHash('sha256').update(text).digest('hex'),
    async close() {
      await api.close();
      await ingest.close();
    },
  };
}
