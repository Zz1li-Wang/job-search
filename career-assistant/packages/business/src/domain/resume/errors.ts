import { BusinessError } from '../shared/errors.js';
/** 只携带Schema字段路径与固定分类，便于诊断依据失败，禁止携带字段值或原文。 */
export class ExtractionEvidenceError extends BusinessError {
  constructor(
    /** 已校验画像中的字段路径，不包含字段值。 */
    readonly fieldPath: string,
    /** 缺依据、引用无法定位、引用不支持事实，或模型擅自声明完整。 */
    readonly reason:
      | 'missing_reference'
      | 'excerpt_not_found'
      | 'value_not_supported'
      | 'unconfirmed_completeness',
  ) {
    super('INVALID_EVIDENCE');
  }
}
