import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client as DatabaseClient } from 'pg';
import { startModelFixture } from './model.js';
import { randomBytes } from 'node:crypto';
import { availablePort } from '@career/testing';
import {
  ApiConfigSchema,
  AuthConfigSchema,
  AgentConfigSchema,
} from '@career/config';
import { createApiApplication } from '../../apps/api/src/app.js';
import { createAgentApplication } from '../../apps/agent/src/app.js';
import { AuthHttpClient, fakePasswords, TEST_ORIGIN } from './auth.js';
import { isolatedDatabaseUrl } from './database.js';
/** 本地模型HTTP替身；与真实API、MCP、Agent、数据库组成全链路，不访问收费服务。 */
export async function makeChatFixture(
  options: { files?: import('@career/business').PrivateFileStore } = {},
) {
  const privateRoot = await mkdtemp(join(tmpdir(), 'career-resume-'));
  const model = await startModelFixture();
  const apiPort = await availablePort(),
    agentPortCandidate = await availablePort(),
    agentPort =
      agentPortCandidate === apiPort
        ? await availablePort()
        : agentPortCandidate,
    token = randomBytes(32).toString('hex');
  const previous = process.env.API_INTERNAL_URL;
  const base = `http://127.0.0.1:${apiPort}`;
  process.env.API_INTERNAL_URL = base;
  const previousAgent = process.env.AGENT_INTERNAL_URL;
  process.env.AGENT_INTERNAL_URL = `http://127.0.0.1:${agentPort}`;
  const authConfig = AuthConfigSchema.parse({
    AUTH_PUBLIC_ORIGIN: TEST_ORIGIN,
    AUTH_TOKEN_PEPPER: randomBytes(32).toString('hex'),
    AUTH_CSRF_SECRET: randomBytes(32).toString('hex'),
  });
  const runtime = await createApiApplication(
    {
      api: ApiConfigSchema.parse({
        DATABASE_URL: isolatedDatabaseUrl(),
        PRIVATE_FILE_ROOT: privateRoot,
        SERVICE_AUTH_TOKEN: token,
        API_PORT: apiPort,
        AGENT_PORT: agentPort,
      }),
      auth: authConfig,
    },
    {
      answer: () => '234567',
      passwords: fakePasswords,
      ...(options.files ? { files: options.files } : {}),
    },
  );
  if (previous === undefined) delete process.env.API_INTERNAL_URL;
  else process.env.API_INTERNAL_URL = previous;
  if (previousAgent === undefined) delete process.env.AGENT_INTERNAL_URL;
  else process.env.AGENT_INTERNAL_URL = previousAgent;
  await runtime.app.listen(apiPort, '127.0.0.1');
  const agent = await createAgentApplication(
    AgentConfigSchema.parse({
      API_INTERNAL_URL: base,
      AGENT_PORT: agentPort,
      SERVICE_AUTH_TOKEN: token,
      MODEL_BASE_URL: model.url,
      MODEL_API_KEY: 'local-fixture-only',
    }),
  );
  await agent.app.listen(agentPort, '127.0.0.1');
  const client = new AuthHttpClient(base),
    user = await client.signedIn();
  const request = (path: string, method = 'GET', body?: unknown) =>
    fetch(base + '/api/v1' + path, {
      method,
      headers: {
        cookie: client.cookieHeader(),
        origin: TEST_ORIGIN,
        'x-csrf-token': user.csrfToken,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    runtime,
    authConfig,
    agent,
    base,
    agentBase: `http://127.0.0.1:${agentPort}`,
    token,
    client,
    user,
    request,
    model,
    async close() {
      await agent.close();
      const db = new DatabaseClient({
        connectionString: isolatedDatabaseUrl(),
      });
      await db.connect();
      try {
        await db.query('DELETE FROM users WHERE id=$1', [user.id]);
      } finally {
        await db.end();
      }
      await runtime.close();
      await model.close();
      await rm(privateRoot, { recursive: true, force: true });
    },
  };
}
