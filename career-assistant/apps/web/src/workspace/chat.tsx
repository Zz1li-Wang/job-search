import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import {
  ConversationSchema,
  MessageSchema,
  RunSchema,
  type ConversationDto,
  type MessageDto,
  type RunDto,
  RunEventSchema,
  JobCardSchema,
  EligibilitySchema,
  EXECUTION_POLICY,
  type EligibilityDto,
} from '@career/contracts';
import { WorkspaceGate, WorkspaceNav, ErrorNotice } from './shared.js';
import { workspaceRequest, VoidResponse } from './api.js';
import { useAuth } from '../auth/context.js';
import { ResumePanel } from './resumes.js';
function runFailureMessage(code: string): string {
  const messages: Record<string, string> = {
    TOOL_BUDGET_EXHAUSTED: `本轮查询已达到${EXECUTION_POLICY.maxToolCalls}次工具调用上限，回答未完成。请缩小岗位范围或拆分问题后重新提问。`,
    MODEL_CONTEXT_EXCEEDED:
      '本轮对话和查询资料过长，回答未完成。请新建咨询或缩小问题范围。',
    MODEL_UNAVAILABLE: '模型服务暂不可用，请稍后重试。',
    MODEL_INTERRUPTED: '模型回答中断，结果可能不完整，请确认后重试。',
    MODEL_OUTPUT_INVALID: '模型返回的内容未通过校验，请调整问题后重试。',
    TOOL_UNAUTHORIZED: '本轮工具授权已失效，请刷新页面并重新提问。',
    INVALID_EVIDENCE: '回答中的引用未通过核验，请缩小岗位范围后重新提问。',
  };
  return (
    messages[code] ?? '本轮回答未完成，请稍后重试；持续失败时请联系维护人员。'
  );
}
export function ChatPage() {
  const [params, setParams] = useSearchParams();
  const isResumesOpen = params.get('resumes') === 'open';
  function toggleResumes() {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (isResumesOpen) next.delete('resumes');
        else next.set('resumes', 'open');
        return next;
      },
      { replace: true },
    );
  }
  const { user } = useAuth(),
    [conversations, setConversations] = useState<ConversationDto[]>([]),
    [selected, setSelected] = useState(''),
    [messages, setMessages] = useState<MessageDto[]>([]),
    [text, setText] = useState(''),
    [run, setRun] = useState<RunDto | null>(null),
    [partial, setPartial] = useState(''),
    [error, setError] = useState(''),
    [isSending, setSending] = useState(false),
    [cards, setCards] = useState<ReturnType<typeof JobCardSchema.parse>[]>([]);
  const csrf = user?.csrfToken;
  const load = async () =>
    setConversations(
      await workspaceRequest('/conversations', ConversationSchema.array()),
    );
  useEffect(() => {
    if (user) void load().catch(() => setError('无法载入会话'));
  }, [user]);
  useEffect(() => {
    setPartial('');
    if (!selected) return;
    void workspaceRequest(
      `/conversations/${selected}/messages`,
      MessageSchema.array(),
    )
      .then(setMessages)
      .catch(() => setError('无法载入消息'));
    const active = conversations.find((c) => c.id === selected)?.activeRunId;
    if (active)
      void workspaceRequest(`/runs/${active}`, RunSchema).then(setRun);
    else
      void workspaceRequest(
        `/conversations/${selected}/messages`,
        MessageSchema.array(),
      ).then(async (entries) => {
        const id = entries.at(-1)?.runId;
        setRun(id ? await workspaceRequest(`/runs/${id}`, RunSchema) : null);
      });
  }, [selected, conversations]);
  useEffect(() => {
    if (!run) return;
    setCards([]);
    const accept = (event: unknown) => {
      const parsed = RunEventSchema.safeParse(event);
      if (parsed.success && parsed.data.payload.type === 'job_cards') {
        const incoming = parsed.data.payload.cards;
        setCards((previous) => [
          ...previous.filter(
            (card) => !incoming.some((next) => next.checkId === card.checkId),
          ),
          ...incoming,
        ]);
      }
    };
    if (!['running', 'queued'].includes(run.status)) {
      void fetch(`/api/v1/runs/${run.id}/events`)
        .then((response) => response.text())
        .then((text) => {
          for (const line of text.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                accept(JSON.parse(line.slice(6)));
              } catch {
                /* 非业务事件不进入卡片。 */
              }
            }
          }
        });
      return;
    }

    const source = new EventSource(
      `/api/v1/runs/${run.id}/events?after=${run.lastSequence}`,
    );
    const delta = (event: MessageEvent) => {
      const parsed = RunEventSchema.safeParse(JSON.parse(event.data));
      if (parsed.success && parsed.data.payload.type === 'text_delta') {
        const delta = parsed.data.payload.text;
        setPartial((value) => value + delta);
      }
    };
    source.addEventListener('text_delta', delta as EventListener);
    source.addEventListener('job_cards', (event) => {
      try {
        accept(JSON.parse((event as MessageEvent).data));
      } catch {
        /* 契约不符不渲染资格结论。 */
      }
    });
    const terminal = () => {
      source.close();
      void workspaceRequest(`/runs/${run.id}`, RunSchema).then(setRun);
      if (selected)
        void workspaceRequest(
          `/conversations/${selected}/messages`,
          MessageSchema.array(),
        ).then((value) => {
          setMessages(value);
          setPartial('');
        });
    };
    source.addEventListener('completed', terminal);
    source.addEventListener('failed', terminal);
    source.onerror = () => {
      void workspaceRequest(`/runs/${run.id}`, RunSchema)
        .then((value) => {
          if (!['running', 'queued'].includes(value.status)) terminal();
        })
        .catch(() => {
          setError('连接已中断，请刷新检查运行状态');
          source.close();
        });
    };
    return () => source.close();
  }, [run?.id, run?.status, selected]);
  async function create() {
    try {
      const c = await workspaceRequest('/conversations', ConversationSchema, {
        method: 'POST',
        key: crypto.randomUUID(),
        body: {},
        ...(csrf ? { csrf } : {}),
      });
      await load();
      setSelected(c.id);
    } catch {
      setError('创建会话失败');
    }
  }
  async function send() {
    if (!selected || !text.trim()) return;
    setSending(true);
    setError('');
    try {
      const response = await workspaceRequest(
        `/conversations/${selected}/messages`,
        RunSchema,
        {
          method: 'POST',
          body: { clientMessageId: crypto.randomUUID(), text },
          ...(csrf ? { csrf } : {}),
        },
      );
      setText('');
      setPartial('');
      setMessages(
        await workspaceRequest(
          `/conversations/${selected}/messages`,
          MessageSchema.array(),
        ),
      );
      setRun(response);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '发送失败');
    } finally {
      setSending(false);
    }
  }
  const busy = !!run && ['queued', 'running'].includes(run.status);
  return (
    <>
      <WorkspaceNav />
      <h1>求职咨询</h1>
      <WorkspaceGate>
        <p>
          可讨论求职方向、岗位、简历和面试。假设讨论不会修改正式画像，岗位资格以核验卡片及原文为准。
        </p>
        <ErrorNotice message={error} />
        <div className="chat-layout">
          <aside>
            <button onClick={() => void create()}>新建咨询</button>
            {conversations.map((c) => (
              <button
                key={c.id}
                aria-pressed={selected === c.id}
                onClick={() => setSelected(c.id)}
              >
                {c.title}
              </button>
            ))}
          </aside>
          <section aria-label="对话">
            <div className="messages" aria-live="polite">
              {messages.map((m) => (
                <article key={m.id} className={m.role}>
                  <strong>{m.role === 'user' ? '我' : '求职助手'}</strong>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{m.text}</p>
                  {m.citations.map((c) => (
                    <a
                      key={c.observationId}
                      href={c.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      查看原文依据
                    </a>
                  ))}
                </article>
              ))}
              {partial && (
                <article>
                  <strong>正在回答</strong>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{partial}</p>
                </article>
              )}
            </div>
            {run && (
              <p role="status">
                运行状态：
                {
                  (
                    {
                      queued: '排队中',
                      running: '回答中',
                      completed: '已完成',
                      failed: '回答失败',
                      interrupted: '执行中断，结果未知',
                      cancelled: '已取消',
                    } as Record<string, string>
                  )[run.status]
                }
                {run.errorCode ? `：${runFailureMessage(run.errorCode)}` : ''}
              </p>
            )}
            {cards.map((card) => (
              <QualificationCard key={card.checkId ?? card.jobId} card={card} />
            ))}
            <div className="consultation-tools">
              <button
                type="button"
                aria-expanded={isResumesOpen}
                aria-controls="consultation-resumes"
                onClick={toggleResumes}
              >
                {isResumesOpen ? '收起简历' : '上传简历 / 管理简历'}
              </button>
              <p>可以直接提问，也可以上传简历，核对确认画像后继续咨询。</p>
            </div>
            <section
              id="consultation-resumes"
              className="consultation-resumes"
              aria-label="简历资料"
              hidden={!isResumesOpen}
            >
              {isResumesOpen && <ResumePanel />}
            </section>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label>
                你的求职问题
                <textarea
                  maxLength={4000}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  disabled={!selected || busy}
                />
              </label>
              <button disabled={!selected || busy || isSending || !text.trim()}>
                发送
              </button>
            </form>
            {busy && (
              <button
                onClick={() =>
                  void workspaceRequest(`/runs/${run!.id}/cancel`, RunSchema, {
                    method: 'POST',
                    body: {},
                    ...(csrf ? { csrf } : {}),
                  }).then(setRun)
                }
              >
                取消回答
              </button>
            )}
            {run && ['failed', 'interrupted'].includes(run.status) && (
              <button
                onClick={() =>
                  void workspaceRequest(`/runs/${run.id}/retry`, RunSchema, {
                    method: 'POST',
                    body: { expectedRunVersion: run.version },
                    ...(csrf ? { csrf } : {}),
                  })
                    .then((value) => {
                      setPartial('');
                      setRun(value);
                    })
                    .catch(() => setError('重试失败，请刷新'))
                }
              >
                重新调用模型（可能计费）
              </button>
            )}
            {selected && (
              <button
                disabled={busy}
                onClick={() =>
                  void workspaceRequest(
                    `/conversations/${selected}`,
                    VoidResponse,
                    { method: 'DELETE', ...(csrf ? { csrf } : {}) },
                  ).then(() => {
                    setSelected('');
                    setMessages([]);
                    return load();
                  })
                }
              >
                删除会话
              </button>
            )}
          </section>
        </div>
      </WorkspaceGate>
    </>
  );
}

function QualificationCard({
  card,
}: {
  card: ReturnType<typeof JobCardSchema.parse>;
}) {
  const [check, setCheck] = useState<EligibilityDto | null>(null);
  useEffect(() => {
    if (card.checkId)
      void workspaceRequest(
        `/eligibility-checks/${card.checkId}`,
        EligibilitySchema,
      )
        .then(setCheck)
        .catch(() => setCheck(null));
  }, [card.checkId]);
  const status = check?.isCurrent ? check.status : 'pending';
  return (
    <article aria-label="后端岗位资格">
      <strong>岗位资格（后端核验）</strong>
      <p>
        {
          (
            {
              eligible: '符合已核验条件',
              not_eligible: '不符合已核验条件',
              pending: '待核验',
            } as const
          )[status]
        }
      </p>
      <Link to={`/jobs/${card.jobId}`}>查看岗位、原文与条件详情</Link>
      {check?.invalidatedReasons.map((reason) => (
        <p key={reason}>{reason}</p>
      ))}
    </article>
  );
}
