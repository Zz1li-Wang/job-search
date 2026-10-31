import { z } from 'zod';

export const ChallengeStateSchema = z.object({
  id: z.uuid().describe('验证码挑战标识'),
  visitorDigest: z
    .string()
    .regex(/^[a-f\d]{64}$/)
    .describe('所属浏览器访客摘要'),
  answerDigest: z
    .string()
    .regex(/^[a-f\d]{64}$/)
    .describe('绑定挑战ID的答案摘要，不保存答案'),
  expiresAt: z.date().describe('挑战到期时间'),
  consumedAt: z.date().nullable().describe('首次校验尝试时刻'),
  createdAt: z.date().describe('挑战创建时间'),
});
export type ChallengeState = z.infer<typeof ChallengeStateSchema>;
export class ChallengeEntity {
  private readonly state: ChallengeState;
  constructor(state: ChallengeState) {
    this.state = structuredClone(ChallengeStateSchema.parse(state));
  }
  snapshot(): ChallengeState {
    return {
      ...this.state,
      expiresAt: new Date(this.state.expiresAt),
      createdAt: new Date(this.state.createdAt),
      consumedAt: this.state.consumedAt
        ? new Date(this.state.consumedAt)
        : null,
    };
  }
  evaluate(
    isOwner: boolean,
    isAnswerCorrect: boolean,
    now: Date,
  ): { challenge: ChallengeEntity; shouldPersist: boolean; isValid: boolean } {
    if (!isOwner || this.state.consumedAt)
      return { challenge: this, shouldPersist: false, isValid: false };
    return {
      challenge: new ChallengeEntity({ ...this.state, consumedAt: now }),
      shouldPersist: true,
      isValid: this.state.expiresAt > now && isAnswerCorrect,
    };
  }
}
