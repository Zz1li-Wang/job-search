import type { SourceTaskEntity } from '../../domain/ingestion/task.js';
import type {
  SourceResourceEntity,
  SourceStreamEntity,
  EvidenceBody,
} from '../../domain/ingestion/source.js';
import type {
  SourceVersionEntity,
  RequirementReviewEntity,
  ObservationState,
} from '../../domain/ingestion/evidence.js';
import type {
  TransactionContext,
  UnitOfWork,
  IdempotencyRepository,
  PrivateFileStore,
} from '../ports.js';
import type { AccountRepository } from '../auth/ports.js';

export interface SnapshotRecord {
  id: string;
  sanitizedDigest: string;
  byteLength: number;
  format: string;
  createdAt: Date;
}
export interface JobProjection {
  id: string;
  resourceId: string;
}
export interface EvidenceLink {
  id: string;
  jobId: string;
  resourceId: string | null;
  url: string;
  relationKind: string;
  associationVersion: string;
  associationStatus: string;
}
export interface ExportEntry {
  versions: {
    versionId: string;
    materialHash: string;
    body: EvidenceBody;
    createdAt: string;
  }[];
  observations: {
    observationId: string;
    versionId: string;
    fetchedAt: string;
    httpStatus: number;
    rawDigest: string;
    parserVersion: string;
  }[];
  reviews: {
    reviewId: string;
    jobVersionId: string;
    isComplete: boolean;
    reviewedAt: string;
    verifiedAt: string | null;
    tree: import('@career/contracts').RuleNode;
    evidenceVersions: { resourceId: string; versionId: string }[];
  }[];

  resourceId: string;
  kind: 'job' | 'announcement';
  sourceId: string;
  url: string;
  versionId: string;
  body: EvidenceBody;
  fetchedAt: string | null;
  reviewedAt: string | null;
  verifiedAt: string | null;
  isComplete: boolean;
}
export interface ExportRecord {
  id: string;
  operationKey: string;
  snapshotAt: Date;
  cutoffSequence: bigint;
  scopeHash: string;
  status: 'pending' | 'completed';
  manifestDigest: string | null;
  entries: ExportEntry[];
  recordCount: number;
}
export interface AttemptRecord {
  id: string;
  taskId: string;
  attempt: number;
  token: number;
  startedAt: Date;
  endedAt: Date | null;
  resultCode: string | null;
  nextRetryAt: Date | null;
}
export interface IngestionRepository {
  now(): Promise<Date>;
  accounts: AccountRepository;
  getExecutionState(id: string): Promise<{
    userId: string;
    kind: string;
    resourceId: string | null;
    status: string;
    authEpoch: number;
    personalDataEpoch: number;
    leaseUntil: Date | null;
  } | null>;
  records: IdempotencyRepository;
  listStreams(): Promise<SourceStreamEntity[]>;
  reapExpired(now: Date, limit: number): Promise<void>;
  lockStream(key: 'new' | 'backfill'): Promise<SourceStreamEntity>;
  updateStream(stream: SourceStreamEntity, expected: number): Promise<boolean>;
  getTask(id: string, lock?: boolean): Promise<SourceTaskEntity | null>;
  findActive(dedupeKey: string): Promise<SourceTaskEntity | null>;
  insertTaskIfAbsent(task: SourceTaskEntity): Promise<SourceTaskEntity>;
  saveTask(task: SourceTaskEntity, expectedToken: number): Promise<boolean>;
  claimCandidate(
    now: Date,
    ordinary: boolean,
  ): Promise<SourceTaskEntity | null>;
  insertAttempt(attempt: AttemptRecord): Promise<void>;
  getAttempt(taskId: string, attempt: number): Promise<AttemptRecord>;
  endAttempt(attempt: AttemptRecord): Promise<void>;
  addRequester(taskId: string, userId: string): Promise<void>;
  hasRequester(taskId: string, userId: string): Promise<boolean>;
  copyRequesters(from: string, to: string): Promise<void>;
  listTasks(): Promise<SourceTaskEntity[]>;
  ensureResource(resource: SourceResourceEntity): Promise<SourceResourceEntity>;
  getResource(id: string, lock?: boolean): Promise<SourceResourceEntity | null>;
  saveResource(
    resource: SourceResourceEntity,
    expected: number,
  ): Promise<boolean>;
  listResources(): Promise<SourceResourceEntity[]>;
  ensureJob(job: JobProjection): Promise<JobProjection>;
  getJob(id: string): Promise<JobProjection | null>;
  getJobByResource(id: string): Promise<JobProjection | null>;
  listVersions(resourceId: string): Promise<SourceVersionEntity[]>;
  listObservations(resourceId: string): Promise<ObservationState[]>;
  listReviews(jobId: string): Promise<RequirementReviewEntity[]>;
  getVersion(id: string): Promise<SourceVersionEntity | null>;
  findVersion(
    resourceId: string,
    hash: string,
  ): Promise<SourceVersionEntity | null>;
  insertVersion(version: SourceVersionEntity): Promise<void>;
  insertSnapshot(snapshot: SnapshotRecord): Promise<void>;
  isSnapshotReferenced(key: string): Promise<boolean>;
  lockFile(key: string): Promise<void>;
  insertObservation(observation: ObservationState): Promise<void>;
  getObservation(id: string): Promise<ObservationState | null>;
  latestObservation(resourceId: string): Promise<ObservationState | null>;
  replaceLinks(
    jobId: string,
    versionId: string,
    links: EvidenceLink[],
  ): Promise<void>;
  listLinks(jobId: string): Promise<EvidenceLink[]>;
  listJobsLinkedTo(resourceId: string): Promise<JobProjection[]>;
  insertDraft(
    resourceId: string,
    versionId: string,
    body: EvidenceBody,
  ): Promise<void>;
  insertReview(review: RequirementReviewEntity): Promise<void>;
  getReview(id: string): Promise<RequirementReviewEntity | null>;
  findReview(
    jobId: string,
    digest: string,
  ): Promise<RequirementReviewEntity | null>;
  audit(id: string, actor: string, action: string, now: Date): Promise<void>;
  reserveBudget(id: string, limit: number): Promise<boolean>;
  budgetUsed(id: string): Promise<number>;
  reservePermit(
    host: string,
    owner: string,
    now: Date,
    gapMs: number,
  ): Promise<boolean>;
  releasePermit(owner: string): Promise<void>;
  readRobots(): Promise<{ text: string; fetchedAt: string } | null>;
  saveRobots(text: string, fetchedAt: Date): Promise<void>;
  getExport(id: string): Promise<ExportRecord | null>;
  findExport(operationKey: string): Promise<ExportRecord | null>;
  insertExport(record: ExportRecord): Promise<void>;
  saveExport(record: ExportRecord): Promise<void>;
}
export interface FetchedList {
  kind: 'list';
  jobIds: string[];
  nextPage: number | null;
  fetchedAt: Date;
}
export interface FetchedEvidence {
  kind: 'evidence';
  body: EvidenceBody;
  rawDigest: string;
  httpStatus: number;
  fetchedAt: Date;
}
export interface SourceReader {
  list(page: number): Promise<FetchedList>;
  evidence(kind: 'job' | 'announcement', id: string): Promise<FetchedEvidence>;
}
export interface SnapshotStore extends PrivateFileStore {
  listOlderThan(date: Date, limit: number): Promise<string[]>;
  exists(key: string): Promise<boolean>;
}
export interface ExportStore {
  write(id: string, content: string): Promise<void>;
  read(id: string): Promise<string>;
}
export interface IngestionDependencies {
  unitOfWork: UnitOfWork;
  repositories(context: TransactionContext): IngestionRepository;
  repeatableRead<T>(
    operation: (context: TransactionContext) => Promise<T>,
  ): Promise<T>;
  source: SourceReader;
  files: SnapshotStore;
  exports: ExportStore;
  digest(value: string): string;
  id(): string;
  now(): Date;
  jitter(): number;
  operatorReference: string;
  networkEnabled: boolean;
}
