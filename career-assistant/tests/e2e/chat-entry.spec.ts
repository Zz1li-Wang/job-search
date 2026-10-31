import { test, expect } from '@playwright/test';
import { startBrowserApi, registerBrowser } from '../fixtures/browser.js';
import { startBrowserAssistant } from '../fixtures/browser-assistant.js';

test('E2E-CHAT-ENTRY 匿名统一入口和旧地址不读取私有简历', async ({ page }) => {
  const api = await startBrowserApi();
  let privateReads = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/resumes') privateReads++;
  });
  try {
    await page.goto('/resumes');
    await expect(page).toHaveURL(/\/chat\?resumes=open$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      '求职咨询',
    );
    await expect(
      page.getByRole('link', { name: '登录', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('选择简历文件')).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: '简历', exact: true }),
    ).toHaveCount(0);
    expect(privateReads).toBe(0);
  } finally {
    await api.close();
  }
});

test('E2E-CHAT-ENTRY 简历失败后保留问题和会话，收起停止轮询并继续咨询', async ({
  page,
}) => {
  const runtime = await startBrowserAssistant();
  let resumeReads = 0;
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname === '/api/v1/resumes' &&
      request.method() === 'GET'
    )
      resumeReads++;
  });
  try {
    await registerBrowser(page);
    await page.getByRole('link', { name: '返回首页', exact: true }).click();
    await page.getByRole('link', { name: '求职咨询', exact: true }).click();
    await page.getByRole('button', { name: '上传简历 / 管理简历' }).click();
    await expect(page.getByRole('region', { name: '简历资料' })).toBeVisible();
    // 尚未创建咨询也可提交简历，失败样本使用本地模型的中断流。
    runtime.model.setMode('broken');
    await page.getByLabel('粘贴简历文本').fill('TypeScript');
    await page.getByRole('button', { name: '提交文本并解析' }).click();
    await expect(
      page.getByText('解析状态：解析失败', { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: '核对画像草稿' })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('button', { name: '重新解析（可能计费）' }),
    ).toBeVisible();
    expect(runtime.model.calls()).toBe(1);
    await page.getByRole('button', { name: '新建咨询' }).click();
    const question = '我想先了解面试准备，稍后处理简历';
    await page.getByLabel('你的求职问题').fill(question);
    await page.getByRole('button', { name: '收起简历', exact: true }).click();
    await expect(page.getByRole('region', { name: '简历资料' })).toBeHidden();
    await expect(page.getByLabel('你的求职问题')).toHaveValue(question);
    await expect(
      page.getByRole('button', { name: '求职咨询', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    const readsWhenClosed = resumeReads;
    // 超过原面板轮询周期，确保收起后没有继续读取资料。
    await page.waitForTimeout(1800);
    expect(resumeReads).toBe(readsWhenClosed);
    const uploadToggle = page.getByRole('button', {
      name: '上传简历 / 管理简历',
    });
    await uploadToggle.focus();
    await uploadToggle.press('Space');
    await expect(
      page.getByRole('button', { name: '收起简历', exact: true }),
    ).toHaveAttribute('aria-expanded', 'true');
    await expect(
      page.getByText('解析状态：解析失败', { exact: false }),
    ).toBeVisible();
    await expect(page.getByLabel('你的求职问题')).toHaveValue(question);
    expect(runtime.model.calls()).toBe(1);
    await page.screenshot({
      path: '.artifacts/consultation-entry-desktop.png',
      fullPage: true,
    });
    runtime.model.setMode('normal');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(
      page.getByText('请先梳理你的求职方向。尚未确认的资料需要你核对。', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: '简历资料' })).toBeVisible();
    expect(runtime.model.calls()).toBe(3);
  } finally {
    await runtime.close();
  }
});
