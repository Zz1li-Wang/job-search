import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { availablePort, waitForHealth, stopProcess } from '@career/testing';
import { startBrowserApi, registerBrowser } from '../fixtures/browser.js';
import { startModelFixture } from '../fixtures/model.js';
test('E2E-CHAT 浏览器多轮问答经独立Agent和真实MCP后持久化', async ({
  page,
}) => {
  const model = await startModelFixture(),
    agentPort = await availablePort();
  const api = await startBrowserApi({
    TEST_CHAT_DISPATCH: 'true',
    AGENT_INTERNAL_URL: `http://127.0.0.1:${agentPort}`,
    AGENT_PORT: String(agentPort),
  });
  const agent = spawn(process.execPath, ['apps/agent/dist/main.js'], {
    env: {
      ...api.env,
      MODEL_BASE_URL: model.url,
      MODEL_API_KEY: 'local-fixture',
      AGENT_PORT: String(agentPort),
    },
    stdio: 'pipe',
  });
  try {
    await waitForHealth(
      `http://127.0.0.1:${agentPort}/health/live`,
      api.env.SERVICE_AUTH_TOKEN,
    );
    await registerBrowser(page);
    await page.goto('/chat');
    await expect(page.getByRole('region', { name: '简历资料' })).toBeHidden();
    await page.getByRole('button', { name: '新建咨询' }).click();
    await page.getByLabel('你的求职问题').fill('我想准备毕业求职，请提供建议');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(
      page.getByText('请先梳理你的求职方向。尚未确认的资料需要你核对。', {
        exact: true,
      }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '求职咨询', exact: true }).click();
    await expect(
      page.getByText('请先梳理你的求职方向。尚未确认的资料需要你核对。', {
        exact: true,
      }),
    ).toBeVisible();
    expect(model.calls()).toBe(2);
  } finally {
    await stopProcess(agent);
    await api.close();
    await model.close();
  }
});
