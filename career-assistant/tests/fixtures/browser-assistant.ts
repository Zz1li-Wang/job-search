import { spawn } from 'node:child_process';
import { availablePort, waitForHealth, stopProcess } from '@career/testing';
import { startBrowserApi } from './browser.js';
import { startModelFixture } from './model.js';
export async function startBrowserAssistant() {
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
  } catch (error) {
    await stopProcess(agent);
    await api.close();
    await model.close();
    throw error;
  }
  return {
    model,
    async close() {
      await stopProcess(agent);
      await api.close();
      await model.close();
    },
  };
}
