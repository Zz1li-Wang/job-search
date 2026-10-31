import { z } from 'zod';
import {
  RuleTreeSchema,
  EvidenceRefSchema,
  type RuleNode,
} from '@career/contracts';
import { BodyStateSchema, freshness } from './source.js';
import { IngestionError } from './errors.js';

export const VersionStateSchema = z.object({
  id: z.uuid().describe('正文版本'),
  resourceId: z.uuid().describe('来源资源'),
  materialHash: z.string().length(64).describe('业务正文摘要'),
  body: BodyStateSchema.describe('领域正文'),
  parserVersion: z.string().describe('定位规则版本'),
  snapshotId: z.uuid().describe('去敏快照'),
  createdAt: z.date().describe('版本首次出现时间'),
});
export type VersionState = z.infer<typeof VersionStateSchema>;
export class SourceVersionEntity {
  private readonly state: VersionState;
  constructor(state: VersionState) {
    this.state = structuredClone(VersionStateSchema.parse(state));
  }
  snapshot(): VersionState {
    return structuredClone(this.state);
  }
  matches(ref: z.infer<typeof EvidenceRefSchema>): boolean {
    return (
      ref.resourceId === this.state.resourceId &&
      ref.versionId === this.state.id &&
      this.state.body.blocks[ref.block]?.slice(ref.start, ref.end) ===
        ref.excerpt
    );
  }
  freshness(verifiedAt: Date | null, now: Date) {
    return freshness(this.state.body, verifiedAt, now);
  }
}
export const ObservationStateSchema = z.object({
  id: z.uuid().describe('获取观察ID'),
  resourceId: z.uuid().describe('资源'),
  versionId: z.uuid().describe('实际所见正文'),
  attemptId: z.uuid().describe('本次执行尝试'),
  httpStatus: z.number().int().describe('HTTP状态'),
  fetchedAt: z.date().describe('实际成功获取'),
  rawDigest: z.string().length(64).describe('响应字节摘要'),
  parserVersion: z.string().describe('解析版本'),
});
export type ObservationState = z.infer<typeof ObservationStateSchema>;
export const ReviewStateSchema = z.object({
  id: z.uuid().describe('不可变核验ID'),
  jobId: z.uuid().describe('岗位'),
  jobVersionId: z.uuid().describe('审阅的岗位正文'),
  reviewVersion: z.number().int().positive().describe('审阅指针版本'),
  tree: RuleTreeSchema.describe('带证据条件树'),
  evidenceVersions: z
    .array(
      z.object({
        resourceId: z.uuid().describe('稳定来源证据资源UUID'),
        versionId: z.uuid().describe('被引用的不可变正文版本'),
      }),
    )
    .describe('完整依赖版本'),
  gaps: z.array(z.string()).describe('未解决缺口'),
  conflicts: z.array(z.string()).describe('未解决冲突'),
  reason: z.string().describe('审阅理由'),
  reviewDigest: z.string().length(64).describe('条件与观察摘要'),
  isComplete: z.boolean().describe('经领域验证的完整性'),
  verifiedAt: z.date().nullable().describe('最早依赖时间'),
  reviewedAt: z.date().describe('实际审阅'),
  actorReference: z.string().min(1).max(200).describe('服务器受信运营身份'),
});
export type ReviewState = z.infer<typeof ReviewStateSchema>;
export function ruleReferences(
  tree: RuleNode,
): z.infer<typeof EvidenceRefSchema>[] {
  return [
    ...tree.evidence,
    ...(tree.type === 'all' || tree.type === 'any'
      ? tree.children.flatMap(ruleReferences)
      : tree.type === 'except'
        ? [...ruleReferences(tree.base), ...ruleReferences(tree.exception)]
        : []),
  ];
}
function containsUnknown(tree: RuleNode): boolean {
  return (
    tree.type === 'unknown' ||
    ((tree.type === 'all' || tree.type === 'any') &&
      tree.children.some(containsUnknown)) ||
    (tree.type === 'except' &&
      (containsUnknown(tree.base) || containsUnknown(tree.exception)))
  );
}
export class RequirementReviewEntity {
  private readonly state: ReviewState;
  constructor(state: ReviewState) {
    this.state = structuredClone(ReviewStateSchema.parse(state));
  }
  static verifiedAt(
    isComplete: boolean,
    now: Date,
    observations: ObservationState[],
  ): Date | null {
    return isComplete
      ? new Date(
          Math.min(
            now.getTime(),
            ...observations.map((o) => o.fetchedAt.getTime()),
          ),
        )
      : null;
  }
  snapshot(): ReviewState {
    return structuredClone(this.state);
  }
  validateEvidence(context: {
    versions: SourceVersionEntity[];
    observations: ObservationState[];
    hasUnvisitedExternal: boolean;
  }): void {
    const s = this.state;
    for (const ref of ruleReferences(s.tree)) {
      if (
        !context.versions.some((v) => v.matches(ref)) ||
        !context.observations.some(
          (o) =>
            o.id === ref.observationId &&
            o.versionId === ref.versionId &&
            o.resourceId === ref.resourceId,
        )
      )
        throw new IngestionError('EVIDENCE_INCOMPLETE');
    }
    for (const v of context.versions) {
      const state = v.snapshot();
      if (
        !s.evidenceVersions.some(
          (e) => e.resourceId === state.resourceId && e.versionId === state.id,
        )
      )
        throw new IngestionError('EVIDENCE_VERSION_CONFLICT');
    }
    if (
      s.isComplete &&
      (s.gaps.length > 0 ||
        s.conflicts.length > 0 ||
        containsUnknown(s.tree) ||
        context.hasUnvisitedExternal ||
        context.versions.some(
          (v) =>
            !ruleReferences(s.tree).some(
              (r) => r.versionId === v.snapshot().id,
            ),
        ))
    )
      throw new IngestionError('EVIDENCE_INCOMPLETE');
  }
  isFresh(versions: SourceVersionEntity[], now: Date): boolean {
    return (
      this.state.isComplete &&
      versions.every((v) =>
        this.state.evidenceVersions.some(
          (e) =>
            e.resourceId === v.snapshot().resourceId &&
            e.versionId === v.snapshot().id,
        ),
      ) &&
      versions
        .filter((v) => v.snapshot().id === this.state.jobVersionId)
        .every((v) => v.freshness(this.state.verifiedAt, now) === 'fresh')
    );
  }
}
