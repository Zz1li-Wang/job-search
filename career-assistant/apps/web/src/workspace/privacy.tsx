import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DeletionSchema, TrustSchema, type TrustDto } from '@career/contracts';
import { WorkspaceNav, WorkspaceGate, ErrorNotice } from './shared.js';
import { workspaceRequest } from './api.js';
import { useAuth } from '../auth/context.js';
export function PrivacyPage() {
  const { user, setUser } = useAuth(),
    navigate = useNavigate(),
    [scope, setScope] = useState<'profile' | 'personal' | 'account'>('profile'),
    [confirmation, setConfirmation] = useState(''),
    [password, setPassword] = useState(''),
    [deletion, setDeletion] = useState<ReturnType<
      typeof DeletionSchema.parse
    > | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function remove() {
    if (confirmation !== '确认删除') return;
    setBusy(true);
    setError('');
    try {
      const path = {
          profile: '/profile',
          personal: '/me/data',
          account: '/me',
        }[scope],
        marker = {
          profile: 'CLEAR_PROFILE',
          personal: 'CLEAR_PERSONAL_DATA',
          account: 'DELETE_ACCOUNT',
        }[scope];
      const result = await workspaceRequest(path, DeletionSchema, {
        method: 'DELETE',
        body: {
          confirmation: marker,
          ...(scope === 'account' ? { currentPassword: password } : {}),
        },
        key: crypto.randomUUID(),
        ...(user?.csrfToken ? { csrf: user.csrfToken } : {}),
      });
      setDeletion(result);
      setPassword('');
      setConfirmation('');
      if (scope === 'account') {
        setUser(null);
        navigate('/login', { replace: true });
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <WorkspaceNav />
      <h1>隐私与数据</h1>
      <WorkspaceGate>
        <p>
          简历仅本人可读。提取文字会发送给你配置的模型服务生成草稿；系统不自动确认，不自动报名。
        </p>
        <label>
          删除范围
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as typeof scope);
              setConfirmation('');
            }}
          >
            <option value="profile">清空正式画像与草稿</option>
            <option value="personal">清空全部求职数据，保留账号</option>
            <option value="account">删除账号和全部求职数据</option>
          </select>
        </label>
        <p>
          {scope === 'profile'
            ? '将清空正式画像、画像草稿和资格记录；保留原始简历、会话和求职管理记录。所有在途模型任务失去写入权限。'
            : scope === 'personal'
              ? '将删除简历、画像、会话、资格记录、收藏和投递历史，账号仍可登录。'
              : '账号删除后所有设备立即退出。此操作不能撤销，重新注册也不会恢复历史。'}
        </p>
        <p>
          本地访问权限会先撤销；物理文件清理失败时保留补偿任务，状态显示“等待文件清理”。备份中的历史数据按部署方保留策略到期清除。
        </p>
        {scope === 'account' && (
          <label>
            当前密码
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        <label>
          请输入“确认删除”
          <input
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </label>
        <ErrorNotice message={error} />
        <button
          className="danger"
          disabled={
            busy ||
            confirmation !== '确认删除' ||
            (scope === 'account' && !password)
          }
          onClick={() => void remove()}
        >
          执行所选删除
        </button>
        {deletion && (
          <div role="status">
            <p>
              {deletion.status === 'completed'
                ? '所选数据已删除'
                : '访问已撤销，等待文件清理'}{' '}
              · 待清理文件 {deletion.pendingFiles}
            </p>
            <button
              onClick={() =>
                void workspaceRequest(
                  `/deletions/${deletion.id}`,
                  DeletionSchema,
                )
                  .then(setDeletion)
                  .catch(() => setError('无法查询清理状态'))
              }
            >
              刷新清理状态
            </button>
          </div>
        )}
      </WorkspaceGate>
    </>
  );
}
export function TrustPage() {
  const [trust, setTrust] = useState<TrustDto | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    void workspaceRequest('/trust', TrustSchema)
      .then(setTrust)
      .catch(() => setError('数据统计暂不可用'));
  }, []);
  return (
    <>
      <WorkspaceNav />
      <h1>数据与可信说明</h1>
      <ErrorNotice message={error} />
      <p>
        同时收录校招和社招。社招标签不会直接排除应届生；请核对具体报名条件。
      </p>
      {trust ? (
        <>
          <dl>
            {Object.entries(trust.counts).map(([key, value]) => (
              <div key={key}>
                <dt>
                  {
                    (
                      {
                        campus: '校招岗位',
                        social: '社招岗位',
                        unknown: '类型待确认',
                        fetched: '成功获取正文',
                        reviewed: '条件完整核验',
                        fresh: '仍在核验有效期',
                      } as Record<string, string>
                    )[key]
                  }
                </dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p>
            统计时间：{new Date(trust.computedAt).toLocaleString()} ·
            最近成功获取：
            {trust.lastFetchedAt
              ? new Date(trust.lastFetchedAt).toLocaleString()
              : '暂无'}
          </p>
          <h2>任务进度</h2>
          <ul>
            {trust.queues.map((q) => (
              <li key={q.status}>
                {(
                  {
                    queued: '等待执行',
                    running: '执行中',
                    retry_wait: '等待重试',
                    paused: '已暂停',
                    failed: '失败',
                    succeeded: '成功',
                  } as Record<string, string>
                )[q.status] ?? '状态待确认'}
                ：{q.count}
              </li>
            ))}
          </ul>
          <h2>实际覆盖与缺口</h2>
          <ul>
            {[...trust.verifiedScope, ...trust.coverageWarnings].map(
              (message, i) => (
                <li key={i}>{message}</li>
              ),
            )}
          </ul>
        </>
      ) : (
        <p role="status">正在读取实际统计…</p>
      )}
      <h2>怎样理解判断结果</h2>
      <p>
        “符合已核验条件”仅针对已收录、已完整核验且仍有效的条件；最终资格以招聘单位审核为准。“待核验”表示资料、来源或时效不足，不表示已经符合。“不符合”保留具体原文依据。
      </p>
      <p>
        未知条件不会视为满足，实习不会自动累计为正式工作年限。证据过期、公告冲突或资料变化会使历史判断失效。收藏和投递记录不会刷新来源时间。
      </p>
      <p>
        默认目标：每2小时发现新增岗位、在招岗位每24小时复查、48小时内截止岗位每2小时优先复查。实际覆盖和积压以上方统计为准；网络采集需要运营方显式启用，不承诺已覆盖全站。
      </p>
    </>
  );
}
