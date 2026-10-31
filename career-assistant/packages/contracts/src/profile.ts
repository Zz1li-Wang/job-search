import { z } from 'zod';
/** 日期精度是事实的一部分，不能把未知月份或日期补为一月一日。 */
export const DateFactSchema = z
  .strictObject({
    value: z
      .string()
      .max(10)
      .regex(
        /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/,
        '日期须使用YYYY、YYYY-MM或YYYY-MM-DD',
      )
      .nullable()
      .describe(
        '规范日期：year为YYYY，month为YYYY-MM，day为YYYY-MM-DD；仅转换原文明示格式，不补未知月日；unknown时为null',
      ),
    precision: z
      .enum(['day', 'month', 'year', 'unknown'])
      .describe(
        '与value一致的原文日期精度：year仅年，month年月，day年月日；未知为unknown且value=null',
      ),
  })
  .superRefine((v, c) => {
    const patterns = {
      day: /^\d{4}-\d{2}-\d{2}$/,
      month: /^\d{4}-\d{2}$/,
      year: /^\d{4}$/,
      unknown: /^$/,
    };
    if (v.precision === 'unknown') {
      if (v.value !== null)
        c.addIssue({ code: 'custom', message: '未知日期必须为空' });
      return;
    }
    if (!v.value || !patterns[v.precision].test(v.value)) {
      c.addIssue({ code: 'custom', message: '日期和精度不一致' });
      return;
    }
    const full =
      v.value +
      (v.precision === 'year'
        ? '-01-01'
        : v.precision === 'month'
          ? '-01'
          : '');
    const date = new Date(full + 'T00:00:00Z');
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== full
    )
      c.addIssue({ code: 'custom', message: '日期无效' });
  });
export type DateFact = z.infer<typeof DateFactSchema>;
export const UNKNOWN_DATE: DateFact = Object.freeze({
  value: null,
  precision: 'unknown',
});
const short = z.string().trim().min(1).max(200);
export const EducationFactSchema = z.strictObject({
  school: short.nullable().describe('用户确认学校，未知为空'),
  major: short.nullable().describe('用户确认专业'),
  degree: short.nullable().describe('规范学历代码或待确认原文'),
  awardStatus: z
    .enum(['studying', 'awarded', 'unknown'])
    .describe(
      '仅原文明示在读/预计毕业才为studying，已毕业/已取得才为awarded，否则unknown；不得根据日期推断',
    ),
  graduationDate: DateFactSchema.describe('毕业日期及精度'),
  dateKind: z
    .enum(['expected', 'actual', 'unknown'])
    .describe(
      '仅原文明示预计才为expected，已毕业/毕业于才为actual，否则unknown',
    ),
});
export const EmploymentFactSchema = z.strictObject({
  organization: short.nullable().describe('经历单位'),
  role: short.nullable().describe('经历岗位'),
  startDate: DateFactSchema.describe('起始日期'),
  endDate: DateFactSchema.describe('结束日期'),
  isCurrent: z.boolean().describe('是否仍在该段经历'),
  description: z.string().max(2000).describe('用户提供的经历说明'),
});
export const CertificateFactSchema = z.strictObject({
  name: short.describe('证书准确名称'),
  validUntil: DateFactSchema.describe('证书有效期，未提供为未知'),
});
export const ProfileContentSchema = z.strictObject({
  educationEntries: z
    .array(EducationFactSchema)
    .max(20)
    .describe('已确认教育记录'),
  educationCompleteness: z
    .enum(['complete', 'partial', 'unknown'])
    .describe('是否已完整提供教育经历'),
  formalEmploymentEntries: z
    .array(EmploymentFactSchema)
    .max(100)
    .describe('正式工作，和实习分开'),
  internshipEntries: z
    .array(EmploymentFactSchema)
    .max(100)
    .describe('实习经历，不自动折算正式经验'),
  employmentCompleteness: z
    .enum(['complete', 'partial', 'unknown'])
    .describe('工作历史是否完整'),
  certificates: z
    .array(CertificateFactSchema)
    .max(100)
    .describe('明确具备的证书'),
  absentCertificates: z
    .array(short)
    .max(100)
    .describe('本人明确确认不具备的证书'),
  skills: z.array(short).max(100).describe('本人确认技能'),
  jobPreferences: z
    .strictObject({
      cities: z.array(short).max(100).describe('偏好地点，仅排序'),
      directions: z.array(short).max(100).describe('偏好方向，仅排序'),
    })
    .describe('偏好不等于资格'),
  birthDate: DateFactSchema.describe('可选生日，不从其他资料猜测'),
});
export type ProfileContent = z.infer<typeof ProfileContentSchema>;
export function emptyProfileContent(): ProfileContent {
  return {
    educationEntries: [],
    educationCompleteness: 'unknown',
    formalEmploymentEntries: [],
    internshipEntries: [],
    employmentCompleteness: 'unknown',
    certificates: [],
    absentCertificates: [],
    skills: [],
    jobPreferences: { cities: [], directions: [] },
    birthDate: { ...UNKNOWN_DATE },
  };
}
export const ProfileSchema = z.strictObject({
  content: ProfileContentSchema.nullable().describe('本人正式画像，无记录为空'),
  version: z.number().int().nonnegative().describe('0表示未确认'),
  confirmedAt: z.iso.datetime().nullable().describe('正式确认时间'),
});
export type ProfileDto = z.infer<typeof ProfileSchema>;
