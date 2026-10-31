/** 跨服务共享的固定执行边界；工具上限变化须同步数据库CHECK与授权Schema。 */
export const EXECUTION_POLICY = Object.freeze({
  /** 同一运行包含失败在内的工具调用上限。 */
  maxToolCalls: 25,
  /** Agent推理与工具循环的总时限。 */
  agentTimeoutMs: 120000,
  /** 后端运行及短期授权的最长有效租约。 */
  runLeaseMs: 150000,
  /** 单次工具请求最长等待。 */
  toolTimeoutMs: 10000,
  /** 模型响应回调确认最长等待。 */
  callbackTimeoutMs: 5000,
  /** 派发接收确认超时，不意味着未计费。 */
  dispatchTimeoutMs: 10000,
  /** 取消仅尽力通知，不延长本地授权。 */
  cancelTimeoutMs: 2000,
  /** 本轮历史文字预算，按字符限制。 */
  historyCharacters: 28000,
  /** 单条历史与正式画像摘要的文字预算。 */
  contextEntryCharacters: 12000,
  /** 单次模型请求的序列化输入上限。 */
  modelInputCharacters: 120000,
  /** 单次模型输出文字上限。 */
  modelOutputCharacters: 50000,
  /** 单次模型流的网络字节上限。 */
  modelResponseBytes: 1000000,
  /** 限制单次模型生成长度。 */
  modelOutputTokens: 4096,
});
/** 文件解析及崩溃回收的固定资源边界。 */
export const RESUME_POLICY = Object.freeze({
  /** 上传字节上限，10MiB。 */
  maxFileBytes: 10 * 1024 * 1024,
  /** 文本PDF页数上限，不包含OCR。 */
  maxPages: 30,
  /** 进入模型前的本地提取字符上限。 */
  maxCharacters: 50000,
  /** DOCX ZIP条目数上限。 */
  maxZipEntries: 2048,
  /** DOCX累计解压字节上限。 */
  maxUncompressedBytes: 30 * 1024 * 1024,
  /** 孤立预存文件保留回收凭据，避免正在提交时被清理。 */
  orphanCleanupDelayMs: 3600000,
});
/** 协议正文上限覆盖合法中文UTF-8请求，同时保持传输有界。 */
export const HTTP_BODY_POLICY = Object.freeze({
  /** 业务JSON允许完整画像及五万字中文简历；附件另受multipart限制。 */
  apiJsonBytes: 2 * 1024 * 1024,
  /** 内部Agent契约最多30条有界上下文，不接受无限正文。 */
  agentJsonBytes: 8 * 1024 * 1024,
});
