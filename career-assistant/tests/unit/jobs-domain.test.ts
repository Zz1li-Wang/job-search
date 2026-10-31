import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  emptyProfileContent,
  RuleTreeSchema,
  type ProfileContent,
} from '@career/contracts';
import {
  EligibilityAggregate,
  allTruth,
  anyTruth,
  experienceBounds,
} from '@career/business';
const ref = {
  resourceId: randomUUID(),
  versionId: randomUUID(),
  observationId: randomUUID(),
  block: 0,
  start: 0,
  end: 1,
  excerpt: '本',
};
const leaf = (condition: unknown) =>
  RuleTreeSchema.parse({ type: 'condition', condition, evidence: [ref] });
function student(): ProfileContent {
  return {
    ...emptyProfileContent(),
    educationCompleteness: 'complete',
    employmentCompleteness: 'complete',
    educationEntries: [
      {
        school: '虚构学校',
        major: '计算机科学与技术',
        degree: 'bachelor',
        awardStatus: 'studying',
        graduationDate: { value: '2027-06', precision: 'month' },
        dateKind: 'expected',
      },
    ],
  };
}
describe('岗位资格三态领域', () => {
  it('AND OR保留未知，未知不能自动满足', () => {
    expect(allTruth(['true', 'unknown'])).toBe('unknown');
    expect(allTruth(['false', 'unknown'])).toBe('false');
    expect(anyTruth(['false', 'unknown'])).toBe('unknown');
    expect(anyTruth(['true', 'unknown'])).toBe('true');
  });
  it('应届在读可满足明确允许预计毕业的社招学历，而不能冒充已获学历', () => {
    const engine = new EligibilityAggregate();
    const requirement = {
      field: 'degree',
      operator: 'in',
      value: ['bachelor'],
      credentialRequirement: 'expected_by_date',
      byDate: '2027-08-01',
    };
    expect(engine.evaluate(leaf(requirement), student(), 'open').decision).toBe(
      'true',
    );
    expect(
      engine.evaluate(
        leaf({ ...requirement, credentialRequirement: 'awarded' }),
        student(),
      ).decision,
    ).toBe('unknown');
    expect(
      engine.evaluate(
        leaf({ field: 'degree', operator: 'in', value: ['bachelor'] }),
        student(),
      ).decision,
    ).toBe('unknown');
  });
  it('不同教育记录的学历和专业不能拼接满足', () => {
    const profile = student();
    profile.educationEntries = [
      {
        ...profile.educationEntries[0]!,
        major: '数学',
        degree: 'bachelor',
        awardStatus: 'awarded',
      },
      {
        ...profile.educationEntries[0]!,
        major: '计算机科学与技术',
        degree: 'master',
        awardStatus: 'awarded',
      },
    ];
    const tree = RuleTreeSchema.parse({
      type: 'all',
      children: [
        leaf({
          field: 'degree',
          operator: 'eq',
          value: ['bachelor'],
          credentialRequirement: 'awarded',
        }),
        leaf({
          field: 'major',
          operator: 'eq',
          value: ['计算机科学与技术'],
          majorMatchMode: 'exact',
        }),
      ],
      evidence: [],
    });
    expect(new EligibilityAggregate().evaluate(tree, profile).decision).toBe(
      'false',
    );
  });
  it('豁免与排除范围明确，未声明作用的旧例外保持未知', () => {
    const base = leaf({
        field: 'major',
        operator: 'eq',
        value: ['数学'],
        majorMatchMode: 'exact',
      }),
      exception = leaf({
        field: 'degree',
        operator: 'eq',
        value: ['bachelor'],
        credentialRequirement: 'enrolled',
      });
    const tree = { type: 'except', base, exception, evidence: [] };
    const engine = new EligibilityAggregate();
    expect(
      engine.evaluate(
        RuleTreeSchema.parse({ ...tree, effect: 'allow' }),
        student(),
      ).decision,
    ).toBe('true');
    expect(
      engine.evaluate(RuleTreeSchema.parse(tree), student()).decision,
    ).toBe('unknown');
  });
  it('实习不默认算正式工作，重叠完整月份不重复累计', () => {
    const profile = student();
    const entry = {
      organization: '测试单位',
      role: '测试',
      startDate: { value: '2024-01-01', precision: 'day' as const },
      endDate: { value: '2025-01-01', precision: 'day' as const },
      isCurrent: false,
      description: '',
    };
    profile.internshipEntries = [entry];
    expect(experienceBounds(profile, '2025-01-01', false)).toEqual([0, 0]);
    profile.formalEmploymentEntries = [
      entry,
      {
        ...entry,
        startDate: { value: '2024-06-01', precision: 'day' },
        endDate: { value: '2025-06-01', precision: 'day' },
      },
    ];
    expect(experienceBounds(profile, '2025-07-01', false)).toEqual([17, 17]);
  });
  it('闰日生日缺乏计算约定时保留边界不确定', () => {
    const profile = student();
    profile.birthDate = { value: '2000-02-29', precision: 'day' };
    const condition = {
      field: 'age',
      operator: 'gte',
      value: [25, null],
      calculationDate: '2025-02-28',
      allowedExperience: 'formal',
    };
    expect(
      new EligibilityAggregate().evaluate(leaf(condition), profile).decision,
    ).toBe('unknown');
    expect(
      new EligibilityAggregate().evaluate(
        leaf({ ...condition, ageBirthdayConvention: 'feb_28' }),
        profile,
      ).decision,
    ).toBe('true');
  });
  it('未提供证书不等于没有，用户明确否认才不符', () => {
    const profile = student();
    const tree = leaf({
      field: 'certificate',
      operator: 'eq',
      value: ['CET6'],
    });
    expect(new EligibilityAggregate().evaluate(tree, profile).decision).toBe(
      'unknown',
    );
    profile.absentCertificates = ['CET6'];
    expect(new EligibilityAggregate().evaluate(tree, profile).decision).toBe(
      'false',
    );
  });
});
