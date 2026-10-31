import { AuthError } from '../../domain/auth/errors.js';
import {
  RunGrantClaimsSchema,
  type RunGrantClaims,
  type ActorDto,
  type ToolName,
} from '@career/contracts';
import type { ChatDependencies, ChatRepository } from './ports.js';
import type { AgentRunEntity } from '../../domain/chat/entities.js';
import { BusinessError } from '../../domain/shared/errors.js';
import { assertActor } from '../ingestion/support.js';
export const CHAT_TOOLS: ToolName[] = [
  'get_profile',
  'search_jobs',
  'get_job_evidence',
  'evaluate_eligibility',
  'request_job_refresh',
  'get_task_status',
  'read_resume',
  'propose_profile_update',
];
export function signRunGrant(
  d: Pick<ChatDependencies, 'tokens'>,
  run: AgentRunEntity,
  tools: ToolName[] = CHAT_TOOLS,
) {
  const s = run.snapshot();
  const claims = RunGrantClaimsSchema.parse({
    userId: s.userId,
    runId: s.id,
    authEpoch: s.authEpoch,
    personalDataEpoch: s.personalDataEpoch,
    kind: s.kind,
    resourceId: s.resourceId,
    tools,
    expiresAt: s.leaseUntil?.getTime(),
  });
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${encoded}.${d.tokens.digest('run-grant', encoded)}`;
}
export function verifyRunGrant(
  d: Pick<ChatDependencies, 'tokens' | 'now'>,
  grant: string,
): RunGrantClaims {
  try {
    if (grant.length > 5000) throw Error();
    const [encoded, signature, extra] = grant.split('.');
    if (
      !encoded ||
      !signature ||
      extra ||
      !d.tokens.matches(signature, d.tokens.digest('run-grant', encoded))
    )
      throw Error();
    const claims = RunGrantClaimsSchema.parse(
      JSON.parse(Buffer.from(encoded, 'base64url').toString()),
    );
    if (claims.expiresAt <= d.now().getTime()) throw Error();
    return claims;
  } catch {
    throw new BusinessError('TOOL_UNAUTHORIZED');
  }
}
export async function assertGrantRun(
  repo: ChatRepository,
  claims: RunGrantClaims,
  now: Date,
) {
  const run = await repo.getRun(claims.runId, true),
    s = run?.snapshot();
  const user = await repo.getUserEpoch(claims.userId);
  if (
    !run ||
    !s ||
    !user ||
    user.deletedAt ||
    s.userId !== claims.userId ||
    s.kind !== claims.kind ||
    s.resourceId !== claims.resourceId
  )
    throw new BusinessError('TOOL_UNAUTHORIZED');
  run.assertWritable(user.authEpoch, user.personalDataEpoch, now);
  if (
    claims.authEpoch !== user.authEpoch ||
    claims.personalDataEpoch !== user.personalDataEpoch
  )
    throw new BusinessError('TOOL_UNAUTHORIZED');
  return run;
}
export class ToolAuthorizationService {
  constructor(private readonly d: ChatDependencies) {}
  async authorize(
    grant: string,
    tool?: ToolName,
  ): Promise<{ actor: ActorDto; tools: ToolName[] }> {
    const claims = verifyRunGrant(this.d, grant);
    try {
      return await this.d.unitOfWork.run(async (c) => {
        const actor: ActorDto = {
          userId: claims.userId,
          authEpoch: claims.authEpoch,
          sessionId: null,
          execution: {
            runId: claims.runId,
            kind: claims.kind,
            personalDataEpoch: claims.personalDataEpoch,
            resourceId: claims.resourceId,
          },
        };
        await assertActor(this.d.source(c), actor);
        const repo = this.d.repositories(c);
        await assertGrantRun(repo, claims, this.d.now());
        if (tool) {
          if (!claims.tools.includes(tool))
            throw new BusinessError('TOOL_UNAUTHORIZED');
          if (!(await repo.consumeTool(claims.runId)))
            throw new BusinessError('TOOL_BUDGET_EXHAUSTED');
        }
        return { actor, tools: claims.tools };
      });
    } catch (error) {
      if (error instanceof AuthError)
        throw new BusinessError('TOOL_UNAUTHORIZED');
      throw error;
    }
  }
}
