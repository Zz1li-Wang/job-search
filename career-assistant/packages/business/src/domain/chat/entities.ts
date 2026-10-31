import { EXECUTION_POLICY } from '@career/contracts';
import { z } from 'zod';
import { BusinessError } from '../shared/errors.js';
export const ConversationStateSchema = z.object({
  id: z.uuid().describe('会话'),
  userId: z.uuid().describe('所有者'),
  title: z.string().min(1).max(100).describe('标题'),
  createdAt: z.date().describe('建立时间'),
  deletedAt: z.date().nullable().describe('删除屏障'),
  activeRunId: z.uuid().nullable().describe('本会话唯一活跃运行'),
});
export type ConversationState = z.infer<typeof ConversationStateSchema>;
export class ConversationEntity {
  private readonly state: ConversationState;
  constructor(state: ConversationState) {
    this.state = structuredClone(ConversationStateSchema.parse(state));
  }
  snapshot() {
    return structuredClone(this.state);
  }
  assertOwned(userId: string) {
    if (this.state.userId !== userId || this.state.deletedAt)
      throw new BusinessError('NOT_FOUND');
  }
  begin(runId: string): ConversationEntity {
    if (this.state.activeRunId) throw new BusinessError('CONVERSATION_BUSY');
    return new ConversationEntity({ ...this.state, activeRunId: runId });
  }
  release(runId: string): ConversationEntity {
    return new ConversationEntity({
      ...this.state,
      activeRunId:
        this.state.activeRunId === runId ? null : this.state.activeRunId,
    });
  }
  remove(now: Date): ConversationEntity {
    return new ConversationEntity({
      ...this.state,
      deletedAt: now,
      activeRunId: null,
    });
  }
}
export const AgentRunStateSchema = z.object({
  id: z.uuid().describe('运行'),
  userId: z.uuid().describe('所有者'),
  conversationId: z.uuid().nullable().describe('聊天会话，文件解析运行为空'),
  kind: z.enum(['chat', 'resume']).describe('聊天或简历提取'),
  resourceId: z.uuid().nullable().describe('提取运行限定的简历'),
  status: z
    .enum([
      'queued',
      'running',
      'completed',
      'failed',
      'interrupted',
      'cancelled',
    ])
    .describe('运行生命周期'),
  attempt: z.number().int().positive().describe('执行尝试'),
  version: z.number().int().positive().describe('版本'),
  lastSequence: z.number().int().nonnegative().describe('已提交序号'),
  errorCode: z.string().nullable().describe('安全错误'),
  authEpoch: z.number().int().nonnegative().describe('发起认证版本'),
  personalDataEpoch: z
    .number()
    .int()
    .nonnegative()
    .describe('发起个人资料版本'),
  createdAt: z.date().describe('登记时间'),
  updatedAt: z.date().describe('变化时间'),
  leaseUntil: z.date().nullable().describe('派发租约'),
  parentRunId: z.uuid().nullable().describe('显式重试原运行'),
});
export type AgentRunState = z.infer<typeof AgentRunStateSchema>;
export class AgentRunEntity {
  private readonly state: AgentRunState;
  constructor(state: AgentRunState) {
    this.state = structuredClone(AgentRunStateSchema.parse(state));
  }
  snapshot() {
    return structuredClone(this.state);
  }
  assertWritable(authEpoch: number, personalDataEpoch: number, now: Date) {
    if (
      this.state.status !== 'running' ||
      this.state.authEpoch !== authEpoch ||
      this.state.personalDataEpoch !== personalDataEpoch ||
      !this.state.leaseUntil ||
      this.state.leaseUntil <= now
    )
      throw new BusinessError('TOOL_UNAUTHORIZED');
  }
  start(now: Date): AgentRunEntity {
    if (this.state.status !== 'queued')
      throw new BusinessError('INVALID_TRANSITION');
    return new AgentRunEntity({
      ...this.state,
      status: 'running',
      version: this.state.version + 1,
      updatedAt: now,
      leaseUntil: new Date(now.getTime() + EXECUTION_POLICY.runLeaseMs),
    });
  }
  append(
    sequence: number,
    terminal: 'completed' | 'failed' | null,
    now: Date,
    errorCode: string | null = null,
  ): AgentRunEntity {
    if (
      sequence !== this.state.lastSequence + 1 ||
      this.state.status !== 'running'
    )
      throw new BusinessError('VERSION_CONFLICT');
    return new AgentRunEntity({
      ...this.state,
      lastSequence: sequence,
      status: terminal ?? this.state.status,
      version: this.state.version + 1,
      updatedAt: now,
      errorCode,
    });
  }
  cancel(now: Date): AgentRunEntity {
    if (
      ['completed', 'failed', 'interrupted', 'cancelled'].includes(
        this.state.status,
      )
    )
      return this;
    return new AgentRunEntity({
      ...this.state,
      status: 'cancelled',
      version: this.state.version + 1,
      updatedAt: now,
      leaseUntil: null,
    });
  }
  interrupt(now: Date): AgentRunEntity {
    if (this.state.status !== 'running') return this;
    return new AgentRunEntity({
      ...this.state,
      status: 'interrupted',
      version: this.state.version + 1,
      errorCode: 'MODEL_INTERRUPTED',
      leaseUntil: null,
      updatedAt: now,
    });
  }
  assertRetry(version: number) {
    if (
      this.state.version !== version ||
      !['failed', 'interrupted'].includes(this.state.status)
    )
      throw new BusinessError('VERSION_CONFLICT');
  }
}
