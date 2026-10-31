import { z } from 'zod';
import {
  TextSpanSchema,
  ProfileContentSchema,
  FieldEvidenceSchema,
  type ProfileContent,
  type FieldEvidence,
  type TextSpan,
} from '@career/contracts';
import { BusinessError } from '../shared/errors.js';
import { ExtractionEvidenceError } from './errors.js';
export const ResumeStateSchema = z.object({
  id: z.uuid().describe('私有文件标识'),
  userId: z.uuid().describe('所有者'),
  title: z.string().describe('用户标题'),
  format: z.enum(['pdf', 'docx', 'txt']).describe('格式'),
  fileKey: z.string().nullable().describe('私有存储引用'),
  contentHash: z.string().describe('同用户去重摘要'),
  version: z.number().int().positive().describe('文件版本'),
  status: z
    .enum(['queued', 'extracting', 'structuring', 'ready', 'failed', 'deleted'])
    .describe('解析状态'),
  activeRunId: z.uuid().nullable().describe('当前解析授权'),
  draftId: z.uuid().nullable().describe('解析草稿'),
  errorCode: z.string().nullable().describe('安全错误'),
  spans: z.array(TextSpanSchema).nullable().describe('页段原文'),
  createdAt: z.date().describe('建立时间'),
  deletedAt: z.date().nullable().describe('删除屏障'),
});
export type ResumeState = z.infer<typeof ResumeStateSchema>;
export class ResumeEntity {
  private readonly state: ResumeState;
  constructor(state: ResumeState) {
    this.state = structuredClone(ResumeStateSchema.parse(state));
  }
  snapshot() {
    return structuredClone(this.state);
  }
  assertReadable(userId: string, resourceId?: string | null) {
    if (
      this.state.userId !== userId ||
      this.state.deletedAt ||
      (resourceId && resourceId !== this.state.id)
    )
      throw new BusinessError('NOT_FOUND');
  }
  start(runId: string) {
    if (
      this.state.deletedAt ||
      this.state.activeRunId !== runId ||
      this.state.status !== 'queued'
    )
      throw new BusinessError('INVALID_TRANSITION');
    return new ResumeEntity({ ...this.state, status: 'extracting' });
  }
  withText(spans: TextSpan[], runId: string) {
    if (
      this.state.deletedAt ||
      this.state.activeRunId !== runId ||
      this.state.status !== 'extracting'
    )
      throw new BusinessError('INVALID_TRANSITION');
    return new ResumeEntity({ ...this.state, spans, status: 'structuring' });
  }
  complete(draftId: string, runId: string) {
    if (
      this.state.deletedAt ||
      this.state.activeRunId !== runId ||
      this.state.status !== 'structuring'
    )
      throw new BusinessError('INVALID_TRANSITION');
    return new ResumeEntity({
      ...this.state,
      status: 'ready',
      draftId,
      errorCode: null,
    });
  }
  fail(code: string) {
    if (this.state.deletedAt || this.state.status === 'ready') return this;
    return new ResumeEntity({
      ...this.state,
      status: 'failed',
      errorCode: code,
    });
  }
  retry(runId: string, version: number, isExplicit: boolean) {
    if (this.state.version !== version)
      throw new BusinessError('VERSION_CONFLICT');
    if (this.state.status !== 'failed' || !isExplicit)
      throw new BusinessError('INVALID_TRANSITION');
    return new ResumeEntity({
      ...this.state,
      status: 'queued',
      activeRunId: runId,
      errorCode: null,
    });
  }
  remove(now: Date) {
    return new ResumeEntity({
      ...this.state,
      status: 'deleted',
      version: this.state.version + 1,
      spans: null,
      deletedAt: now,
    });
  }
}
export const DraftStateSchema = z.object({
  id: z.uuid().describe('草稿'),
  userId: z.uuid().describe('所有者'),
  version: z.number().int().positive().describe('草稿并发版本'),
  baseProfileVersion: z.number().int().nonnegative().describe('正式版本基线'),
  content: ProfileContentSchema.describe('未确认资料'),
  status: z.enum(['draft', 'confirmed']).describe('用户确认状态'),
  sourceResumeId: z.uuid().nullable().describe('原文引用'),
  sourceResumeVersion: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe('来源文件版本'),
  evidence: z.array(FieldEvidenceSchema).describe('原文依据'),
  confirmedProfileVersion: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe('确认产生版本'),
  confirmedContent:
    ProfileContentSchema.nullable().describe('重复确认返回首次结果'),
  confirmedAt: z.date().nullable().describe('首次确认时刻'),
  createdAt: z.date().describe('建立时刻'),
});
export type DraftState = z.infer<typeof DraftStateSchema>;
/** 正式事实的确认由领域对象做版本判断，模型只能产生草稿。 */
export class ProfileDraftEntity {
  private readonly state: DraftState;
  constructor(state: DraftState) {
    this.state = structuredClone(DraftStateSchema.parse(state));
  }
  snapshot() {
    return structuredClone(this.state);
  }
  edit(
    content: ProfileContent,
    baseProfileVersion: number,
    expectedVersion: number,
  ) {
    if (this.state.status !== 'draft' || this.state.version !== expectedVersion)
      throw new BusinessError('VERSION_CONFLICT');
    return new ProfileDraftEntity({
      ...this.state,
      content,
      baseProfileVersion,
      version: expectedVersion + 1,
      evidence: [],
    });
  }
  confirm(
    expectedDraftVersion: number,
    expectedProfileVersion: number,
    currentProfileVersion: number,
    now: Date,
  ) {
    if (this.state.status === 'confirmed') return this;
    if (
      this.state.version !== expectedDraftVersion ||
      this.state.baseProfileVersion !== currentProfileVersion ||
      expectedProfileVersion !== currentProfileVersion
    )
      throw new BusinessError('VERSION_CONFLICT');
    validateProfileDates(this.state.content, now);
    return new ProfileDraftEntity({
      ...this.state,
      status: 'confirmed',
      confirmedProfileVersion: currentProfileVersion + 1,
      confirmedContent: this.state.content,
      confirmedAt: now,
    });
  }
}
export function validateProfileDates(content: ProfileContent, now: Date) {
  const birthday = content.birthDate;
  if (
    birthday.value &&
    birthday.value > now.toISOString().slice(0, birthday.value.length)
  )
    throw new BusinessError('INVALID_EVIDENCE');
  const today = now.toISOString().slice(0, 10);
  for (const education of content.educationEntries) {
    if (
      education.dateKind === 'actual' &&
      education.graduationDate.value &&
      education.graduationDate.value >
        today.slice(0, education.graduationDate.value.length)
    )
      throw new BusinessError('INVALID_EVIDENCE');
  }
  const presentCertificates = new Set(
    content.certificates.map((c) => c.name.toLowerCase()),
  );
  if (
    content.absentCertificates.some((c) =>
      presentCertificates.has(c.toLowerCase()),
    )
  )
    throw new BusinessError('INVALID_EVIDENCE');
  for (const employment of [
    ...content.formalEmploymentEntries,
    ...content.internshipEntries,
  ]) {
    if (employment.isCurrent && employment.endDate.value)
      throw new BusinessError('INVALID_EVIDENCE');
    for (const date of [employment.startDate, employment.endDate])
      if (date.value && date.value > today.slice(0, date.value.length))
        throw new BusinessError('INVALID_EVIDENCE');
    if (
      employment.startDate.value &&
      employment.endDate.value &&
      employment.startDate.precision === employment.endDate.precision &&
      employment.startDate.value > employment.endDate.value
    )
      throw new BusinessError('INVALID_EVIDENCE');
  }
}
/** 归一化只接受显式别名；不能用模型结论替代原文事实。 */
const NORMALIZED_ALIASES: Record<string, string[]> = {
  true: ['至今', '目前在职', '在岗', '现任'],
  bachelor: ['本科', '学士'],
  master: ['硕士', '研究生'],
  doctor: ['博士'],
  associate: ['大专', '专科'],
  studying: ['在读', '预计毕业'],
  awarded: ['已毕业', '已取得'],
  expected: ['预计'],
  actual: ['已毕业', '毕业于'],
};
export function validateExtraction(
  content: ProfileContent,
  evidence: FieldEvidence[],
  spans: TextSpan[],
) {
  const refs = new Map(evidence.map((e) => [e.path, e]));
  const validate = (value: unknown, path: string) => {
    if (
      value === null ||
      value === '' ||
      value === 'unknown' ||
      value === false
    )
      return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => validate(v, `${path}/${i}`));
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as object)) {
        if (
          [
            'educationCompleteness',
            'employmentCompleteness',
            'absentCertificates',
          ].includes(k)
        )
          continue;
        if (k === 'precision') continue;
        validate(v, `${path}/${k}`);
      }
      return;
    }
    const ref = refs.get(path),
      span = ref && spans.find((s) => s.locator === ref.locator);
    if (!ref) throw new ExtractionEvidenceError(path, 'missing_reference');
    if (!span?.text.includes(ref.excerpt))
      throw new ExtractionEvidenceError(path, 'excerpt_not_found');
    const fact = String(value),
      compact = (text: string) => text.replace(/[年月日./\s-]/g, '');
    if (
      !ref.excerpt.includes(fact) &&
      !NORMALIZED_ALIASES[fact]?.some((alias) => ref.excerpt.includes(alias)) &&
      !(path.endsWith('/value') && compact(ref.excerpt).includes(compact(fact)))
    )
      throw new ExtractionEvidenceError(path, 'value_not_supported');
  };
  validate(content, '');
  if (
    content.educationCompleteness === 'complete' ||
    content.employmentCompleteness === 'complete' ||
    content.absentCertificates.length
  )
    throw new BusinessError('INVALID_EVIDENCE');
}
