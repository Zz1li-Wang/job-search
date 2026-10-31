import type { NestExpressApplication } from '@nestjs/platform-express';
import { HTTP_BODY_POLICY } from '@career/contracts';
import { PrivacyHttpModule } from './privacy/module.js';
import { CareerHttpModule } from './career/module.js';
import { ResumeHttpModule } from './resume/module.js';
import { ChatHttpModule } from './chat/module.js';
import { randomUUID, createHash } from 'node:crypto';
import { JobsHttpModule } from './jobs/module.js';
import { IngestionConfigSchema, readConfig } from '@career/config';
import { IngestionHttpModule } from './ingestion/module.js';
import type { ApiConfig, AuthConfig } from '@career/config';
import {
  createPersistence,
  PrivacyService,
  CareerService,
  createResumeServices,
  createPrivateFileStore,
  extractDocument,
  createExtractionClient,
  createChatServices,
  createAgentClient,
  createJobsServices,
  createIngestionRuntime,
  createAuthSecurity,
  createAuthServices,
  type Clock,
  type PasswordHasher,
  type PrivateFileStore,
} from '@career/business';
import { HealthService, createHealthApplication } from '@career/observability';
import { AuthHttpModule } from './auth/module.js';

/** 装配仅连接应用端口与基础设施，生产不读取任何验证码测试开关。 */
export async function createApiApplication(
  config: { api: ApiConfig; auth: AuthConfig },
  overrides: {
    clock?: Clock;
    answer?: () => string;
    passwords?: PasswordHasher;
    files?: PrivateFileStore;
  } = {},
) {
  const persistence = createPersistence(config.api.DATABASE_URL);
  const ingestionConfig = readConfig(IngestionConfigSchema, process.env);
  const ingestion = createIngestionRuntime({
    databaseUrl: config.api.DATABASE_URL,
    privateRoot: config.api.PRIVATE_FILE_ROOT,
    exportRoot: ingestionConfig.INGESTION_EXPORT_ROOT,
    operatorReference: ingestionConfig.INGESTION_OPERATOR_REFERENCE,
    network: {
      enabled: false,
      budgetId: ingestionConfig.INGESTION_BUDGET_ID,
      requestLimit: ingestionConfig.INGESTION_REQUEST_LIMIT,
    },
  });
  try {
    const security = await createAuthSecurity(
      {
        tokenPepper: config.auth.AUTH_TOKEN_PEPPER,
        csrfSecret: config.auth.AUTH_CSRF_SECRET,
      },
      overrides,
    );
    const services = createAuthServices({
      unitOfWork: persistence.unitOfWork,
      repositories: persistence.auth,
      clock: overrides.clock ?? { now: () => new Date() },
      ...security,
    });
    const jobServices = createJobsServices({
      unitOfWork: persistence.unitOfWork,
      repeatableRead: persistence.repeatableRead,
      repositories: persistence.jobs,
      source: persistence.ingestion,
      tokens: security.tokens,
      id: randomUUID,
      digest: (value) => createHash('sha256').update(value).digest('hex'),
      now: () => overrides.clock?.now() ?? new Date(),
    });
    const chatServices = createChatServices({
      unitOfWork: persistence.unitOfWork,
      repositories: persistence.chat,
      jobRepositories: persistence.jobs,
      source: persistence.ingestion,
      tokens: security.tokens,
      id: randomUUID,
      digest: (value) => createHash('sha256').update(value).digest('hex'),
      now: () => overrides.clock?.now() ?? new Date(),
      agent: createAgentClient(
        process.env.AGENT_INTERNAL_URL ??
          `http://127.0.0.1:${config.api.AGENT_PORT}`,
        config.api.SERVICE_AUTH_TOKEN,
      ),
      callbackBase:
        process.env.API_INTERNAL_URL ??
        `http://127.0.0.1:${config.api.API_PORT}`,
    });
    const resumeServices = createResumeServices({
      unitOfWork: persistence.unitOfWork,
      repositories: persistence.chat,
      jobRepositories: persistence.jobs,
      resumes: persistence.resumes,
      privacy: persistence.privacy,
      source: persistence.ingestion,
      tokens: security.tokens,
      id: randomUUID,
      digest: (value) => createHash('sha256').update(value).digest('hex'),
      now: () => overrides.clock?.now() ?? new Date(),
      agent: createAgentClient(
        process.env.AGENT_INTERNAL_URL ??
          `http://127.0.0.1:${config.api.AGENT_PORT}`,
        config.api.SERVICE_AUTH_TOKEN,
      ),
      callbackBase:
        process.env.API_INTERNAL_URL ??
        `http://127.0.0.1:${config.api.API_PORT}`,
      files:
        overrides.files ?? createPrivateFileStore(config.api.PRIVATE_FILE_ROOT),
      extract: extractDocument,
      extractProfile: createExtractionClient(
        process.env.AGENT_INTERNAL_URL ??
          `http://127.0.0.1:${config.api.AGENT_PORT}`,
        config.api.SERVICE_AUTH_TOKEN,
      ),
    });
    const careerService = new CareerService({
      unitOfWork: persistence.unitOfWork,
      repeatableRead: persistence.repeatableRead,
      repositories: persistence.jobs,
      career: persistence.career,
      source: persistence.ingestion,
      tokens: security.tokens,
      id: randomUUID,
      digest: (text) => createHash('sha256').update(text).digest('hex'),
      now: () => overrides.clock?.now() ?? new Date(),
    });
    const privacyService = new PrivacyService({
      unitOfWork: persistence.unitOfWork,
      repeatableRead: persistence.repeatableRead,
      repositories: persistence.jobs,
      privacy: persistence.privacy,
      resumes: persistence.resumes,
      source: persistence.ingestion,
      tokens: security.tokens,
      id: randomUUID,
      digest: (text) => createHash('sha256').update(text).digest('hex'),
      now: () => overrides.clock?.now() ?? new Date(),
      auth: {
        unitOfWork: persistence.unitOfWork,
        repositories: persistence.auth,
        clock: overrides.clock ?? { now: () => new Date() },
        ...security,
      },
    });
    const authModule = AuthHttpModule.register({
      services,
      tokens: security.tokens,
      config: config.auth,
    });
    const app = await createHealthApplication(
      {
        health: new HealthService('api', [
          persistence.probe,
          persistence.authProbe,
          persistence.ingestionProbe,
          persistence.applicationProbe,
        ]),
      },
      [
        authModule,
        ChatHttpModule.register(
          {
            services: chatServices,
            resumes: resumeServices,
            jobs: jobServices,
            ingestion: ingestion.services,
            serviceToken: config.api.SERVICE_AUTH_TOKEN,
          },
          authModule,
        ),
        PrivacyHttpModule.register(privacyService, authModule),
        CareerHttpModule.register(careerService, authModule),
        ResumeHttpModule.register(resumeServices, authModule),
        JobsHttpModule.register(jobServices, authModule),
        IngestionHttpModule.register(ingestion.services, authModule),
      ],
    );
    (app as NestExpressApplication).useBodyParser('json', {
      limit: HTTP_BODY_POLICY.apiJsonBytes,
    });
    if (config.auth.AUTH_TRUSTED_PROXIES.length)
      app
        .getHttpAdapter()
        .getInstance()
        .set('trust proxy', config.auth.AUTH_TRUSTED_PROXIES);
    return {
      app,
      chatServices,
      resumeServices,
      async close() {
        await app.close();
        await persistence.close();
        await ingestion.close();
      },
    };
  } catch (error) {
    await ingestion.close();
    await persistence.close();
    throw error;
  }
}
