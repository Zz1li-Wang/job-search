import { BusinessError } from '../shared/errors.js';
export type DeletionScope = 'profile' | 'personal' | 'account';
export type PrivateCollection =
  | 'profile'
  | 'drafts'
  | 'checks'
  | 'resumes'
  | 'conversations'
  | 'runs'
  | 'favorites'
  | 'applications';
/** 删除计划明确本地撤销与文件补偿分界；公共岗位不属于个人数据。 */
export class PrivacyDecision {
  constructor(readonly scope: DeletionScope) {}
  assertConfirmation(confirmation: string) {
    const expected = {
      profile: 'CLEAR_PROFILE',
      personal: 'CLEAR_PERSONAL_DATA',
      account: 'DELETE_ACCOUNT',
    };
    if (expected[this.scope] !== confirmation)
      throw new BusinessError('INVALID_TRANSITION');
  }
  collections(): PrivateCollection[] {
    return this.scope === 'profile'
      ? ['profile', 'drafts', 'checks']
      : [
          'profile',
          'drafts',
          'checks',
          'resumes',
          'conversations',
          'runs',
          'favorites',
          'applications',
        ];
  }
  requiresPassword() {
    return this.scope === 'account';
  }
  removesFiles() {
    return this.scope !== 'profile';
  }
}
export interface DeletionRecord {
  id: string;
  userId: string;
  scope: DeletionScope | 'resume';
  requestedAt: Date;
}
