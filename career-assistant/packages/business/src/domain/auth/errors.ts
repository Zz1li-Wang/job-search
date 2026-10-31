import type { AuthErrorCode } from '@career/contracts';

/** 错误描述不携带协议状态或输入凭据，HTTP映射属于API适配器。 */
export const AUTH_ERROR_MESSAGES: Readonly<Record<AuthErrorCode, string>> =
  Object.freeze({
    // 挑战无效、到期、已用或不属于浏览器；需获取新图片。
    AUTH_INVALID_CAPTCHA: '验证码无效，请刷新后重试',
    // 真实或虚拟密码验证失败；统一提示不区分账号存在性。
    AUTH_INVALID_CREDENTIALS: '账号或密码不正确',
    // 会话或账号已失效；必须重新登录。
    AUTH_UNAUTHENTICATED: '登录已失效，请重新登录',
    // 唯一用户名冲突；更换或转到登录，不返回他人资料。
    AUTH_USERNAME_CONFLICT: '用户名已被使用，请更换或登录',
    // 运算期间密码版本变化；拒绝覆盖，需重新登录。
    AUTH_VERSION_CONFLICT: '账号状态已变化，请重新登录',
    // 删除前已认证的请求迟到；刷新页面后重新发起，保留现有登录。
    AUTH_CONTEXT_STALE: '个人资料已清空或重置，请刷新后重新操作',
    // 限流、冷却或计算队列已满；应等待后获取新挑战。
    AUTH_RATE_LIMITED: '请求过于频繁，请稍后重试',
    // 安全端口或数据库失败；不能推断前序事务未提交。
    AUTH_DEPENDENCY_UNAVAILABLE: '认证服务暂不可用，请稍后重试',
  });
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(AUTH_ERROR_MESSAGES[code]);
  }
}
