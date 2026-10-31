import { EXECUTION_POLICY } from '@career/contracts';
import type { TransactionContext } from '../ports.js';
import { validateRunEvidence } from './evidence.js';
import {
  RunSchema,
  ConversationSchema,
  MessageSchema,
  type ActorDto,
  type MessageInputDto,
  type RunEventInputDto,
} from '@career/contracts';
import {
  ConversationEntity,
  AgentRunEntity,
} from '../../domain/chat/entities.js';
import { BusinessError } from '../../domain/shared/errors.js';
import {
  assertActor,
  originalReference,
  remember,
} from '../ingestion/support.js';
import { businessOperation } from '../business-operation.js';
import type { ChatDependencies, ChatRepository } from './ports.js';
import {
  verifyRunGrant,
  signRunGrant,
  assertGrantRun,
  ToolAuthorizationService,
} from './grants.js';
const conversationDto = (entity: ConversationEntity) => {
  const s = entity.snapshot();
  return ConversationSchema.parse({
    id: s.id,
    title: s.title,
    createdAt: s.createdAt.toISOString(),
    activeRunId: s.activeRunId,
  });
};
export function runDto(run: AgentRunEntity) {
  const s = run.snapshot();
  return RunSchema.parse({
    id: s.id,
    conversationId: s.conversationId,
    status: s.status,
    attempt: s.attempt,
    version: s.version,
    lastSequence: s.lastSequence,
    errorCode: s.errorCode,
  });
}
async function owned(repo: ChatRepository, id: string, actor: ActorDto) {
  const entity = await repo.getConversation(id, actor.userId, true);
  if (!entity) throw new BusinessError('NOT_FOUND');
  entity.assertOwned(actor.userId);
  return entity;
}
async function runOwned(repo: ChatRepository, id: string, actor: ActorDto) {
  const run = await repo.getRun(id);
  if (
    !run ||
    run.snapshot().userId !== actor.userId ||
    !run.snapshot().conversationId
  )
    throw new BusinessError('NOT_FOUND');
  await owned(repo, run.snapshot().conversationId!, actor);
  return run;
}
export class ChatService {
  constructor(private readonly d: ChatDependencies) {}
  private execute<T>(
    actor: ActorDto,
    action: (repo: ChatRepository, c: TransactionContext) => Promise<T>,
  ) {
    return businessOperation(() =>
      this.d.unitOfWork.run(async (c) => {
        await assertActor(this.d.source(c), actor);
        return action(this.d.repositories(c), c);
      }),
    );
  }
  async create(title: string | undefined, actor: ActorDto, key?: string) {
    return this.execute(actor, async (repo, c) => {
      const operationKey = key ?? this.d.id(),
        scope = `chat-create:${actor.userId}`,
        hash = this.d.digest(JSON.stringify({ title: title ?? null })),
        source = this.d.source(c),
        previous = await originalReference(source, scope, operationKey, hash);
      if (previous) return conversationDto(await owned(repo, previous, actor));
      const entity = new ConversationEntity({
        id: this.d.id(),
        userId: actor.userId,
        title: title ?? '求职咨询',
        createdAt: this.d.now(),
        deletedAt: null,
        activeRunId: null,
      });
      await repo.insertConversation(entity);
      await remember(
        source,
        scope,
        operationKey,
        hash,
        entity.snapshot().id,
        this.d.now(),
      );
      return conversationDto(entity);
    });
  }
  async list(actor: ActorDto) {
    return this.execute(actor, async (repo) =>
      (await repo.listConversations(actor.userId)).map(conversationDto),
    );
  }
  async messages(id: string, actor: ActorDto) {
    return this.execute(actor, async (repo) => {
      await owned(repo, id, actor);
      return (await repo.listMessages(id)).map((m) =>
        MessageSchema.parse({
          id: m.id,
          conversationId: m.conversationId,
          role: m.role,
          text: m.text,
          runId: m.runId,
          status: m.status,
          citations: m.citations,
          createdAt: m.createdAt.toISOString(),
        }),
      );
    });
  }
  async remove(id: string, actor: ActorDto) {
    const runId = await this.execute(actor, async (repo) => {
      const conv = await repo.getConversation(id, actor.userId, true);
      if (!conv) return null;
      const active = conv.snapshot().activeRunId;
      if (active) {
        const run = await repo.getRun(active);
        if (run)
          await repo.saveRun(run.cancel(this.d.now()), run.snapshot().version);
      }
      await repo.saveConversation(conv.remove(this.d.now()));
      await repo.eraseConversationContent(id);
      return active;
    });
    if (runId) await this.d.agent.cancel(runId).catch(() => {});
  }
  async send(id: string, input: MessageInputDto, actor: ActorDto) {
    return this.execute(actor, async (repo) => {
      const conv = await owned(repo, id, actor),
        hash = this.d.digest(JSON.stringify(input)),
        existing = await repo.findClientMessage(id, input.clientMessageId);
      if (existing) {
        if (existing.requestHash !== hash)
          throw new BusinessError('IDEMPOTENCY_CONFLICT');
        return runDto(await runOwned(repo, existing.runId!, actor));
      }
      const epoch = await repo.getUserEpoch(actor.userId);
      if (!epoch) throw new BusinessError('NOT_FOUND');
      const now = this.d.now(),
        run = new AgentRunEntity({
          id: this.d.id(),
          userId: actor.userId,
          conversationId: id,
          kind: 'chat',
          resourceId: null,
          status: 'queued',
          attempt: 1,
          version: 1,
          lastSequence: 0,
          errorCode: null,
          authEpoch: epoch.authEpoch,
          personalDataEpoch: epoch.personalDataEpoch,
          createdAt: now,
          updatedAt: now,
          leaseUntil: null,
          parentRunId: null,
        });
      const begun = conv.begin(run.snapshot().id);
      await repo.insertRun(run);
      await repo.insertMessage({
        id: this.d.id(),
        conversationId: id,
        clientMessageId: input.clientMessageId,
        requestHash: hash,
        role: 'user',
        text: input.text + (input.jobId ? `\n关联岗位ID：${input.jobId}` : ''),
        runId: run.snapshot().id,
        status: 'submitted',
        citations: [],
        createdAt: now,
      });
      await repo.saveConversation(begun);
      await repo.registerDispatch(run.snapshot().id, now);
      return runDto(run);
    });
  }
  async getRun(id: string, actor: ActorDto) {
    return this.execute(actor, async (repo) =>
      runDto(await runOwned(repo, id, actor)),
    );
  }
  async events(id: string, after: number, actor: ActorDto) {
    return this.execute(actor, async (repo) => {
      await runOwned(repo, id, actor);
      return repo.listEvents(id, after);
    });
  }
  async cancel(id: string, actor: ActorDto) {
    const value = await this.execute(actor, async (repo) => {
      const run = await runOwned(repo, id, actor),
        s = run.snapshot(),
        next = run.cancel(this.d.now());
      if (next !== run) {
        await repo.saveRun(next, s.version);
        const conv = await owned(repo, s.conversationId!, actor);
        await repo.saveConversation(conv.release(id));
      }
      return runDto(next);
    });
    await this.d.agent.cancel(id).catch(() => {});
    return value;
  }
  async retry(id: string, version: number, actor: ActorDto) {
    return this.execute(actor, async (repo, c) => {
      const previous = await runOwned(repo, id, actor);
      const source = this.d.source(c),
        scope = `chat-retry:${actor.userId}`,
        hash = this.d.digest(JSON.stringify({ id, version })),
        child = await originalReference(source, scope, id, hash);
      if (child) return runDto(await runOwned(repo, child, actor));
      previous.assertRetry(version);
      const s = previous.snapshot(),
        conv = await owned(repo, s.conversationId!, actor),
        epoch = await repo.getUserEpoch(actor.userId),
        now = this.d.now();
      const run = new AgentRunEntity({
        ...s,
        id: this.d.id(),
        status: 'queued',
        attempt: s.attempt + 1,
        version: 1,
        lastSequence: 0,
        errorCode: null,
        authEpoch: epoch!.authEpoch,
        personalDataEpoch: epoch!.personalDataEpoch,
        createdAt: now,
        updatedAt: now,
        leaseUntil: null,
        parentRunId: id,
      });
      const begun = conv.begin(run.snapshot().id);
      await repo.insertRun(run);
      await repo.saveConversation(begun);
      await repo.registerDispatch(run.snapshot().id, now);
      await remember(source, scope, id, hash, run.snapshot().id, this.d.now());
      return runDto(run);
    });
  }
  /** 回调只保存已经获得运行授权的数据，重复序号必须具有相同摘要。 */
  async append(id: string, grant: string, input: RunEventInputDto) {
    const claims = verifyRunGrant(this.d, grant);
    if (claims.runId !== id) throw new BusinessError('TOOL_UNAUTHORIZED');
    return businessOperation(() =>
      this.d.unitOfWork.run(async (c) => {
        await assertActor(this.d.source(c), {
          userId: claims.userId,
          authEpoch: claims.authEpoch,
          sessionId: null,
        });
        const repo = this.d.repositories(c),
          run = await repo.getRun(id, true);
        if (!run) throw new BusinessError('NOT_FOUND');
        const hash = this.d.digest(JSON.stringify(input)),
          old = await repo.getEvent(id, input.sequence);
        if (old) {
          const user = await repo.getUserEpoch(claims.userId);
          if (
            !user ||
            user.personalDataEpoch !== claims.personalDataEpoch ||
            run.snapshot().userId !== claims.userId
          )
            throw new BusinessError('TOOL_UNAUTHORIZED');
          if (
            run.snapshot().conversationId &&
            !(await repo.getConversation(
              run.snapshot().conversationId!,
              claims.userId,
            ))
          )
            throw new BusinessError('NOT_FOUND');
          if (old.hash !== hash)
            throw new BusinessError('IDEMPOTENCY_CONFLICT');
          return old.event;
        }
        await assertGrantRun(repo, claims, this.d.now());
        const payload = await validateRunEvidence(this.d, c, input.payload, {
            userId: claims.userId,
            authEpoch: claims.authEpoch,
            sessionId: null,
          }),
          terminal =
            payload.type === 'completed'
              ? 'completed'
              : payload.type === 'failed'
                ? 'failed'
                : null,
          now = this.d.now(),
          next = run.append(
            input.sequence,
            terminal,
            now,
            payload.type === 'failed' ? payload.errorCode : null,
          );
        await repo.insertEvent(id, input.sequence, payload, hash, now);
        if (!(await repo.saveRun(next, run.snapshot().version)))
          throw new BusinessError('VERSION_CONFLICT');
        if (terminal && run.snapshot().conversationId) {
          const conv = await repo.getConversation(
            run.snapshot().conversationId!,
            claims.userId,
            true,
          );
          if (!conv) throw new BusinessError('NOT_FOUND');
          if (payload.type === 'completed')
            await repo.insertMessage({
              id: this.d.id(),
              conversationId: conv.snapshot().id,
              clientMessageId: null,
              requestHash: null,
              role: 'assistant',
              text: payload.text,
              runId: id,
              status: 'completed',
              citations: payload.citations,
              createdAt: now,
            });
          await repo.saveConversation(conv.release(id));
        }
        return (await repo.getEvent(id, input.sequence))!.event;
      }),
    );
  }
}
export class ChatDispatchService {
  constructor(private readonly d: ChatDependencies) {}
  async tick() {
    // 获取候选不会持有跨网络事务；User锁先于运行锁，避免与删除形成反向锁序。
    const candidates = await this.d.unitOfWork.run((c) =>
      this.d.repositories(c).listRunsDue(this.d.now()),
    );
    for (const candidate of candidates)
      await this.d.unitOfWork.run(async (c) => {
        const repo = this.d.repositories(c),
          s = candidate.snapshot();
        await this.d.source(c).accounts.getForUpdate(s.userId);
        const current = await repo.getRun(s.id, true);
        if (
          current?.snapshot().status === 'running' &&
          current.snapshot().leaseUntil! <= this.d.now()
        ) {
          await repo.saveRun(
            current.interrupt(this.d.now()),
            current.snapshot().version,
          );
          if (s.conversationId) {
            const conv = await repo.getConversation(
              s.conversationId,
              s.userId,
              true,
            );
            if (conv) await repo.saveConversation(conv.release(s.id));
          }
        }
      });
    const selected = await this.d.unitOfWork.run((c) =>
      this.d.repositories(c).claimQueued(this.d.now()),
    );
    if (!selected) return false;
    const input = await this.d.unitOfWork.run(async (c) => {
      const repo = this.d.repositories(c),
        s = selected.snapshot();
      const account = await this.d.source(c).accounts.getForUpdate(s.userId),
        run = await repo.getRun(s.id, true);
      if (
        !account ||
        account.snapshot().deletedAt ||
        !run ||
        run.snapshot().status !== 'queued'
      )
        return null;
      const epoch = account.snapshot();
      if (
        s.authEpoch !== epoch.authEpoch ||
        s.personalDataEpoch !== epoch.personalDataEpoch
      ) {
        await repo.saveRun(run.cancel(this.d.now()), run.snapshot().version);
        const conversation = s.conversationId
          ? await repo.getConversation(s.conversationId, s.userId, true)
          : null;
        if (conversation)
          await repo.saveConversation(conversation.release(s.id));
        return null;
      }
      const started = run.start(this.d.now());
      await repo.saveRun(started, run.snapshot().version);
      const history = await repo.listMessages(s.conversationId!);
      let remainingContext = EXECUTION_POLICY.historyCharacters;
      const recent = history
        .slice(-12)
        .reverse()
        .flatMap((message) => {
          if (remainingContext <= 0) return [];
          const content = message.text.slice(
            0,
            Math.min(EXECUTION_POLICY.contextEntryCharacters, remainingContext),
          );
          remainingContext -= content.length;
          return [{ role: message.role, content }];
        })
        .reverse();
      return {
        runId: s.id,
        grant: signRunGrant(this.d, started),
        messages: [
          ...(history.length > 12
            ? [
                {
                  role: 'user' as const,
                  content:
                    '更早对话原文摘录，不能当成正式画像：\n' +
                    history
                      .slice(0, -12)
                      .slice(-20)
                      .map((m) => `${m.role}: ${m.text.slice(0, 180)}`)
                      .join('\n'),
                },
              ]
            : []),
          ...recent,
        ],
        callbackUrl: new URL(
          `/internal/v1/runs/${s.id}/events`,
          this.d.callbackBase,
        ).href,
      };
    });
    if (!input) return true;
    try {
      await this.d.agent.dispatch(input);
      await this.d.unitOfWork.run((c) =>
        this.d.repositories(c).markDispatchCompleted(input.runId, this.d.now()),
      );
    } catch {
      await this.d.unitOfWork.run(async (c) => {
        const repo = this.d.repositories(c),
          s = selected.snapshot();
        await this.d.source(c).accounts.getForUpdate(s.userId);
        const run = await repo.getRun(s.id, true);
        if (run?.snapshot().status === 'running') {
          await repo.saveRun(
            run.interrupt(this.d.now()),
            run.snapshot().version,
          );
          const conv = await repo.getConversation(
            s.conversationId!,
            s.userId,
            true,
          );
          if (conv) await repo.saveConversation(conv.release(s.id));
        }
      });
    }
    return true;
  }
}
export function createChatServices(d: ChatDependencies) {
  return {
    chat: new ChatService(d),
    dispatcher: new ChatDispatchService(d),
    authorization: new ToolAuthorizationService(d),
  };
}
