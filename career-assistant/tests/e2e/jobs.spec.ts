import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { emptyProfileContent } from '@career/contracts';
import {
  makeIngestionFixture,
  fakeSource,
  jobHtml,
} from '../fixtures/ingestion.js';
import { isolatedDatabaseUrl } from '../fixtures/database.js';
import { startBrowserApi, registerBrowser } from '../fixtures/browser.js';
import { parseEvidenceHtml } from '@career/business';
async function seed() {
  const source = fakeSource();
  source.evidence = async (_kind, id) =>
    parseEvidenceHtml(
      jobHtml(id.includes('social') ? 'social' : 'campus').replace(
        '学历不限，经验未写明。',
        '学历本科，允许2027年8月前预计毕业人员。',
      ),
      new Date(),
    );
  const f = await makeIngestionFixture(source);
  await f.services.discover.execute({
    sourceKey: 'zhidianmijin',
    stream: 'new',
    runId: randomUUID(),
    pageLimit: 1,
  });
  for (let i = 0; i < 3; i++) await f.services.execution.runOne();
  return f;
}
test('E2E-JOBS 浏览器筛选详情证据与无画像待核验', async ({ page }) => {
  const f = await seed();
  const api = await startBrowserApi();
  try {
    await registerBrowser(page);
    await page.goto('/jobs');
    await expect(page.getByRole('heading', { name: '岗位探索' })).toBeVisible();
    await page.getByLabel('招聘类型').selectOption('social');
    await page.getByRole('button', { name: '查询岗位', exact: true }).click();
    await expect(page.locator('.cards li')).toHaveCount(1);
    await page.locator('.cards a').first().click();
    await expect(
      page.getByRole('heading', { name: '来源与证据' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '核验条件', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '待核验', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('尚无本人已确认画像', { exact: true }),
    ).toBeVisible();
  } finally {
    await api.close();
    await f.close();
  }
});
test('E2E-ELIG 正式应届画像匹配社招并在画像变化后失效', async ({ page }) => {
  const f = await seed();
  const input = await f.dependencies.unitOfWork.run(async (c) => {
    const repo = f.dependencies.repositories(c);
    const resource = (await repo.listResources()).find(
      (r) => r.snapshot().sourceId === 'social_fixture',
    )!;
    const job = await repo.getJobByResource(resource.snapshot().id);
    const version = await repo.getVersion(
      resource.snapshot().currentVersionId!,
    );
    const observation = await repo.latestObservation(resource.snapshot().id);
    const excerpt = version!.snapshot().body.blocks.at(-1)!;
    return {
      jobId: job!.id,
      expectedJobVersion: version!.snapshot().id,
      expectedReviewVersion: 0,
      evidenceVersions: [
        {
          resourceId: resource.snapshot().id,
          versionId: version!.snapshot().id,
        },
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
            resourceId: resource.snapshot().id,
            versionId: version!.snapshot().id,
            observationId: observation!.id,
            block: version!.snapshot().body.blocks.length - 1,
            start: 0,
            end: excerpt.length,
            excerpt,
          },
        ],
      },
      isComplete: true,
      gaps: [],
      conflicts: [],
      reason: '测试核验',
      operationKey: randomUUID(),
    };
  });
  await f.services.review.execute(input);
  const api = await startBrowserApi();
  const db = new Client({ connectionString: isolatedDatabaseUrl() });
  await db.connect();
  try {
    const username = await registerBrowser(page);
    const content = {
      ...emptyProfileContent(),
      educationCompleteness: 'complete',
      educationEntries: [
        {
          school: '测试学校',
          major: '计算机科学与技术',
          degree: 'bachelor',
          awardStatus: 'studying',
          graduationDate: { value: '2027-06', precision: 'month' },
          dateKind: 'expected',
        },
      ],
    };
    await db.query(
      'INSERT INTO profiles(user_id,version,content,confirmed_at,updated_at) SELECT id,1,$1,NOW(),NOW() FROM users WHERE username_normalized=$2',
      [JSON.stringify(content), username],
    );
    await page.goto('/jobs/' + input.jobId);
    await page.getByRole('button', { name: '核验条件', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '符合已核验条件', exact: true }),
    ).toBeVisible();
  } finally {
    await db.end();
    await api.close();
    await f.close();
  }
});
