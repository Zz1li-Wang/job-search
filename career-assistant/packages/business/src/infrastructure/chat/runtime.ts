import { createResumeServices } from '../../application/resume/services.js';
import { createPrivateFileStore } from '../private-files.js';
import { extractDocument } from '../resume/documents.js';
import { createExtractionClient } from '../resume/client.js';
import { randomUUID, createHash } from 'node:crypto';
import { createPersistence } from '../persistence.js';
import { createAuthSecurity } from '../auth/security.js';
import { createChatServices } from '../../application/chat/services.js';
import { createAgentClient } from './client.js';
export async function createAssistantRuntime(settings: {
  databaseUrl: string;
  privateRoot: string;
  tokenPepper: string;
  csrfSecret: string;
  agentBase: string;
  callbackBase: string;
  serviceToken: string;
}) {
  const persistence = createPersistence(settings.databaseUrl);
  const security = await createAuthSecurity(settings);
  const services = createChatServices({
    unitOfWork: persistence.unitOfWork,
    repositories: persistence.chat,
    jobRepositories: persistence.jobs,
    source: persistence.ingestion,
    tokens: security.tokens,
    id: randomUUID,
    digest: (text) => createHash('sha256').update(text).digest('hex'),
    now: () => new Date(),
    agent: createAgentClient(settings.agentBase, settings.serviceToken),
    callbackBase: settings.callbackBase,
  });
  const resumes = createResumeServices({
    unitOfWork: persistence.unitOfWork,
    repositories: persistence.chat,
    jobRepositories: persistence.jobs,
    resumes: persistence.resumes,
    privacy: persistence.privacy,
    source: persistence.ingestion,
    tokens: security.tokens,
    id: randomUUID,
    digest: (text) => createHash('sha256').update(text).digest('hex'),
    now: () => new Date(),
    agent: createAgentClient(settings.agentBase, settings.serviceToken),
    callbackBase: settings.callbackBase,
    files: createPrivateFileStore(settings.privateRoot),
    extract: extractDocument,
    extractProfile: createExtractionClient(
      settings.agentBase,
      settings.serviceToken,
    ),
  });
  return { persistence, services, resumes, close: () => persistence.close() };
}
