import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { registerBrowser, startBrowserApi } from '../fixtures/browser.js';
import { startBrowserAssistant } from '../fixtures/browser-assistant.js';
import { makeIngestionFixture, fakeSource } from '../fixtures/ingestion.js';
async function seed() {
  const f = await makeIngestionFixture(fakeSource());
  await f.services.discover.execute({
    sourceKey: 'zhidianmijin',
    stream: 'new',
    runId: randomUUID(),
    pageLimit: 1,
  });
  for (let i = 0; i < 3; i++) await f.services.execution.runOne();
  return f;
}
test('E2E-RESUME 上传私有文件解析草稿核对确认后删除原文', async ({ page }) => {
  const runtime = await startBrowserAssistant();
  try {
    await registerBrowser(page);
    await page.goto('/resumes');
    await expect(page).toHaveURL(/\/chat\?resumes=open$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      '求职咨询',
    );
    await expect(
      page.getByRole('navigation', { name: '求职工作台' }),
    ).toHaveCount(1);
    await page.reload();
    await expect(page.getByRole('region', { name: '简历资料' })).toBeVisible();
    await page.getByLabel('选择简历文件').setInputFiles({
      name: 'fictional-resume.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('TypeScript'),
    });
    await page.getByRole('button', { name: '上传并解析', exact: true }).click();
    await page.getByRole('link', { name: '核对画像草稿' }).click();
    await expect(page.getByLabel('技能（每行一项）')).toHaveValue('TypeScript');
    await page.getByRole('button', { name: '确认并更新正式画像' }).click();
    await expect(page.getByRole('status')).toContainText('已确认正式画像');
    await page.getByRole('link', { name: '返回求职咨询', exact: true }).click();
    await expect(page).toHaveURL(/\/chat\?resumes=open$/);
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: '删除简历', exact: true }).click();
    await expect(
      page.getByText('还没有简历，也可以直接在我的画像中手动填写。'),
    ).toBeVisible();
    await page.goto('/profile');
    await expect(page.getByLabel('技能（每行一项）')).toHaveValue('TypeScript');
    expect(runtime.model.calls()).toBe(1);
  } finally {
    await runtime.close();
  }
});
test('E2E-PROFILE 手填教育事实显式确认并检测错误日期', async ({ page }) => {
  const api = await startBrowserApi();
  try {
    await registerBrowser(page);
    await page.goto('/profile');
    await page.getByRole('button', { name: '添加教育经历' }).click();
    await page.getByLabel('学校', { exact: true }).fill('虚构大学');
    await page.getByLabel('专业', { exact: true }).fill('计算机科学与技术');
    await page
      .getByRole('combobox', { name: '学历', exact: true })
      .selectOption('bachelor');
    await page.getByLabel('取得状态').selectOption('studying');
    await page.getByLabel('毕业时间', { exact: true }).fill('2027-13');
    await page.getByRole('button', { name: '保存待确认草稿' }).click();
    await expect(page.getByRole('alert')).toContainText('请核对日期格式');
    await page.getByLabel('毕业时间', { exact: true }).fill('2027-06');
    await page.getByLabel('毕业时间性质').selectOption('expected');
    await page.getByRole('button', { name: '保存待确认草稿' }).click();
    await expect(page.getByRole('status')).toContainText('正式画像尚未更新');
    await page.getByRole('button', { name: '确认并更新正式画像' }).click();
    await expect(page.getByRole('status')).toContainText('版本 1');
    await page.reload();
    await expect(page.getByLabel('学校', { exact: true })).toHaveValue(
      '虚构大学',
    );
  } finally {
    await api.close();
  }
});
test('E2E-CAREER 收藏和投递进度手动修改历史及重复删除', async ({ page }) => {
  const source = await seed(),
    api = await startBrowserApi();
  try {
    await registerBrowser(page);
    await page.goto('/jobs');
    await page.locator('.cards a').first().click();
    await page.getByRole('button', { name: '收藏岗位', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已收藏');
    await page.getByRole('button', { name: '加入投递进度' }).click();
    await page.goto('/favorites');
    await expect(page.locator('.cards li')).toHaveCount(1);
    await page.getByRole('button', { name: '取消收藏' }).click();
    await expect(page.locator('.cards li')).toHaveCount(0);
    await page.goto('/applications');
    await page
      .getByRole('combobox', { name: '投递状态', exact: true })
      .selectOption('interview');
    await page.getByLabel('备注', { exact: true }).fill('已收到面试邀请');
    await page.getByRole('button', { name: '保存进度', exact: true }).click();
    await expect(
      page.getByText('当前：面试 · 版本 2', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '查看变更历史' }).click();
    await expect(page.locator('article ol li')).toHaveCount(2);
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: '删除投递记录' }).click();
    await expect(
      page.getByText('暂无记录。可在岗位详情中加入准备投递列表。'),
    ).toBeVisible();
  } finally {
    await api.close();
    await source.close();
  }
});
test('E2E-PRIVACY 个人数据清空保留账号并可删除账号', async ({ page }) => {
  const api = await startBrowserApi();
  try {
    await registerBrowser(page);
    await page.goto('/profile');
    await page.getByLabel('技能（每行一项）').fill('SQL');
    await page.getByRole('button', { name: '保存待确认草稿' }).click();
    await page.getByRole('button', { name: '确认并更新正式画像' }).click();
    await expect(page.getByRole('status')).toContainText('已确认正式画像');
    await page.goto('/privacy');
    await page.getByLabel('删除范围').selectOption('personal');
    await page.getByLabel('请输入“确认删除”').fill('确认删除');
    await page.getByRole('button', { name: '执行所选删除' }).click();
    await expect(page.getByRole('status')).toContainText('所选数据已删除');
    await page.goto('/profile');
    await expect(page.getByLabel('技能（每行一项）')).toHaveValue('');
    await page.goto('/privacy');
    await page.getByLabel('删除范围').selectOption('account');
    await page
      .getByLabel('当前密码', { exact: true })
      .fill('browser-fixture-password-123');
    await page.getByLabel('请输入“确认删除”').fill('确认删除');
    await page.getByRole('button', { name: '执行所选删除' }).click();
    await expect(page).toHaveURL(/\/login$/);
  } finally {
    await api.close();
  }
});

test('E2E-WORKSPACE 移动端从简历咨询核验收藏投递到清空资料的完整路径', async ({
  page,
}) => {
  test.setTimeout(90000);
  const source = await seed(),
    runtime = await startBrowserAssistant();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await registerBrowser(page);
    await page.getByRole('link', { name: '返回首页', exact: true }).click();
    await page.getByRole('link', { name: '求职咨询', exact: true }).click();
    await page.getByRole('button', { name: '上传简历 / 管理简历' }).click();
    await page.getByLabel('粘贴简历文本').fill('TypeScript');
    await page.screenshot({
      path: '.artifacts/consultation-entry-mobile.png',
      fullPage: true,
    });
    await page.getByRole('button', { name: '提交文本并解析' }).click();
    await page.getByRole('link', { name: '核对画像草稿' }).click();
    await page.getByRole('button', { name: '确认并更新正式画像' }).click();
    await expect(page.getByRole('status')).toContainText('已确认正式画像');
    await page.getByRole('link', { name: '返回求职咨询', exact: true }).click();
    await expect(page.getByRole('region', { name: '简历资料' })).toBeVisible();
    await page.getByRole('button', { name: '收起简历', exact: true }).click();
    await page.getByRole('button', { name: '新建咨询' }).click();
    await page.getByLabel('你的求职问题').fill('根据我的画像，如何准备面试？');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(
      page.getByText('请先梳理你的求职方向。尚未确认的资料需要你核对。', {
        exact: true,
      }),
    ).toBeVisible();
    await page.goto('/jobs');
    await page.locator('.cards a').first().click();
    await page.getByRole('button', { name: '核验条件', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '待核验', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '收藏岗位', exact: true }).click();
    await page.getByRole('button', { name: '加入投递进度' }).click();
    await page.goto('/applications');
    await page
      .getByRole('combobox', { name: '投递状态', exact: true })
      .selectOption('submitted');
    await page.getByLabel('备注', { exact: true }).fill('用户已在站外手动投递');
    await page.getByRole('button', { name: '保存进度', exact: true }).click();
    await expect(
      page.getByText('当前：已投递 · 版本 2', { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 2,
      ),
    ).toBe(true);
    await page.goto('/privacy');
    await page.getByLabel('删除范围').selectOption('personal');
    await page.getByLabel('请输入“确认删除”').fill('确认删除');
    await page.getByRole('button', { name: '执行所选删除' }).click();
    await expect(page.getByRole('status')).toContainText('访问已撤销');
    await page.goto('/favorites');
    await expect(page.getByText('尚无收藏，去')).toBeVisible();
    await page.goto('/applications');
    await expect(
      page.getByText('暂无记录。可在岗位详情中加入准备投递列表。'),
    ).toBeVisible();
    await page.goto('/trust');
    await expect(page.getByText('成功获取正文', { exact: true })).toBeVisible();
    expect(runtime.model.calls()).toBe(3);
  } finally {
    await runtime.close();
    await source.close();
  }
});

test('E2E-RESUME 日期格式失败明确提示并可显式重试生成草稿', async ({
  page,
}) => {
  const runtime = await startBrowserAssistant();
  try {
    await registerBrowser(page);
    await page.goto('/chat?resumes=open');
    runtime.model.setMode('invalid_dates');
    await page.getByLabel('粘贴简历文本').fill('2027.06');
    await page.getByRole('button', { name: '提交文本并解析' }).click();
    await expect(
      page.getByText('模型返回的资料格式无效，请重新解析或手动核对画像', {
        exact: false,
      }),
    ).toBeVisible();
    expect(runtime.model.calls()).toBe(1);
    runtime.model.setMode('dated_resume');
    await page.getByRole('button', { name: '重新解析（可能计费）' }).click();
    await page.getByRole('link', { name: '核对画像草稿' }).click();
    await expect(page.getByLabel('毕业时间', { exact: true })).toHaveValue(
      '2027-06',
    );
    expect(runtime.model.calls()).toBe(2);
    await expect(
      page.getByText('正式版本：0。', { exact: false }),
    ).toBeVisible();
  } finally {
    await runtime.close();
  }
});
