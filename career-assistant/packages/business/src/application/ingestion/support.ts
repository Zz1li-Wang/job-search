import type { TaskDto, ActorDto } from '@career/contracts';
import { IngestionError } from '../../domain/ingestion/errors.js';
import type { SourceTaskEntity } from '../../domain/ingestion/task.js';
import { SourceResourceEntity } from '../../domain/ingestion/source.js';
import {
  IdempotencyRecord,
  IdempotencyConflictError,
} from '../../domain/idempotency.js';
import { AuthError } from '../../domain/auth/errors.js';
import { INGESTION_POLICY } from '../../domain/ingestion/policy.js';
import type { IngestionDependencies, IngestionRepository } from './ports.js';
export async function ingestionOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IngestionError || error instanceof AuthError)
      throw error;
    if (error instanceof IdempotencyConflictError)
      throw new IngestionError('IDEMPOTENCY_CONFLICT');
    const failure = new IngestionError('INGESTION_STORAGE_UNAVAILABLE');
    failure.cause = error;
    throw failure;
  }
}
export function taskDto(task: SourceTaskEntity): TaskDto {
  const s = task.snapshot();
  return {
    id: s.id,
    kind: s.kind,
    status: s.status,
    attempt: s.attempt,
    updatedAt: s.updatedAt.toISOString(),
    relatedResourceId: s.resourceReference,
    ...(s.errorCode ? { errorCode: s.errorCode } : {}),
    ...(s.status === 'retry_wait'
      ? { nextRetryAt: s.availableAt.toISOString() }
      : {}),
    ...(s.successorTaskId ? { successorTaskId: s.successorTaskId } : {}),
  };
}
export async function assertActor(repo: IngestionRepository, actor: ActorDto) {
  const account = await repo.accounts.getForUpdate(actor.userId);
  if (!account) throw new AuthError('AUTH_UNAUTHENTICATED');
  account.assertActive();
  account.assertEpoch(actor.authEpoch);
  if (
    actor.personalDataEpoch !== undefined &&
    actor.personalDataEpoch !== account.snapshot().personalDataEpoch
  )
    throw new AuthError('AUTH_CONTEXT_STALE');
  if (actor.execution) {
    const execution = await repo.getExecutionState(actor.execution.runId);
    const epoch = account.snapshot().personalDataEpoch;
    if (
      !execution ||
      execution.userId !== actor.userId ||
      execution.kind !== actor.execution.kind ||
      execution.resourceId !== actor.execution.resourceId ||
      execution.status !== 'running' ||
      execution.authEpoch !== actor.authEpoch ||
      execution.personalDataEpoch !== epoch ||
      epoch !== actor.execution.personalDataEpoch ||
      !execution.leaseUntil ||
      execution.leaseUntil <= (await repo.now())
    )
      throw new AuthError('AUTH_UNAUTHENTICATED');
  }
}
export async function originalReference(
  repo: IngestionRepository,
  scope: string,
  key: string,
  hash: string,
): Promise<string | null> {
  const record = await repo.records.getRecord(scope, key);
  if (!record) return null;
  record.assertSameRequest(hash);
  return record.snapshot().responseReference;
}
export async function remember(
  repo: IngestionRepository,
  scope: string,
  key: string,
  hash: string,
  reference: string,
  now: Date,
): Promise<string> {
  const result = await repo.records.insertIfAbsent(
    new IdempotencyRecord({
      scope,
      key,
      requestHash: hash,
      responseReference: reference,
      createdAt: now,
    }),
  );
  result.record.assertSameRequest(hash);
  return result.record.snapshot().responseReference;
}
export async function ensureResource(
  repo: IngestionRepository,
  d: IngestionDependencies,
  kind: 'job' | 'announcement',
  sourceId: string,
  now: Date,
) {
  const resource = await repo.ensureResource(
    new SourceResourceEntity({
      id: d.id(),
      kind,
      sourceId,
      canonicalUrl: `${INGESTION_POLICY.origin}/${kind === 'job' ? 'jobs' : 'announcements'}/${sourceId}`,
      currentVersionId: null,
      lastAttemptAt: null,
      lastFetchedAt: null,
      nextRefreshAt: now,
      reviewVersion: 0,
      currentReviewId: null,
      stateVersion: 0,
    }),
  );
  if (kind === 'job')
    await repo.ensureJob({ id: d.id(), resourceId: resource.snapshot().id });
  return resource;
}
export async function saveTask(
  repo: IngestionRepository,
  task: SourceTaskEntity,
  token = task.snapshot().fencingToken,
) {
  if (!(await repo.saveTask(task, token)))
    throw new IngestionError('TASK_VERSION_CONFLICT');
}
export async function saveResource(
  repo: IngestionRepository,
  resource: SourceResourceEntity,
  expected: number,
) {
  if (!(await repo.saveResource(resource, expected)))
    throw new IngestionError('EVIDENCE_VERSION_CONFLICT');
}
