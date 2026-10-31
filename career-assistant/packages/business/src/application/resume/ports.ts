import type { PrivacyRepository } from '../privacy/ports.js';
import type {
  ResumeEntity,
  ProfileDraftEntity,
} from '../../domain/resume/entities.js';
import type { ConfirmedProfileEntity } from '../../domain/jobs/entities.js';
import type { ChatDependencies } from '../chat/ports.js';
import type { PrivateFileStore, TransactionContext } from '../ports.js';
import type {
  TextSpan,
  ExtractionInputDto,
  ExtractionResultDto,
} from '@career/contracts';
export interface ResumeRepository {
  get(
    id: string,
    userId: string,
    includeDeleted?: boolean,
  ): Promise<ResumeEntity | null>;
  list(userId: string): Promise<ResumeEntity[]>;
  findHash(userId: string, hash: string): Promise<ResumeEntity | null>;
  insert(entity: ResumeEntity): Promise<void>;
  save(entity: ResumeEntity): Promise<void>;
  nextQueued(): Promise<ResumeEntity | null>;
  listExpired(now: Date): Promise<ResumeEntity[]>;
  deleteDraftsByResume(resumeId: string, userId: string): Promise<void>;
  getDraft(id: string, userId: string): Promise<ProfileDraftEntity | null>;
  insertDraft(entity: ProfileDraftEntity): Promise<void>;
  saveDraft(entity: ProfileDraftEntity): Promise<void>;
  getProfile(userId: string): Promise<ConfirmedProfileEntity | null>;
  saveProfile(entity: ConfirmedProfileEntity): Promise<void>;
  registerFileDeletion(key: string, userId: string, now: Date): Promise<void>;
  nextFileDeletion(now: Date): Promise<{
    id: string;
    key: string;
    userId: string;
  } | null>;
  finishFileDeletion(id: string, now: Date): Promise<void>;
}
export interface ResumeDependencies extends ChatDependencies {
  resumes(context: TransactionContext): ResumeRepository;
  privacy(context: TransactionContext): PrivacyRepository;
  files: PrivateFileStore;
  extract(
    bytes: Uint8Array,
    format: 'pdf' | 'docx' | 'txt',
  ): Promise<TextSpan[]>;
  extractProfile(input: ExtractionInputDto): Promise<ExtractionResultDto>;
}
