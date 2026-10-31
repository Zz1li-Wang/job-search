/** 稳定失败分类与恢复动作；协议状态由入口层映射。 */
export const INGESTION_ERRORS = {
  // 登录、robots或来源访问约束拒绝；修正配置后显式恢复。
  SOURCE_ACCESS_BLOCKED: '来源访问受限，请更新合法访问配置后显式恢复',
  // 原子预算无余额；需获得追加额度后恢复。
  SOURCE_BUDGET_EXHAUSTED: '来源预算已用完，请配置获准额度后恢复',
  // 来源返回429；等待Retry-After和退避。
  SOURCE_RATE_LIMITED: '来源限流，请等待重试时间',
  // 正文、列表或格式不支持；修正适配器后重试。
  SOURCE_PARSE_UNSUPPORTED: '来源页面无法识别，请修正解析适配后恢复',
  // 网络超时或来源5xx；有限自动重试。
  SOURCE_UNAVAILABLE: '来源暂不可用，请稍后重试',
  // 任务状态、attempt或租约token已变化；重新读取。
  TASK_VERSION_CONFLICT: '任务或租约已变化，请重新读取',
  // 当前正文或核验版本与审阅依赖不符；重新审阅。
  EVIDENCE_VERSION_CONFLICT: '证据版本已变化，请重新审阅',
  // 引用不匹配或完整材料不足；补齐或声明不完整。
  EVIDENCE_INCOMPLETE: '证据不足，请补齐或保存不完整核验',
  // 同键对应不同内容；为新操作使用新键。
  IDEMPOTENCY_CONFLICT: '同一操作键内容不同，请为新操作使用新键',
  // 资源不存在或不属于请求身份；不泄漏他人存在性。
  INGESTION_NOT_FOUND: '资源不存在或不可访问',
  // 用户或岗位刷新限额已达；等待后再请求。
  INGESTION_RATE_LIMITED: '刷新过于频繁，请稍后重试',
  // 文件或数据库失败；根据任务状态有限重试。
  INGESTION_STORAGE_UNAVAILABLE: '采集存储暂不可用，请稍后重试',
} as const;
export type IngestionErrorCode = keyof typeof INGESTION_ERRORS;
export class IngestionError extends Error {
  constructor(
    readonly code: IngestionErrorCode,
    readonly retryAfterMs?: number,
  ) {
    super(INGESTION_ERRORS[code]);
  }
}
