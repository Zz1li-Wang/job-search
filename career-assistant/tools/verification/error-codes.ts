/** 稳定拒绝码和恢复动作；集中维护，调用方不得按错误描述字符串重试。 */
export const ProbeErrorCode = {
  /** 预算不是1—20整数；调用方修正参数，不能继续联网。 */
  InvalidRequestBudget: "invalid_request_budget",
  /** URL不在允许来源内；拒绝，不能跟随重定向。 */
  SourceUrlForbidden: "source_url_forbidden",
  /** 请求额度耗尽；停止，扩额需另行确认。 */
  SourceBudgetExhausted: "source_budget_exhausted",
  /** 源响应超过大小限制；取消流，不作完整证据。 */
  SourceBodyTooLarge: "source_body_too_large",
  /** 请求超时；记录未验证，不把旧证据刷新为成功。 */
  SourceTimeout: "source_timeout",
  /** 网络或响应不可获取；报告缺口，不无限重试。 */
  SourceUnavailable: "source_unavailable",
  /** ZIP结构或必需文档缺失；拒绝，用户换文件。 */
  InvalidDocx: "invalid_docx",
  /** DOCX解压资源超限；拒绝，不能继续解压。 */
  DocxResourceLimit: "docx_resource_limit",
  /** 文件字节超限；拒绝，用户缩小文件。 */
  DocumentTooLarge: "document_too_large",
  /** 文件名和内容签名不符；拒绝，不能猜格式。 */
  DocumentSignatureMismatch: "document_signature_mismatch",
  /** PDF需要密码；本验证不解密，用户提供文本版本。 */
  EncryptedPdf: "encrypted_pdf",
  /** PDF结构无效；拒绝，用户重新导出。 */
  InvalidPdf: "invalid_pdf",
  /** PDF页数超限；拒绝，用户裁剪后重传。 */
  DocumentPageLimit: "document_page_limit",
  /** TXT不是合法UTF-8；拒绝，用户转换编码。 */
  InvalidTextEncoding: "invalid_text_encoding",
  /** 格式不在PDF/DOCX/TXT内；不隐式OCR或转换。 */
  DocumentFormatUnsupported: "document_format_unsupported",
  /** 没有文字层；拒绝，提供文字版而不是假装识别成功。 */
  NoExtractableText: "no_extractable_text",
  /** 提取字符过多；拒绝，不能继续进入模型。 */
  DocumentCharacterLimit: "document_character_limit",
  /** 未归类提取失败；记录失败，不能报能力通过。 */
  UnexpectedExtractionFailure: "unexpected_extraction_failure",
  /** 原报告结构损坏；人工检查，不自动重新调用外部系统。 */
  InvalidSavedReport: "invalid_saved_report",
  /** 相同runId正在执行或上次中断；检查锁，不自动抢占。 */
  ProbeRunConflict: "probe_run_conflict",
  /** 相同runId参数不同；使用新ID，不覆盖原报告。 */
  ProbeRunPayloadConflict: "probe_run_payload_conflict",
} as const;
