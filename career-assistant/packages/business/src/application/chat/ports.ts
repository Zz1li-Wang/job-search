import type { JobsRepository } from '../jobs/ports.js';
import type {
  ConversationEntity,
  AgentRunEntity,
  ConversationState,
  AgentRunState,
} from '../../domain/chat/entities.js';
import type {
  CitationDto,
  RunEventPayload,
  RunEventDto,
  AgentRunInputDto,
  ActorDto,
} from '@career/contracts';
import type { TransactionContext, UnitOfWork } from '../ports.js';
import type { IngestionRepository } from '../ingestion/ports.js';
import type { TokenCodec } from '../auth/ports.js';
export interface MessageRecord {
  id: string;
  conversationId: string;
  clientMessageId: string | null;
  requestHash: string | null;
  role: 'user' | 'assistant';
  text: string;
  runId: string | null;
  status: 'submitted' | 'completed' | 'partial' | 'failed';
  citations: CitationDto[];
  createdAt: Date;
}
export interface ChatRepository {
  listConversations(userId: string): Promise<ConversationEntity[]>;
  getConversation(
    id: string,
    userId: string,
    lock?: boolean,
  ): Promise<ConversationEntity | null>;
  insertConversation(entity: ConversationEntity): Promise<void>;
  saveConversation(entity: ConversationEntity): Promise<void>;
  eraseConversationContent(id: string): Promise<void>;
  getRun(id: string, lock?: boolean): Promise<AgentRunEntity | null>;
  insertRun(entity: AgentRunEntity): Promise<void>;
  saveRun(entity: AgentRunEntity, expectedVersion: number): Promise<boolean>;
  listRunsDue(now: Date): Promise<AgentRunEntity[]>;
  claimQueued(now: Date): Promise<AgentRunEntity | null>;
  listMessages(conversationId: string): Promise<MessageRecord[]>;
  findClientMessage(
    conversationId: string,
    clientMessageId: string,
  ): Promise<MessageRecord | null>;
  insertMessage(record: MessageRecord): Promise<void>;
  listEvents(runId: string, after: number): Promise<RunEventDto[]>;
  getEvent(
    runId: string,
    sequence: number,
  ): Promise<{ hash: string; event: RunEventDto } | null>;
  insertEvent(
    runId: string,
    sequence: number,
    payload: RunEventPayload,
    hash: string,
    createdAt: Date,
  ): Promise<void>;
  registerDispatch(runId: string, now: Date): Promise<void>;
  markDispatchCompleted(runId: string, now: Date): Promise<void>;
  getUserEpoch(userId: string): Promise<{
    authEpoch: number;
    personalDataEpoch: number;
    deletedAt: Date | null;
  } | null>;
  consumeTool(runId: string): Promise<boolean>;
}
export interface AgentClient {
  dispatch(input: AgentRunInputDto): Promise<void>;
  cancel(runId: string): Promise<void>;
}
export interface ChatDependencies {
  unitOfWork: UnitOfWork;
  jobRepositories(context: TransactionContext): JobsRepository;
  repositories(context: TransactionContext): ChatRepository;
  source(context: TransactionContext): IngestionRepository;
  tokens: TokenCodec;
  id(): string;
  digest(text: string): string;
  now(): Date;
  agent: AgentClient;
  callbackBase: string;
}
export type { ConversationState, AgentRunState, ActorDto };
