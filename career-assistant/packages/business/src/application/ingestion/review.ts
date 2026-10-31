import type { ReviewInputDto, ReviewResultDto } from '@career/contracts';
import {
  RequirementReviewEntity,
  ruleReferences,
} from '../../domain/ingestion/evidence.js';
import { IngestionError } from '../../domain/ingestion/errors.js';
import type { IngestionDependencies } from './ports.js';
import {
  ingestionOperation,
  originalReference,
  remember,
  saveResource,
} from './support.js';
export class EvidenceReviewService {
  constructor(private readonly d: IngestionDependencies) {}
  execute(input: ReviewInputDto): Promise<ReviewResultDto> {
    return ingestionOperation(() =>
      this.d.unitOfWork.run(async (c) => {
        const repo = this.d.repositories(c);
        await repo.lockStream('new');
        const now = await repo.now();
        const job = await repo.getJob(input.jobId);
        if (!job) throw new IngestionError('INGESTION_NOT_FOUND');
        const resource = await repo.getResource(job.resourceId, true);
        if (!resource) throw new IngestionError('INGESTION_NOT_FOUND');
        const hash = this.d.digest(
          JSON.stringify({
            ...input,
            expectedReviewVersion: undefined,
            operationKey: undefined,
          }),
        );
        const requestHash = this.d.digest(
          JSON.stringify({ ...input, operationKey: undefined }),
        );
        const original = await originalReference(
          repo,
          'operator:review',
          input.operationKey,
          requestHash,
        );
        if (resource.snapshot().currentVersionId !== input.expectedJobVersion)
          throw new IngestionError('EVIDENCE_VERSION_CONFLICT');
        for (const dependency of input.evidenceVersions) {
          const current = await repo.getResource(dependency.resourceId);
          if (
            !current ||
            current.snapshot().currentVersionId !== dependency.versionId
          )
            throw new IngestionError('EVIDENCE_VERSION_CONFLICT');
        }
        const previous = original
          ? await repo.getReview(original)
          : await repo.findReview(input.jobId, hash);
        if (previous) {
          const s = previous.snapshot();
          return {
            reviewId: s.id,
            reviewVersion: s.reviewVersion,
            reviewedAt: s.reviewedAt.toISOString(),
            isComplete: s.isComplete,
            warnings: s.gaps,
          };
        }
        if (
          resource.snapshot().currentVersionId !== input.expectedJobVersion ||
          resource.snapshot().reviewVersion !== input.expectedReviewVersion
        )
          throw new IngestionError('EVIDENCE_VERSION_CONFLICT');
        const links = await repo.listLinks(job.id);
        const resourceIds = [
          ...new Set([
            job.resourceId,
            ...links.flatMap((link) =>
              link.resourceId ? [link.resourceId] : [],
            ),
          ]),
        ].sort();
        const versions = [];
        for (const id of resourceIds) {
          const item = await repo.getResource(id, true);
          if (!item?.snapshot().currentVersionId) {
            if (input.isComplete)
              throw new IngestionError('EVIDENCE_INCOMPLETE');
            continue;
          }
          const version = await repo.getVersion(
            item.snapshot().currentVersionId!,
          );
          if (!version) throw new IngestionError('EVIDENCE_INCOMPLETE');
          versions.push(version);
        }
        const observations = [];
        for (const ref of ruleReferences(input.tree)) {
          const observation = await repo.getObservation(ref.observationId);
          if (!observation) throw new IngestionError('EVIDENCE_INCOMPLETE');
          observations.push(observation);
        }
        const verifiedAt = RequirementReviewEntity.verifiedAt(
          input.isComplete,
          now,
          observations,
        );
        const review = new RequirementReviewEntity({
          id: this.d.id(),
          jobId: job.id,
          jobVersionId: input.expectedJobVersion,
          reviewVersion: input.expectedReviewVersion + 1,
          tree: input.tree,
          evidenceVersions: input.evidenceVersions,
          gaps: input.gaps,
          conflicts: input.conflicts,
          reason: input.reason,
          reviewDigest: hash,
          isComplete: input.isComplete,
          verifiedAt,
          reviewedAt: now,
          actorReference: this.d.operatorReference,
        });
        review.validateEvidence({
          versions,
          observations,
          hasUnvisitedExternal: links.some(
            (link) => link.relationKind === 'external',
          ),
        });
        const updated = resource.reviewed(
          review.snapshot().id,
          input.expectedReviewVersion,
        );
        await repo.insertReview(review);
        await saveResource(repo, updated, resource.snapshot().stateVersion);
        await repo.audit(
          this.d.id(),
          this.d.operatorReference,
          'source_evidence_reviewed',
          now,
        );
        await remember(
          repo,
          'operator:review',
          input.operationKey,
          requestHash,
          review.snapshot().id,
          now,
        );
        return {
          reviewId: review.snapshot().id,
          reviewVersion: review.snapshot().reviewVersion,
          reviewedAt: now.toISOString(),
          isComplete: input.isComplete,
          warnings: input.gaps,
        };
      }),
    );
  }
}
