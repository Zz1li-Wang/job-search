import { EXECUTION_POLICY } from '@career/contracts';
import { z } from 'zod';
import { CitationSchema, RunEventPayloadSchema } from '@career/contracts';
import type { Prisma } from '../generated/client.js';
import {
  ConversationEntity,
  AgentRunEntity,
  AgentRunStateSchema,
} from '../../domain/chat/entities.js';
import type {
  ChatRepository,
  MessageRecord,
} from '../../application/chat/ports.js';
const MessageState = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  clientMessageId: z.uuid().nullable(),
  requestHash: z.string().nullable(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  runId: z.uuid().nullable(),
  status: z.enum(['submitted', 'completed', 'partial', 'failed']),
  citations: z.array(CitationSchema),
  createdAt: z.date(),
});
/** ORM行立即转为领域对象或有类型的查询投影。锁顺序由用例控制。 */
export function createChatRepository(
  db: Prisma.TransactionClient,
): ChatRepository {
  const event = (row: {
    runId: string;
    sequence: number;
    payload: unknown;
    createdAt: Date;
  }) => ({
    runId: row.runId,
    sequence: row.sequence,
    payload: RunEventPayloadSchema.parse(row.payload),
    createdAt: row.createdAt.toISOString(),
  });
  return {
    async listConversations(userId) {
      return (
        await db.conversation.findMany({
          where: { userId, deletedAt: null },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 100,
        })
      ).map((row) => new ConversationEntity(row));
    },
    async getConversation(id, userId, lock = false) {
      if (lock)
        await db.$queryRaw`SELECT id FROM conversations WHERE id=${id}::uuid AND user_id=${userId}::uuid FOR UPDATE`;
      const row = await db.conversation.findFirst({
        where: { id, userId, deletedAt: null },
      });
      return row ? new ConversationEntity(row) : null;
    },
    async insertConversation(entity) {
      await db.conversation.create({ data: entity.snapshot() });
    },
    async saveConversation(entity) {
      const s = entity.snapshot();
      await db.conversation.update({ where: { id: s.id }, data: s });
    },
    async eraseConversationContent(id) {
      await db.message.deleteMany({ where: { conversationId: id } });
      await db.agentRun.deleteMany({ where: { conversationId: id } });
    },
    async getRun(id, lock = false) {
      if (lock)
        await db.$queryRaw`SELECT id FROM agent_runs WHERE id=${id}::uuid FOR UPDATE`;
      const row = await db.agentRun.findUnique({ where: { id } });
      return row ? new AgentRunEntity(AgentRunStateSchema.parse(row)) : null;
    },
    async insertRun(entity) {
      await db.agentRun.create({ data: entity.snapshot() });
    },
    async saveRun(entity, expectedVersion) {
      const s = entity.snapshot();
      return (
        (
          await db.agentRun.updateMany({
            where: { id: s.id, version: expectedVersion },
            data: s,
          })
        ).count === 1
      );
    },
    async listRunsDue(now) {
      return (
        await db.agentRun.findMany({
          where: { status: 'running', leaseUntil: { lte: now } },
          take: 30,
        })
      ).map((row) => new AgentRunEntity(AgentRunStateSchema.parse(row)));
    },
    async claimQueued() {
      const rows = await db.$queryRaw<
        { id: string }[]
      >`SELECT id FROM agent_runs WHERE status='queued' AND kind='chat' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`;
      const row = rows[0]
        ? await db.agentRun.findUnique({ where: { id: rows[0].id } })
        : null;
      return row ? new AgentRunEntity(AgentRunStateSchema.parse(row)) : null;
    },
    async listMessages(conversationId) {
      return (
        await db.message.findMany({
          where: { conversationId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1000,
        })
      )
        .reverse()
        .map((row) => MessageState.parse(row));
    },
    async findClientMessage(conversationId, clientMessageId) {
      const row = await db.message.findUnique({
        where: {
          conversationId_clientMessageId: { conversationId, clientMessageId },
        },
      });
      return row ? MessageState.parse(row) : null;
    },
    async insertMessage(record: MessageRecord) {
      await db.message.create({ data: record });
    },
    async listEvents(runId, after) {
      return (
        await db.runEvent.findMany({
          where: { runId, sequence: { gt: after } },
          orderBy: { sequence: 'asc' },
          take: 1000,
        })
      ).map(event);
    },
    async getEvent(runId, sequence) {
      const row = await db.runEvent.findUnique({
        where: { runId_sequence: { runId, sequence } },
      });
      return row ? { hash: row.hash, event: event(row) } : null;
    },
    async insertEvent(runId, sequence, payload, hash, createdAt) {
      await db.runEvent.create({
        data: { runId, sequence, payload, hash, createdAt },
      });
    },
    async registerDispatch(runId, now) {
      await db.taskOutbox.create({
        data: {
          id: runId,
          kind: 'agent.dispatch',
          status: 'queued',
          resourceReference: runId,
          eventKey: `agent.dispatch:${runId}`,
          availableAt: now,
          updatedAt: now,
        },
      });
    },
    async markDispatchCompleted(runId, now) {
      await db.taskOutbox.updateMany({
        where: { id: runId, kind: 'agent.dispatch' },
        data: { status: 'succeeded', updatedAt: now },
      });
    },
    async getUserEpoch(userId) {
      return db.user.findUnique({
        where: { id: userId },
        select: { authEpoch: true, personalDataEpoch: true, deletedAt: true },
      });
    },
    async consumeTool(runId) {
      return (
        (
          await db.agentRun.updateMany({
            where: {
              id: runId,
              status: 'running',
              toolCalls: { lt: EXECUTION_POLICY.maxToolCalls },
            },
            data: { toolCalls: { increment: 1 } },
          })
        ).count === 1
      );
    },
  };
}
