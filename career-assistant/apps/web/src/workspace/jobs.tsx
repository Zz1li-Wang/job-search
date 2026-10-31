import { FavoriteButton } from './career.js';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  JobPageSchema,
  JobDetailSchema,
  EvidenceBundleSchema,
  ProfileSchema,
  EligibilitySchema,
  TaskSchema,
  type JobSummaryDto,
  type JobDetailDto,
  type EvidenceBundleDto,
  type EligibilityDto,
  type TaskDto,
} from '@career/contracts';
import { useAuth } from '../auth/context.js';
import { workspaceRequest } from './api.js';
import { WorkspaceGate, WorkspaceNav, ErrorNotice } from './shared.js';
const typeLabel = { campus: '校招', social: '社招', unknown: '类型待核验' };
export function JobsPage() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<JobSummaryDto[]>([]),
    [next, setNext] = useState<string | null>(null),
    [keyword, setKeyword] = useState(''),
    [city, setCity] = useState(''),
    [type, setType] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function load(cursor?: string) {
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (keyword.trim()) params.set('keyword', keyword.trim());
      if (city.trim()) params.set('city', city.trim());
      if (type) params.set('recruitmentType', type);
      if (cursor) params.set('cursor', cursor);
      const page = await workspaceRequest('/jobs?' + params, JobPageSchema);
      setEntries(page.entries);
      setNext(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : '岗位加载失败');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (user) void load();
  }, [user]);
  function submit(event: FormEvent) {
    event.preventDefault();
    void load();
  }
  return (
    <WorkspaceGate>
      <WorkspaceNav />
      <h1>岗位探索</h1>
      <p>按最近收录排序。校招与社招都可探索，是否符合取决于具体条件。</p>
      <form onSubmit={submit}>
        <label>
          关键词
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            maxLength={100}
          />
        </label>
        <label>
          城市
          <input
            value={city}
            onChange={(e) => setCity(e.target.value)}
            maxLength={100}
          />
        </label>
        <label>
          招聘类型
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">不限</option>
            <option value="campus">校招</option>
            <option value="social">社招</option>
            <option value="unknown">待核验</option>
          </select>
        </label>
        <button disabled={busy}>查询岗位</button>
      </form>
      <ErrorNotice message={error} />
      {busy ? (
        <p role="status">正在读取岗位…</p>
      ) : !entries.length && !error ? (
        <p>暂无已收录岗位。不会用虚构数据填充列表。</p>
      ) : (
        <ul className="cards">
          {entries.map((job) => (
            <li key={job.id}>
              <h2>
                <Link to={'/jobs/' + job.id}>{job.title}</Link>
              </h2>
              <p>
                {job.company ?? '单位待核验'} ·{' '}
                {job.cities.join('、') || '地点未明确'} ·{' '}
                {typeLabel[job.recruitmentType]}
              </p>
              <p>
                {job.freshness === 'closed'
                  ? '已收录版本已截止'
                  : job.reviewState === 'pending'
                    ? '条件待核验'
                    : '条件已核验'}{' '}
                · 获取时间{' '}
                {job.lastFetchedAt
                  ? new Date(job.lastFetchedAt).toLocaleString()
                  : '未知'}
              </p>
            </li>
          ))}
        </ul>
      )}
      {next && (
        <button disabled={busy} onClick={() => void load(next)}>
          下一页
        </button>
      )}
    </WorkspaceGate>
  );
}
export function JobDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const [job, setJob] = useState<JobDetailDto | null>(null),
    [evidence, setEvidence] = useState<EvidenceBundleDto | null>(null),
    [check, setCheck] = useState<EligibilityDto | null>(null),
    [task, setTask] = useState<TaskDto | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function load() {
    if (!id) return;
    try {
      const detail = await workspaceRequest('/jobs/' + id, JobDetailSchema);
      setJob(detail);
      setEvidence(
        await workspaceRequest(
          '/jobs/' + id + '/evidence?expectedJobVersion=' + detail.jobVersionId,
          EvidenceBundleSchema,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取岗位失败');
    }
  }
  useEffect(() => {
    if (user) void load();
  }, [id, user]);
  useEffect(() => {
    if (!task || !['queued', 'running', 'retry_wait'].includes(task.status))
      return;
    let live = true;
    let polls = 0;
    const timer = setInterval(() => {
      if (++polls > 30) {
        clearInterval(timer);
        return;
      }
      void workspaceRequest('/tasks/' + task.id, TaskSchema)
        .then((result) => {
          if (!live) return;
          setTask(result);
          if (result.status === 'succeeded') void load();
        })
        .catch((e) => {
          if (live)
            setError(e instanceof Error ? e.message : '读取刷新状态失败');
        });
    }, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [task?.id, task?.status]);
  async function evaluate() {
    if (!user || !job) return;
    setBusy(true);
    setError('');
    try {
      const profile = await workspaceRequest('/profile', ProfileSchema);
      setCheck(
        await workspaceRequest('/eligibility-checks', EligibilitySchema, {
          method: 'POST',
          csrf: user.csrfToken,
          key: crypto.randomUUID(),
          body: {
            jobId: job.id,
            expectedJobVersion: job.jobVersionId,
            expectedProfileVersion: profile.version,
            expectedReviewVersion: job.reviewVersion,
            expectedEvidenceDependencyHash: job.evidenceDependencyHash,
          },
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '核验失败，请重载岗位');
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    if (!user || !job) return;
    setError('');
    try {
      setTask(
        await workspaceRequest('/jobs/' + job.id + '/refresh', TaskSchema, {
          method: 'POST',
          csrf: user.csrfToken,
          key: crypto.randomUUID(),
          body: {},
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '刷新登记失败');
    }
  }
  return (
    <WorkspaceGate>
      <WorkspaceNav />
      <ErrorNotice message={error} />
      {job ? (
        <>
          <h1>{job.title}</h1>
          <FavoriteButton jobId={job.id} />
          <p>
            {job.company ?? '单位待核验'} · {typeLabel[job.recruitmentType]}
          </p>
          <p>
            报名截止：{job.deadline.value ?? '未明确'}；
            {job.freshness === 'closed'
              ? '已收录版本已截止'
              : job.freshness === 'pending'
                ? '资料需核验'
                : '证据在有效期内'}
          </p>
          <button disabled={busy} onClick={() => void evaluate()}>
            {busy ? '核验中…' : '核验条件'}
          </button>
          <button onClick={() => void refresh()}>请求刷新来源</button>
          {task && (
            <p role="status">
              刷新任务：{task.status}
              {task.errorCode ? ' · ' + task.errorCode : ''}
            </p>
          )}
          {check && (
            <section aria-label="资格核验结果">
              <h2>
                {check.status === 'eligible'
                  ? '符合已核验条件'
                  : check.status === 'not_eligible'
                    ? '不符合已核验条件'
                    : '待核验'}
              </h2>
              {!check.isCurrent && (
                <p>当前资料不完整或结果已失效，请补齐后重新核验。</p>
              )}
              {check.warnings.map((warning, i) => (
                <p key={i}>{warning}</p>
              ))}
              <ul>
                {check.checks.map((entry, i) => (
                  <li key={i}>
                    {entry.field}：
                    {entry.decision === 'true'
                      ? '满足'
                      : entry.decision === 'false'
                        ? '不满足'
                        : '待确认'}
                    ，{entry.reason}
                    {entry.missingFields.length
                      ? '；需补齐：' + entry.missingFields.join('、')
                      : ''}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h2>已收录原文</h2>
            {job.blocks.map((text, i) => (
              <p key={i}>{text}</p>
            ))}
          </section>
          <section>
            <h2>来源与证据</h2>
            {evidence?.entries.map((entry) => (
              <article key={entry.resourceId}>
                <a
                  href={entry.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  查看来源原文
                </a>
                <p>成功获取：{new Date(entry.fetchedAt).toLocaleString()}</p>
                <details>
                  <summary>核对已保存正文</summary>
                  {entry.blocks.map((text, i) => (
                    <p key={i}>{text}</p>
                  ))}
                </details>
              </article>
            ))}
            {evidence?.unvisitedUrls.map((url) => (
              <p key={url}>
                <a href={url} target="_blank" rel="noopener noreferrer">
                  未访问的原文入口
                </a>
                （尚不能作为完整核验依据）
              </p>
            ))}
          </section>
        </>
      ) : (
        !error && <p role="status">正在读取岗位…</p>
      )}
    </WorkspaceGate>
  );
}
