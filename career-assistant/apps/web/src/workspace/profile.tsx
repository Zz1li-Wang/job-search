import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ProfileSchema,
  ProfileConfirmationSchema,
  ProfileContentSchema,
  DraftSchema,
  emptyProfileContent,
  UNKNOWN_DATE,
  type ProfileContent,
  type DraftDto,
  type DateFact,
} from '@career/contracts';
import { useAuth } from '../auth/context.js';
import { WorkspaceGate, WorkspaceNav, ErrorNotice } from './shared.js';
import { workspaceRequest } from './api.js';
const date = (value: string): DateFact =>
  value
    ? {
        value,
        precision:
          value.length === 4 ? 'year' : value.length === 7 ? 'month' : 'day',
      }
    : { ...UNKNOWN_DATE };
const nullable = (value: string) => value.trim() || null;
function ProfileEditor({
  content,
  onChange,
}: {
  content: ProfileContent;
  onChange: (profile: ProfileContent) => void;
}) {
  const change = <K extends keyof ProfileContent>(
    key: K,
    value: ProfileContent[K],
  ) => onChange({ ...content, [key]: value });
  return (
    <div className="profile-editor">
      <fieldset>
        <legend>教育经历</legend>
        {content.educationEntries.map((education, index) => {
          const update = (patch: Partial<typeof education>) =>
            change(
              'educationEntries',
              content.educationEntries.map((e, i) =>
                i === index ? { ...e, ...patch } : e,
              ),
            );
          return (
            <fieldset key={index}>
              <legend>教育记录 {index + 1}</legend>
              <label>
                学校
                <input
                  value={education.school ?? ''}
                  onChange={(e) => update({ school: nullable(e.target.value) })}
                />
              </label>
              <label>
                专业
                <input
                  value={education.major ?? ''}
                  onChange={(e) => update({ major: nullable(e.target.value) })}
                />
              </label>
              <label>
                学历
                <select
                  value={education.degree ?? ''}
                  onChange={(e) => update({ degree: nullable(e.target.value) })}
                >
                  <option value="">未知</option>
                  <option value="high_school">高中</option>
                  <option value="associate">专科</option>
                  <option value="bachelor">本科</option>
                  <option value="master">硕士</option>
                  <option value="doctor">博士</option>
                  {education.degree &&
                    ![
                      'high_school',
                      'associate',
                      'bachelor',
                      'master',
                      'doctor',
                    ].includes(education.degree) && (
                      <option value={education.degree}>
                        {education.degree}
                      </option>
                    )}
                </select>
              </label>
              <label>
                取得状态
                <select
                  value={education.awardStatus}
                  onChange={(e) =>
                    update({
                      awardStatus: e.target
                        .value as typeof education.awardStatus,
                    })
                  }
                >
                  <option value="unknown">未知</option>
                  <option value="studying">在读</option>
                  <option value="awarded">已取得</option>
                </select>
              </label>
              <label>
                毕业时间
                <input
                  placeholder="2027 或 2027-06 或 2027-06-30"
                  value={education.graduationDate.value ?? ''}
                  onChange={(e) =>
                    update({ graduationDate: date(e.target.value) })
                  }
                />
              </label>
              <label>
                毕业时间性质
                <select
                  value={education.dateKind}
                  onChange={(e) =>
                    update({
                      dateKind: e.target.value as typeof education.dateKind,
                    })
                  }
                >
                  <option value="unknown">未知</option>
                  <option value="expected">预计</option>
                  <option value="actual">实际</option>
                </select>
              </label>
              <button
                type="button"
                onClick={() =>
                  change(
                    'educationEntries',
                    content.educationEntries.filter((_, i) => i !== index),
                  )
                }
              >
                删除此教育记录
              </button>
            </fieldset>
          );
        })}
        <button
          type="button"
          onClick={() =>
            change('educationEntries', [
              ...content.educationEntries,
              {
                school: null,
                major: null,
                degree: null,
                awardStatus: 'unknown',
                graduationDate: { ...UNKNOWN_DATE },
                dateKind: 'unknown',
              },
            ])
          }
        >
          添加教育经历
        </button>
        <label>
          教育经历是否完整
          <select
            value={content.educationCompleteness}
            onChange={(e) =>
              change(
                'educationCompleteness',
                e.target.value as typeof content.educationCompleteness,
              )
            }
          >
            <option value="unknown">尚未确认</option>
            <option value="partial">仅提供部分</option>
            <option value="complete">已完整提供</option>
          </select>
        </label>
      </fieldset>
      {(['formalEmploymentEntries', 'internshipEntries'] as const).map(
        (key) => (
          <fieldset key={key}>
            <legend>
              {key === 'formalEmploymentEntries'
                ? '正式工作经历'
                : '实习经历（不计为正式工作年限）'}
            </legend>
            {content[key].map((employment, index) => {
              const update = (patch: Partial<typeof employment>) =>
                change(
                  key,
                  content[key].map((e, i) =>
                    i === index ? { ...e, ...patch } : e,
                  ),
                );
              return (
                <fieldset key={index}>
                  <legend>经历 {index + 1}</legend>
                  <label>
                    单位
                    <input
                      value={employment.organization ?? ''}
                      onChange={(e) =>
                        update({ organization: nullable(e.target.value) })
                      }
                    />
                  </label>
                  <label>
                    岗位
                    <input
                      value={employment.role ?? ''}
                      onChange={(e) =>
                        update({ role: nullable(e.target.value) })
                      }
                    />
                  </label>
                  <label>
                    开始日期
                    <input
                      placeholder="YYYY-MM"
                      value={employment.startDate.value ?? ''}
                      onChange={(e) =>
                        update({ startDate: date(e.target.value) })
                      }
                    />
                  </label>
                  <label>
                    结束日期
                    <input
                      placeholder="YYYY-MM"
                      value={employment.endDate.value ?? ''}
                      onChange={(e) =>
                        update({ endDate: date(e.target.value) })
                      }
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={employment.isCurrent}
                      onChange={(e) => update({ isCurrent: e.target.checked })}
                    />
                    目前仍在该岗位
                  </label>
                  <label>
                    职责说明
                    <textarea
                      maxLength={2000}
                      value={employment.description}
                      onChange={(e) => update({ description: e.target.value })}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      change(
                        key,
                        content[key].filter((_, i) => i !== index),
                      )
                    }
                  >
                    删除此经历
                  </button>
                </fieldset>
              );
            })}
            <button
              type="button"
              onClick={() =>
                change(key, [
                  ...content[key],
                  {
                    organization: null,
                    role: null,
                    startDate: { ...UNKNOWN_DATE },
                    endDate: { ...UNKNOWN_DATE },
                    isCurrent: false,
                    description: '',
                  },
                ])
              }
            >
              添加{key === 'formalEmploymentEntries' ? '正式工作' : '实习'}
            </button>
          </fieldset>
        ),
      )}
      <label>
        工作经历是否完整
        <select
          value={content.employmentCompleteness}
          onChange={(e) =>
            change(
              'employmentCompleteness',
              e.target.value as typeof content.employmentCompleteness,
            )
          }
        >
          <option value="unknown">尚未确认</option>
          <option value="partial">仅部分</option>
          <option value="complete">已完整提供（含明确无正式工作）</option>
        </select>
      </label>
      <fieldset>
        <legend>技能与证书</legend>
        <label>
          技能（每行一项）
          <textarea
            value={content.skills.join('\n')}
            onChange={(e) =>
              change('skills', e.target.value.split('\n').filter(Boolean))
            }
          />
        </label>
        {content.certificates.map((certificate, index) => (
          <fieldset key={index}>
            <legend>证书 {index + 1}</legend>
            <label>
              证书名称
              <input
                value={certificate.name}
                onChange={(e) =>
                  change(
                    'certificates',
                    content.certificates.map((c, i) =>
                      i === index ? { ...c, name: e.target.value } : c,
                    ),
                  )
                }
              />
            </label>
            <label>
              有效期
              <input
                value={certificate.validUntil.value ?? ''}
                onChange={(e) =>
                  change(
                    'certificates',
                    content.certificates.map((c, i) =>
                      i === index
                        ? { ...c, validUntil: date(e.target.value) }
                        : c,
                    ),
                  )
                }
              />
            </label>
            <button
              type="button"
              onClick={() =>
                change(
                  'certificates',
                  content.certificates.filter((_, i) => i !== index),
                )
              }
            >
              删除证书
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          onClick={() =>
            change('certificates', [
              ...content.certificates,
              { name: '', validUntil: { ...UNKNOWN_DATE } },
            ])
          }
        >
          添加证书
        </button>
        <label>
          明确不具备的证书（每行一项，未知留空）
          <textarea
            value={content.absentCertificates.join('\n')}
            onChange={(e) =>
              change(
                'absentCertificates',
                e.target.value.split('\n').filter(Boolean),
              )
            }
          />
        </label>
      </fieldset>
      <label>
        出生日期（可不填）
        <input
          placeholder="YYYY 或 YYYY-MM 或 YYYY-MM-DD"
          value={content.birthDate.value ?? ''}
          onChange={(e) => change('birthDate', date(e.target.value))}
        />
      </label>
      <label>
        偏好城市（用逗号分隔，仅用于排序）
        <input
          value={content.jobPreferences.cities.join('，')}
          onChange={(e) =>
            change('jobPreferences', {
              ...content.jobPreferences,
              cities: e.target.value.split(/[,，]/).filter(Boolean),
            })
          }
        />
      </label>
      <label>
        求职方向（用逗号分隔）
        <input
          value={content.jobPreferences.directions.join('，')}
          onChange={(e) =>
            change('jobPreferences', {
              ...content.jobPreferences,
              directions: e.target.value.split(/[,，]/).filter(Boolean),
            })
          }
        />
      </label>
    </div>
  );
}
export function ProfilePage() {
  const { user } = useAuth(),
    [params] = useSearchParams(),
    [content, setContent] = useState(emptyProfileContent),
    [version, setVersion] = useState(0),
    [draft, setDraft] = useState<DraftDto | null>(null),
    [isDirty, setDirty] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const csrf = user?.csrfToken;
  useEffect(() => {
    if (!user) return;
    void (async () => {
      const profile = await workspaceRequest('/profile', ProfileSchema);
      setVersion(profile.version);
      const id = params.get('draft');
      if (id) {
        const d = await workspaceRequest(`/profile/drafts/${id}`, DraftSchema);
        setDraft(d);
        setContent(d.content);
      } else setContent(profile.content ?? emptyProfileContent());
    })().catch(() => setError('无法载入画像或草稿'));
  }, [user, params]);
  async function save() {
    setBusy(true);
    setError('');
    try {
      const validated = ProfileContentSchema.safeParse(content);
      if (!validated.success) {
        setError('请核对日期格式、空证书和字段长度，未知信息请留空');
        return;
      }
      const next = await workspaceRequest(
        draft ? `/profile/drafts/${draft.id}` : '/profile/drafts',
        DraftSchema,
        {
          method: draft ? 'PATCH' : 'POST',
          body: {
            content: validated.data,
            baseProfileVersion: version,
            ...(draft ? { expectedDraftVersion: draft.version } : {}),
          },
          ...(csrf ? { csrf } : {}),
          key: crypto.randomUUID(),
        },
      );
      setDraft(next);
      setDirty(false);
      setNotice('草稿已保存，正式画像尚未更新');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!draft) return;
    setBusy(true);
    try {
      const profile = await workspaceRequest(
        `/profile/drafts/${draft.id}/confirm`,
        ProfileConfirmationSchema,
        {
          method: 'POST',
          body: {
            expectedDraftVersion: draft.version,
            expectedProfileVersion: version,
          },
          ...(csrf ? { csrf } : {}),
        },
      );
      setVersion(profile.version);
      setNotice(`已确认正式画像，版本 ${profile.version}`);
      setDraft(
        await workspaceRequest(`/profile/drafts/${draft.id}`, DraftSchema),
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : '确认失败，请重新载入后核对冲突',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <WorkspaceNav />
      <h1>我的画像</h1>
      <Link to="/chat?resumes=open">返回求职咨询</Link>
      <WorkspaceGate>
        <p>
          正式版本：{version}。请核对每项事实，未知信息不会被视为满足岗位条件。
        </p>
        <ErrorNotice message={error} />
        <p role="status">{notice}</p>
        <ProfileEditor
          content={content}
          onChange={(value) => {
            setContent(value);
            setDirty(true);
            setNotice('');
          }}
        />
        {draft?.evidence.length ? (
          <details>
            <summary>模型提取依据</summary>
            {draft.evidence.map((e, i) => (
              <p key={i}>
                {e.path} · {e.locator}：{e.excerpt}
              </p>
            ))}
          </details>
        ) : null}
        <button
          disabled={busy || draft?.status === 'confirmed'}
          onClick={() => void save()}
        >
          保存待确认草稿
        </button>
        <button
          disabled={busy || !draft || isDirty || draft.status === 'confirmed'}
          onClick={() => void confirm()}
        >
          确认并更新正式画像
        </button>
        {draft?.status === 'confirmed' && (
          <button
            onClick={() => {
              setDraft(null);
              setDirty(true);
              setNotice('正在编辑新草稿');
            }}
          >
            基于当前内容重新编辑
          </button>
        )}
      </WorkspaceGate>
    </>
  );
}
