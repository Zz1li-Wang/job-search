import { z } from 'zod';
import {
  ProfileContentSchema,
  EligibilityCheckItemSchema,
  type ProfileContent,
} from '@career/contracts';
import { IngestionError } from '../ingestion/errors.js';
export const ProfileStateSchema = z.object({
  userId: z.uuid().describe('画像所有者'),
  version: z.number().int().positive().describe('正式确认版本'),
  content: ProfileContentSchema.describe('经过确认的事实值对象'),
  confirmedAt: z.date().describe('显式确认时间'),
  updatedAt: z.date().describe('版本变化时间'),
});
export type ProfileState = z.infer<typeof ProfileStateSchema>;
export class ConfirmedProfileEntity {
  private readonly state: ProfileState;
  constructor(state: ProfileState) {
    this.state = structuredClone(ProfileStateSchema.parse(state));
  }
  snapshot(): ProfileState {
    return structuredClone(this.state);
  }
  replace(
    content: ProfileContent,
    expected: number,
    now: Date,
  ): ConfirmedProfileEntity {
    if (this.state.version !== expected)
      throw new IngestionError('EVIDENCE_VERSION_CONFLICT');
    return new ConfirmedProfileEntity({
      ...this.state,
      content,
      version: expected + 1,
      confirmedAt: now,
      updatedAt: now,
    });
  }
}
export const CheckDecisionStateSchema = z.object({
  checkId: z.uuid().describe('核验标识'),
  status: z
    .enum(['eligible', 'not_eligible', 'pending'])
    .describe('领域三态结论'),
  checks: z.array(EligibilityCheckItemSchema).describe('逐节点解释值对象'),
  jobId: z.uuid().describe('岗位'),
  jobVersionId: z.uuid().describe('正文版本'),
  profileVersion: z.number().int().nonnegative().describe('画像版本'),
  reviewVersion: z.number().int().nonnegative().describe('核验版本'),
  evidenceDependencyHash: z.string().describe('来源依赖'),
  rulesVersion: z.string().describe('规则版本'),
  evaluatedAt: z.string().describe('首次计算时间'),
  isCurrent: z.boolean().describe('当前依赖判断'),
  invalidatedReasons: z.array(z.string()).describe('失效原因'),
  warnings: z.array(z.string()).describe('领域限制'),
});
export type CheckDecisionState = z.infer<typeof CheckDecisionStateSchema>;
export interface CheckState {
  id: string;
  userId: string;
  jobId: string;
  jobVersionId: string;
  profileVersion: number;
  reviewVersion: number;
  dependencyHash: string;
  rulesVersion: string;
  evaluatedAt: Date;
  decision: CheckDecisionState;
}
/** 私有核验快照与当前依赖分开；读取不能把历史计算伪装成新结果。 */
export class EligibilityCheckEntity {
  private readonly state: CheckState;
  constructor(state: CheckState) {
    this.state = structuredClone({
      ...state,
      decision: CheckDecisionStateSchema.parse(state.decision),
    });
  }
  snapshot(): CheckState {
    return structuredClone(this.state);
  }
  output(current: {
    jobVersionId: string;
    profileVersion: number;
    reviewVersion: number;
    dependencyHash: string;
    rulesVersion: string;
    isFresh: boolean;
  }): CheckDecisionState {
    const s = this.state;
    const reasons: string[] = [];
    if (s.jobVersionId !== current.jobVersionId) reasons.push('岗位正文已变化');
    if (s.profileVersion !== current.profileVersion)
      reasons.push('正式画像已变化');
    if (
      s.reviewVersion !== current.reviewVersion ||
      s.dependencyHash !== current.dependencyHash
    )
      reasons.push('核验或关联证据已变化');
    if (s.rulesVersion !== current.rulesVersion) reasons.push('规则版本已变化');
    if (!current.isFresh) reasons.push('证据或报名时间需要复查');
    return {
      ...s.decision,
      isCurrent: reasons.length === 0,
      invalidatedReasons: reasons,
    };
  }
}
