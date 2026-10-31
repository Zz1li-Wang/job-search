/** 业务错误不携带HTTP状态；入口层按代码映射协议。 */
export const BUSINESS_MESSAGES = {
  INVALID_CURSOR: '分页信息无效或已过期，请重置列表',
  VERSION_CONFLICT: '资料已变化，请重新读取后操作',
  NOT_FOUND: '记录不存在或不可访问',
  IDEMPOTENCY_CONFLICT: '同一操作键对应不同内容，请使用新键',
  CONVERSATION_BUSY: '会话正在回复，请等待完成或取消',
  INVALID_TRANSITION: '当前状态不允许该操作',
  TOOL_UNAUTHORIZED: '工具授权无效或已撤销',
  MODEL_UNAVAILABLE: '模型服务暂不可用，请稍后显式重试',
  MODEL_INTERRUPTED: '模型执行结果未知，请确认后再重试',
  MODEL_OUTPUT_INVALID: '模型返回的结构或字段格式无效，请核对资料或显式重试',
  TOOL_BUDGET_EXHAUSTED: '本轮工具次数已达上限',
  FILE_UNSUPPORTED: '仅支持文本PDF、DOCX和UTF-8 TXT',
  FILE_INVALID: '文件内容与格式不符或已损坏',
  FILE_TOO_LARGE: '文件或提取内容超过限制',
  FILE_ENCRYPTED: 'PDF已加密，请先解密或粘贴文字',
  FILE_NO_TEXT: '未提取到可用文字，请使用文本文件或粘贴文字',
  INVALID_EVIDENCE: '抽取依据与文件原文不匹配，请检查草稿',
  DEPENDENCY_UNAVAILABLE: '服务依赖暂不可用，请稍后重试',
  RATE_LIMITED: '请求过于频繁，请稍后重试',
} as const;
export type BusinessCode = keyof typeof BUSINESS_MESSAGES;
export class BusinessError extends Error {
  constructor(readonly code: BusinessCode) {
    super(BUSINESS_MESSAGES[code]);
  }
}
