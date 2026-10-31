import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ResumeSchema,
  ResumeContentSchema,
  type ResumeDto,
} from '@career/contracts';
import { useAuth } from '../auth/context.js';
import { ErrorNotice } from './shared.js';
import { workspaceRequest } from './api.js';

const RESUME_STATUS_LABEL: Readonly<Record<ResumeDto['status'], string>> = {
  queued: '等待解析',
  extracting: '提取文字',
  structuring: '生成画像草稿',
  ready: '画像草稿已生成',
  failed: '解析失败',
};
const RESUME_ERROR_LABEL: Readonly<Record<string, string>> = {
  FILE_INVALID: '文件格式或编码无效',
  FILE_NO_TEXT: '没有可提取文字，暂不支持扫描件',
  FILE_ENCRYPTED: '文件已加密，请先解密',
  FILE_TOO_LARGE: '文件超过解析限额',
  INVALID_EVIDENCE: '模型字段依据未通过校验，请手动核对资料',
  MODEL_INTERRUPTED: '模型结果未知，可明确选择重新解析',
  MODEL_UNAVAILABLE: '模型服务暂不可用',
  MODEL_OUTPUT_INVALID: '模型返回的资料格式无效，请重新解析或手动核对画像',
  MODEL_CONTEXT_EXCEEDED: '资料和上下文过长，请精简简历文字后重新解析',
  TOOL_UNAUTHORIZED: '原任务授权已失效，请重新发起解析',
};
export function ResumePanel() {
  const { user } = useAuth(),
    [resumes, setResumes] = useState<ResumeDto[]>([]),
    [title, setTitle] = useState('我的简历'),
    [text, setText] = useState(''),
    [file, setFile] = useState<File | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [source, setSource] = useState(''),
    [busy, setBusy] = useState(false);
  const csrf = user?.csrfToken;
  async function load() {
    setResumes(await workspaceRequest('/resumes', ResumeSchema.array()));
  }
  useEffect(() => {
    if (!user) return;
    void load().catch(() => setError('无法载入简历'));
    const timer = setInterval(() => void load().catch(() => {}), 1500);
    return () => clearInterval(timer);
  }, [user]);
  async function submit(isFile: boolean) {
    setBusy(true);
    setError('');
    try {
      if (isFile) {
        if (!file) throw Error('请先选择文件');
        const body = new FormData();
        body.set('file', file);
        body.set('title', title);
        const response = await fetch('/api/v1/resumes', {
          method: 'POST',
          body,
          headers: {
            'x-csrf-token': csrf ?? '',
            'idempotency-key': crypto.randomUUID(),
          },
        });
        if (!response.ok) throw Error('上传失败，请检查文件格式和大小');
        ResumeSchema.parse((await response.json()).payload);
      } else
        await workspaceRequest('/resumes/text', ResumeSchema, {
          method: 'POST',
          body: { title, text },
          ...(csrf ? { csrf } : {}),
          key: crypto.randomUUID(),
        });
      setNotice('资料已保存或复用，请核对解析状态并确认画像草稿');
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '提交失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h2>简历资料</h2>
      <p>
        支持文本 PDF、DOCX 和 UTF-8
        TXT，最大10MiB、PDF最多30页。不支持扫描件识字。解析将调用已配置模型；结果需要你确认。
      </p>
      <ErrorNotice message={error} />
      {notice && <p role="status">{notice}</p>}
      <label>
        资料标题
        <input
          maxLength={100}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        选择简历文件
        <input
          type="file"
          accept=".pdf,.docx,.txt"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <button disabled={busy || !file} onClick={() => void submit(true)}>
        上传并解析
      </button>
      <label>
        粘贴简历文本
        <textarea
          maxLength={50000}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <button
        disabled={busy || !text.trim()}
        onClick={() => void submit(false)}
      >
        提交文本并解析
      </button>
      <ul className="cards">
        {resumes.map((r) => (
          <li key={r.id}>
            <h3>{r.title}</h3>
            <p>
              解析状态：{RESUME_STATUS_LABEL[r.status]}
              {r.errorCode
                ? ` · ${RESUME_ERROR_LABEL[r.errorCode] ?? '请检查文件或手动填写画像'}`
                : ''}
            </p>
            {r.draftId && (
              <Link to={`/profile?draft=${r.draftId}`}>核对画像草稿</Link>
            )}
            <button
              onClick={() =>
                void workspaceRequest(
                  `/resumes/${r.id}/content`,
                  ResumeContentSchema,
                )
                  .then((content) =>
                    setSource(
                      content.spans
                        .map((s) => `${s.locator}\n${s.text}`)
                        .join('\n'),
                    ),
                  )
                  .catch(() => setError('原文尚未提取或已不可用'))
              }
            >
              查看提取原文
            </button>
            {r.status === 'failed' && (
              <button
                onClick={() =>
                  void workspaceRequest(
                    `/resumes/${r.id}/parse`,
                    ResumeSchema,
                    {
                      method: 'POST',
                      body: {
                        expectedResumeVersion: r.version,
                        retry: true,
                        expectedTaskId: r.taskId,
                      },
                      ...(csrf ? { csrf } : {}),
                    },
                  )
                    .then(load)
                    .catch(() => setError('重试失败'))
                }
              >
                重新解析（可能计费）
              </button>
            )}
            <button
              onClick={() => {
                if (
                  !window.confirm(
                    '删除这份简历？已确认画像中的事实仍会保留；可在隐私设置另行清空。',
                  )
                )
                  return;
                void fetch(`/api/v1/resumes/${r.id}`, {
                  method: 'DELETE',
                  headers: { 'x-csrf-token': csrf ?? '' },
                })
                  .then((response) => {
                    if (!response.ok) throw Error();
                    setNotice('已撤销资料访问，原始文件等待后台清理');
                    setSource('');
                    return load();
                  })
                  .catch(() => setError('删除失败'));
              }}
            >
              删除简历
            </button>
          </li>
        ))}
      </ul>
      {!resumes.length && <p>还没有简历，也可以直接在我的画像中手动填写。</p>}
      {source && (
        <details open>
          <summary>提取原文</summary>
          <pre className="source-text">{source}</pre>
        </details>
      )}
    </>
  );
}
