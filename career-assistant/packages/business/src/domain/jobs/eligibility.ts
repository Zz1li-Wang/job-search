import type {
  ProfileContent,
  DateFact,
  RuleNode,
  RuleCondition,
  EligibilityCheckItem,
} from '@career/contracts';
import { INGESTION_POLICY } from '../ingestion/policy.js';
export type Truth = 'true' | 'false' | 'unknown';
export const RULES_VERSION = 'eligibility-1';
export function allTruth(values: Truth[]): Truth {
  return values.includes('false')
    ? 'false'
    : values.every((v) => v === 'true')
      ? 'true'
      : 'unknown';
}
export function anyTruth(values: Truth[]): Truth {
  return values.includes('true')
    ? 'true'
    : values.every((v) => v === 'false')
      ? 'false'
      : 'unknown';
}
export function dateBounds(fact: DateFact): [number, number] | null {
  if (!fact.value || fact.precision === 'unknown') return null;
  const parts = fact.value.split('-').map(Number);
  const year = parts[0]!,
    month = parts[1] ?? 1,
    day = parts[2] ?? 1;
  const start = Date.UTC(year, month - 1, day);
  const end =
    fact.precision === 'year'
      ? Date.UTC(year + 1, 0, 1) - 1
      : fact.precision === 'month'
        ? Date.UTC(year, month, 1) - 1
        : start;
  return [start, end];
}
function numeric(
  min: number,
  max: number,
  condition: Extract<
    RuleCondition,
    { field: 'age' | 'formal_experience_months' }
  >,
): Truth {
  const low = condition.operator === 'lte' ? 0 : condition.value[0],
    high =
      condition.operator === 'gte'
        ? Infinity
        : condition.operator === 'between'
          ? (condition.value[1] ?? -1)
          : condition.value[0];
  if (min >= low && max <= high) return 'true';
  if (max < low || min > high) return 'false';
  return 'unknown';
}
function completeMonths(start: number, end: number): number {
  const first = new Date(start),
    last = new Date(end);
  return Math.max(
    0,
    (last.getUTCFullYear() - first.getUTCFullYear()) * 12 +
      last.getUTCMonth() -
      first.getUTCMonth() -
      (last.getUTCDate() < first.getUTCDate() ? 1 : 0),
  );
}
function mergedMonths(intervals: [number, number][]): number {
  const merged: [number, number][] = [];
  for (const range of intervals.sort((a, b) => a[0] - b[0])) {
    if (range[1] <= range[0]) continue;
    const tail = merged.at(-1);
    if (tail && range[0] <= tail[1]) tail[1] = Math.max(tail[1], range[1]);
    else merged.push([...range]);
  }
  return merged.reduce(
    (total, [start, end]) => total + completeMonths(start, end),
    0,
  );
}
export function experienceBounds(
  profile: ProfileContent,
  asOf: string,
  includeInternship: boolean,
): [number, number] {
  const cutoff = Date.parse(asOf + 'T00:00:00Z'),
    minimum: [number, number][] = [],
    maximum: [number, number][] = [];
  let unknown = profile.employmentCompleteness !== 'complete';
  for (const entry of [
    ...profile.formalEmploymentEntries,
    ...(includeInternship ? profile.internshipEntries : []),
  ]) {
    const start = dateBounds(entry.startDate),
      end = entry.isCurrent
        ? ([cutoff, cutoff] as [number, number])
        : dateBounds(entry.endDate);
    if (!start || !end) {
      unknown = true;
      continue;
    }
    minimum.push([start[1], Math.min(end[0], cutoff)]);
    maximum.push([start[0], Math.min(end[1], cutoff)]);
  }
  return [mergedMonths(minimum), unknown ? Infinity : mergedMonths(maximum)];
}
function ageAt(
  birth: number,
  asOf: number,
  convention: 'march_1' | 'feb_28',
): number {
  const b = new Date(birth),
    c = new Date(asOf);
  let month = b.getUTCMonth(),
    day = b.getUTCDate();
  if (
    month === 1 &&
    day === 29 &&
    new Date(Date.UTC(c.getUTCFullYear(), 1, 29)).getUTCMonth() !== 1
  ) {
    month = convention === 'march_1' ? 2 : 1;
    day = convention === 'march_1' ? 1 : 28;
  }
  return (
    c.getUTCFullYear() -
    b.getUTCFullYear() -
    (c.getUTCMonth() < month ||
    (c.getUTCMonth() === month && c.getUTCDate() < day)
      ? 1
      : 0)
  );
}
interface LeafDecision {
  decision: Truth;
  fact: string | null;
  missing: string[];
  reason: string;
}
export class EligibilityAggregate {
  decide(
    tree: RuleNode | null,
    profile: ProfileContent | null,
    context: {
      availability: 'open' | 'closed' | 'unknown';
      isComplete: boolean;
      conflicts: number;
      freshness: 'fresh' | 'pending' | 'closed';
      unvisited: number;
    },
  ) {
    const result = tree
      ? this.evaluate(tree, profile, context.availability)
      : { decision: 'unknown' as Truth, checks: [] };
    const isTrusted =
      context.isComplete &&
      context.conflicts === 0 &&
      context.freshness === 'fresh' &&
      context.unvisited === 0;
    const status: 'eligible' | 'not_eligible' | 'pending' =
      context.availability === 'closed'
        ? 'not_eligible'
        : !isTrusted || !profile
          ? 'pending'
          : result.decision === 'true'
            ? 'eligible'
            : result.decision === 'false'
              ? 'not_eligible'
              : 'pending';
    return { ...result, status, isTrusted };
  }

  evaluate(
    tree: RuleNode,
    profile: ProfileContent | null,
    availability: 'open' | 'closed' | 'unknown' = 'unknown',
  ): { decision: Truth; checks: EligibilityCheckItem[] } {
    const candidates: (ProfileContent['educationEntries'][number] | null)[] =
      profile?.educationEntries.length
        ? [
            ...profile.educationEntries,
            ...(profile.educationCompleteness !== 'complete' ? [null] : []),
          ]
        : [null];
    const results = candidates.map((education) => {
      const checks: EligibilityCheckItem[] = [];
      const visit = (node: RuleNode, path: string): Truth => {
        let decision: Truth;
        let fact: string | null = null,
          missing: string[] = [],
          reason = '按原文组合规则计算';
        if (node.type === 'unknown') {
          decision = 'unknown';
          reason = node.reason;
          missing = ['source.requirements'];
        } else if (node.type === 'all' || node.type === 'any') {
          const children = node.children.map((child, i) =>
            visit(child, `${path}.${i}`),
          );
          decision =
            node.type === 'all' ? allTruth(children) : anyTruth(children);
        } else if (node.type === 'except') {
          const base = visit(node.base, path + '.base'),
            exception = visit(node.exception, path + '.exception');
          decision =
            node.effect === 'allow'
              ? anyTruth([base, exception])
              : node.effect === 'exclude'
                ? allTruth([
                    base,
                    exception === 'unknown'
                      ? 'unknown'
                      : exception === 'true'
                        ? 'false'
                        : 'true',
                  ])
                : 'unknown';
          if (!node.effect) {
            missing = ['source.exception_effect'];
            reason = '例外作用未核验';
          }
        } else if (node.type === 'condition') {
          const result = this.evaluateLeaf(
            node.condition,
            profile,
            education,
            availability,
          );
          decision = result.decision;
          fact = result.fact;
          missing = result.missing;
          reason = result.reason;
        } else {
          decision = 'unknown';
        }
        checks.push({
          path,
          field: node.type === 'condition' ? node.condition.field : node.type,
          decision,
          reason,
          userFact: fact,
          evidenceRefs: node.evidence,
          missingFields: missing,
        });
        return decision;
      };
      return { decision: visit(tree, 'root'), checks };
    });
    const preferred =
      results.find((r) => r.decision === 'true') ??
      results.find((r) => r.decision === 'unknown') ??
      results[0]!;
    return preferred;
  }
  private evaluateLeaf(
    condition: RuleCondition,
    profile: ProfileContent | null,
    education: ProfileContent['educationEntries'][number] | null,
    availability: 'open' | 'closed' | 'unknown',
  ): LeafDecision {
    const unknown = (
      field: string,
      reason = '所需事实或规则尚未确认',
    ): LeafDecision => ({
      decision: 'unknown',
      fact: null,
      missing: [field],
      reason,
    });
    const known = (
      decision: Truth,
      fact: string,
      reason = '按已确认事实与原文条件比较',
    ): LeafDecision => ({
      decision,
      fact,
      missing: decision === 'unknown' ? [`profile.${condition.field}`] : [],
      reason,
    });
    if (condition.field === 'availability')
      return availability === 'unknown'
        ? unknown('source.availability')
        : known(
            condition.value.includes(availability) ? 'true' : 'false',
            availability,
          );
    if (!profile)
      return unknown(`profile.${condition.field}`, '尚无本人已确认画像');
    if (condition.field === 'degree') {
      if (
        !education?.degree ||
        !condition.credentialRequirement ||
        condition.credentialRequirement === 'unknown'
      )
        return unknown('education.degree_and_award');
      let award: Truth =
        education.awardStatus === 'unknown'
          ? 'unknown'
          : condition.credentialRequirement === 'awarded'
            ? education.awardStatus === 'awarded'
              ? 'true'
              : 'unknown'
            : condition.credentialRequirement === 'enrolled'
              ? 'true'
              : 'unknown';
      if (condition.credentialRequirement === 'expected_by_date') {
        const bounds = dateBounds(education.graduationDate);
        award =
          education.awardStatus === 'awarded'
            ? 'true'
            : bounds && condition.byDate
              ? bounds[1] <= Date.parse(condition.byDate + 'T23:59:59.999Z')
                ? 'true'
                : bounds[0] > Date.parse(condition.byDate + 'T23:59:59.999Z')
                  ? 'false'
                  : 'unknown'
              : 'unknown';
      }
      return known(
        allTruth([
          condition.value.includes(education.degree) ? 'true' : 'false',
          award,
        ]),
        `${education.degree}/${education.awardStatus}`,
      );
    }
    if (condition.field === 'major') {
      if (!education?.major || condition.majorMatchMode !== 'exact')
        return unknown(
          'education.major_or_mapping',
          '专业缺失或缺少精确/已审定映射',
        );
      return known(
        condition.value
          .map((v) => v.normalize('NFKC').trim())
          .includes(education.major.normalize('NFKC').trim())
          ? 'true'
          : 'false',
        education.major,
      );
    }
    if (condition.field === 'graduation_status') {
      if (!education || education.awardStatus === 'unknown')
        return unknown('education.awardStatus');
      return known(
        condition.value.includes(education.awardStatus) ? 'true' : 'false',
        education.awardStatus,
      );
    }
    if (condition.field === 'graduation_date') {
      const range = education ? dateBounds(education.graduationDate) : null;
      if (!range) return unknown('education.graduationDate');
      const low = Date.parse(condition.value[0] + 'T00:00:00Z'),
        high = condition.value[1]
          ? Date.parse(condition.value[1] + 'T23:59:59.999Z')
          : low;
      const decision =
        condition.operator === 'before'
          ? range[1] < low
            ? 'true'
            : range[0] >= low
              ? 'false'
              : 'unknown'
          : condition.operator === 'after'
            ? range[0] > high
              ? 'true'
              : range[1] <= high
                ? 'false'
                : 'unknown'
            : range[0] >= low && range[1] <= high
              ? 'true'
              : range[1] < low || range[0] > high
                ? 'false'
                : 'unknown';
      return known(decision, education!.graduationDate.value!);
    }
    if (condition.field === 'age') {
      const bounds = dateBounds(profile.birthDate);
      if (!bounds || !condition.calculationDate)
        return unknown('birthDate_or_calculationDate');
      const date = Date.parse(condition.calculationDate + 'T00:00:00Z');
      const conventions =
        condition.ageBirthdayConvention &&
        condition.ageBirthdayConvention !== 'unknown'
          ? [condition.ageBirthdayConvention]
          : (['march_1', 'feb_28'] as const);
      const ages = conventions.flatMap((c) =>
        bounds.map((b) => ageAt(b, date, c)),
      );
      return known(
        numeric(Math.min(...ages), Math.max(...ages), condition),
        `${Math.min(...ages)}—${Math.max(...ages)}周岁`,
      );
    }
    if (condition.field === 'formal_experience_months') {
      if (!condition.calculationDate)
        return unknown('source.experience_calculationDate');
      const [min, max] = experienceBounds(
        profile,
        condition.calculationDate,
        condition.allowedExperience === 'explicitly_includes_internship',
      );
      return known(
        numeric(min, max, condition),
        `${min}—${Number.isFinite(max) ? max : '未知'}完整月`,
      );
    }
    if (condition.field === 'certificate') {
      const decisions = condition.value.map((name) => {
        const certificate = profile.certificates.find((c) => c.name === name);
        if (certificate) {
          if (condition.certificateValidAt) {
            const bounds = dateBounds(certificate.validUntil);
            if (!bounds) return 'unknown' as Truth;
            const asOf = Date.parse(
              condition.certificateValidAt + 'T00:00:00Z',
            );
            return bounds[0] >= asOf
              ? 'true'
              : bounds[1] < asOf
                ? 'false'
                : 'unknown';
          }
          return 'true' as Truth;
        }
        return profile.absentCertificates.includes(name)
          ? ('false' as Truth)
          : ('unknown' as Truth);
      });
      return known(
        anyTruth(decisions),
        condition.value
          .filter((name) => profile.certificates.some((c) => c.name === name))
          .join('、'),
      );
    }
    return unknown('source.availability', '报名状态由当前岗位证据独立核验');
  }
}
export function evidenceFresh(
  verifiedAt: Date | null,
  deadline: { value: string | null; precision: string },
  now: Date,
): boolean {
  if (!verifiedAt) return false;
  const urgent =
    deadline.precision === 'instant' &&
    deadline.value &&
    Date.parse(deadline.value) - now.getTime() <=
      INGESTION_POLICY.urgentWindowMs;
  return (
    now.getTime() - verifiedAt.getTime() <=
    (urgent ? INGESTION_POLICY.urgentMs : INGESTION_POLICY.refreshMs)
  );
}
