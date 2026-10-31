import type { RunEventPayload, ActorDto } from '@career/contracts';
import type { ChatDependencies } from './ports.js';
import type { TransactionContext } from '../ports.js';
import { BusinessError } from '../../domain/shared/errors.js';
import { JobQueryService, EligibilityService } from '../jobs/services.js';
/** 回调不信任模型提供的版本与资格卡片，在保存事件的同一事务重查。 */
export async function validateRunEvidence(
  d: ChatDependencies,
  c: TransactionContext,
  payload: RunEventPayload,
  actor: ActorDto,
): Promise<RunEventPayload> {
  const citations =
    payload.type === 'citation'
      ? [payload.citation]
      : payload.type === 'completed'
        ? payload.citations
        : [];
  const source = d.source(c);
  if (citations.length || payload.type === 'job_cards')
    await source.lockStream('new');
  for (const citation of citations) {
    const resource = await source.getResource(citation.resourceId),
      observation = await source.getObservation(citation.observationId),
      version = await source.getVersion(citation.versionId);
    if (
      !resource ||
      !observation ||
      !version ||
      resource.snapshot().canonicalUrl !== citation.sourceUrl ||
      observation.resourceId !== citation.resourceId ||
      observation.versionId !== citation.versionId ||
      version.snapshot().resourceId !== citation.resourceId
    )
      throw new BusinessError('INVALID_EVIDENCE');
  }
  if (payload.type === 'job_cards') {
    const dependencies = {
        ...d,
        repositories: d.jobRepositories,
        repeatableRead: <T>(
          operation: (context: TransactionContext) => Promise<T>,
        ) => d.unitOfWork.run(operation),
      },
      service = new EligibilityService(
        dependencies,
        new JobQueryService(dependencies),
      );
    const cards = [];
    for (const card of payload.cards) {
      if (!card.checkId) throw new BusinessError('INVALID_EVIDENCE');
      const check = await service.readWithinTransaction(c, card.checkId, actor);
      if (
        check.jobId !== card.jobId ||
        (check.isCurrent && check.status !== card.status)
      )
        throw new BusinessError('INVALID_EVIDENCE');
      cards.push({
        ...card,
        status: check.isCurrent ? check.status : ('pending' as const),
      });
    }
    return { type: 'job_cards', cards };
  }
  return payload;
}
