import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FavoriteSchema,
  ApplicationSchema,
  ApplicationHistorySchema,
  type ApplicationDto,
} from '@career/contracts';
import { WorkspaceGate, WorkspaceNav, ErrorNotice } from './shared.js';
import { workspaceRequest, VoidResponse } from './api.js';
import { useAuth } from '../auth/context.js';
export const APPLICATION_LABELS: Record<ApplicationDto['status'], string> = {
  preparing: '准备投递',
  submitted: '已投递',
  assessment: '笔试',
  interview: '面试',
  offered: '录用',
  rejected: '未通过',
  withdrawn: '已撤回',
};
export function FavoriteButton({ jobId }: { jobId: string }) {
  const { user } = useAuth(),
    [notice, setNotice] = useState('');
  return (
    <>
      <button
        onClick={() =>
          void workspaceRequest(`/favorites/${jobId}`, FavoriteSchema, {
            method: 'PUT',
            ...(user?.csrfToken ? { csrf: user.csrfToken } : {}),
          })
            .then(() => setNotice('已收藏'))
            .catch(() => setNotice('收藏失败，请重试'))
        }
      >
        收藏岗位
      </button>
      <button
        onClick={() =>
          void workspaceRequest('/applications', ApplicationSchema, {
            method: 'POST',
            body: { jobId },
            key: crypto.randomUUID(),
            ...(user?.csrfToken ? { csrf: user.csrfToken } : {}),
          })
            .then(() => setNotice('已加入投递进度（准备投递）'))
            .catch(() => setNotice('登记失败，请重试'))
        }
      >
        加入投递进度
      </button>
      <span role="status">{notice}</span>
    </>
  );
}
export function FavoritesPage() {
  const { user } = useAuth(),
    [favorites, setFavorites] = useState<
      ReturnType<typeof FavoriteSchema.parse>[]
    >([]),
    [error, setError] = useState('');
  async function load() {
    setFavorites(await workspaceRequest('/favorites', FavoriteSchema.array()));
  }
  useEffect(() => {
    if (user) void load().catch(() => setError('收藏暂不可用'));
  }, [user]);
  return (
    <>
      <WorkspaceNav />
      <h1>我的收藏</h1>
      <WorkspaceGate>
        <ErrorNotice message={error} />
        {!favorites.length && (
          <p>
            尚无收藏，去<Link to="/jobs">浏览岗位</Link>。
          </p>
        )}
        <ul className="cards">
          {favorites.map((f) => (
            <li key={f.jobId}>
              <Link to={`/jobs/${f.jobId}`}>{f.title}</Link>
              <p>收藏时间：{new Date(f.createdAt).toLocaleString()}</p>
              <p>收藏不代表岗位仍在招或符合资格，请在详情中核验最新条件。</p>
              <button
                onClick={() =>
                  void workspaceRequest(`/favorites/${f.jobId}`, VoidResponse, {
                    method: 'DELETE',
                    ...(user?.csrfToken ? { csrf: user.csrfToken } : {}),
                  })
                    .then(load)
                    .catch(() => setError('取消失败'))
                }
              >
                取消收藏
              </button>
            </li>
          ))}
        </ul>
      </WorkspaceGate>
    </>
  );
}
function ApplicationEditor({
  application,
  onSaved,
}: {
  application: ApplicationDto;
  onSaved: () => Promise<void>;
}) {
  const { user } = useAuth(),
    [status, setStatus] = useState(application.status),
    [actionDate, setDate] = useState(application.actionDate ?? ''),
    [note, setNote] = useState(application.note),
    [error, setError] = useState(''),
    [history, setHistory] = useState<
      ReturnType<typeof ApplicationHistorySchema.parse>[]
    >([]);
  return (
    <article>
      <h2>
        <Link to={`/jobs/${application.jobId}`}>{application.title}</Link>
      </h2>
      <p>
        当前：{APPLICATION_LABELS[application.status]} · 版本{' '}
        {application.version}
      </p>
      <label>
        投递状态
        <select
          value={status}
          onChange={(e) =>
            setStatus(e.target.value as ApplicationDto['status'])
          }
        >
          {Object.entries(APPLICATION_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        发生日期
        <input
          type="date"
          max={new Date().toISOString().slice(0, 10)}
          value={actionDate}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <label>
        备注
        <textarea
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <ErrorNotice message={error} />
      <button
        onClick={() =>
          void workspaceRequest(
            `/applications/${application.id}`,
            ApplicationSchema,
            {
              method: 'PATCH',
              body: {
                status,
                actionDate: actionDate || null,
                note,
                expectedVersion: application.version,
              },
              key: crypto.randomUUID(),
              ...(user?.csrfToken ? { csrf: user.csrfToken } : {}),
            },
          )
            .then(onSaved)
            .catch((failure) =>
              setError(failure instanceof Error ? failure.message : '保存失败'),
            )
        }
      >
        保存进度
      </button>
      <button
        onClick={() =>
          void workspaceRequest(
            `/applications/${application.id}/history`,
            ApplicationHistorySchema.array(),
          )
            .then(setHistory)
            .catch(() => setError('历史暂不可用'))
        }
      >
        查看变更历史
      </button>
      <button
        onClick={() => {
          if (window.confirm('删除此投递记录及其历史？'))
            void workspaceRequest(
              `/applications/${application.id}`,
              VoidResponse,
              {
                method: 'DELETE',
                ...(user?.csrfToken ? { csrf: user.csrfToken } : {}),
              },
            )
              .then(onSaved)
              .catch(() => setError('删除失败'));
        }}
      >
        删除投递记录
      </button>
      {history.length > 0 && (
        <ol>
          {history.map((h) => (
            <li key={h.id}>
              {APPLICATION_LABELS[h.status]} · {h.actionDate ?? '日期未填'} ·{' '}
              {h.note}
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
export function ApplicationsPage() {
  const { user } = useAuth(),
    [applications, setApplications] = useState<ApplicationDto[]>([]),
    [error, setError] = useState(''),
    [filter, setFilter] = useState('');
  async function load() {
    setApplications(
      await workspaceRequest(
        '/applications' + (filter ? '?status=' + filter : ''),
        ApplicationSchema.array(),
      ),
    );
  }
  useEffect(() => {
    if (user) void load().catch(() => setError('投递记录暂不可用'));
  }, [user, filter]);
  return (
    <>
      <WorkspaceNav />
      <h1>投递进度</h1>
      <WorkspaceGate>
        <p>记录由你手动维护，助手不会代替你提交报名或自动修改进度。</p>
        <ErrorNotice message={error} />
        <label>
          筛选状态
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">全部</option>
            {Object.entries(APPLICATION_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {!applications.length && (
          <p>暂无记录。可在岗位详情中加入准备投递列表。</p>
        )}
        {applications.map((a) => (
          <ApplicationEditor
            key={a.id + ':' + a.version}
            application={a}
            onSaved={load}
          />
        ))}
      </WorkspaceGate>
    </>
  );
}
