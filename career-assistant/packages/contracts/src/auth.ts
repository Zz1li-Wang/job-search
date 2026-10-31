import { z } from 'zod';

const CredentialSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .describe('仅内部安全上下文使用的不透明凭据');
const DigestSchema = z
  .string()
  .regex(/^[a-f\d]{64}$/)
  .describe('带用途区分的HMAC摘要');
export const UsernameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]{3,32}$/)
  .describe('3至32位ASCII字母数字下划线，输出规范化为小写');
export const PasswordSchema = z
  .string()
  .refine((value) => {
    const length = Array.from(value).length;
    return (
      length >= 12 &&
      length <= 128 &&
      new TextEncoder().encode(value).length <= 512
    );
  })
  .describe('12至128个Unicode码点、UTF-8最多512字节，不裁剪或归一化');
export const RegisterInputSchema = z.strictObject({
  username: UsernameSchema,
  password: PasswordSchema,
  captchaId: z.uuid().describe('本浏览器获取的验证码挑战ID'),
  captchaAnswer: z
    .string()
    .regex(/^[2-9]{6}$/)
    .describe('图片中的六位数字'),
});
export const LoginInputSchema = RegisterInputSchema;
export type RegisterInputDto = z.infer<typeof RegisterInputSchema>;
export type LoginInputDto = z.infer<typeof LoginInputSchema>;
export const PasswordInputSchema = z.strictObject({
  currentPassword: PasswordSchema.describe('当前密码'),
  newPassword: PasswordSchema.describe(
    '新密码，允许与当前相同但仍撤销全部会话',
  ),
});
export type PasswordInputDto = z.infer<typeof PasswordInputSchema>;
export const CaptchaSchema = z.strictObject({
  captchaId: z.uuid().describe('独立验证码挑战标识'),
  imageDataUrl: z
    .string()
    .startsWith('data:image/png;base64,')
    .max(160 * 1024)
    .describe('真实PNG，无答案文本元数据'),
  expiresAt: z.iso.datetime().describe('验证码到期时间，到期时即不可用'),
  csrfToken: DigestSchema.describe('与访客Cookie绑定的CSRF令牌'),
});
export type CaptchaDto = z.infer<typeof CaptchaSchema>;
export const UserSchema = z.strictObject({
  id: z.uuid().describe('当前账号标识，不接受客户端指定他人ID'),
  username: z
    .string()
    .regex(/^[a-z0-9_]{3,32}$/)
    .describe('规范化用户名'),
  createdAt: z.iso.datetime().describe('账号创建时间'),
  csrfToken: DigestSchema.describe('当前访客或会话的CSRF令牌'),
});
export type UserDto = z.infer<typeof UserSchema>;
export const ActorSchema = z.strictObject({
  userId: z.uuid().describe('由会话解析得到的账号ID'),
  sessionId: z.uuid().nullable().describe('浏览器会话；受信内部运行调用为空'),
  personalDataEpoch: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('协议认证时个人资料版本，拒绝删除前的迟到请求'),
  execution: z
    .strictObject({
      runId: z.uuid().describe('受信调用绑定的活跃运行'),
      kind: z.enum(['chat', 'resume']).describe('聊天授权或指定简历提取授权'),
      personalDataEpoch: z
        .number()
        .int()
        .nonnegative()
        .describe('签发运行时的个人资料删除屏障'),
      resourceId: z
        .uuid()
        .nullable()
        .describe('简历解析时唯一允许读取的私有资源，聊天为空'),
    })
    .optional()
    .describe('仅受信MCP授权上下文提供，禁止从用户JSON提取'),
  authEpoch: z.number().int().nonnegative().describe('认证时账号密码版本'),
});
export type ActorDto = z.infer<typeof ActorSchema>;
export const AuthContextSchema = z.strictObject({
  requesterDigest: DigestSchema.describe(
    '受信网络来源摘要，不接受请求JSON提供',
  ),
  visitorDigest: DigestSchema.optional().describe('访客Cookie摘要'),
  csrfToken: DigestSchema.optional().describe('协议Guard已核对的CSRF令牌'),
  actor: ActorSchema.optional().describe('由会话服务解析的受信身份'),
});
export type AuthContextDto = z.infer<typeof AuthContextSchema>;
export const SessionCredentialInputSchema = z.strictObject({
  sessionCredential: CredentialSchema.optional().describe(
    '仅HTTP适配器传入的会话Cookie值',
  ),
});
export type SessionCredentialInputDto = z.infer<
  typeof SessionCredentialInputSchema
>;
export const IssueCaptchaInputSchema = z.strictObject({
  requesterDigest: DigestSchema,
  visitorCredential:
    CredentialSchema.optional().describe('可复用本浏览器访客令牌'),
});
export type IssueCaptchaInputDto = z.infer<typeof IssueCaptchaInputSchema>;
export const CaptchaServiceResultSchema = z.strictObject({
  captcha: CaptchaSchema.describe('对浏览器公开的图片挑战'),
  visitorCredential: CredentialSchema.describe(
    '仅映射HttpOnly访客Cookie，不进入payload',
  ),
});
export type CaptchaServiceResultDto = z.infer<
  typeof CaptchaServiceResultSchema
>;
export const LoginServiceResultSchema = z.strictObject({
  user: UserSchema.describe('可公开的当前用户与会话CSRF'),
  sessionCredential: CredentialSchema.describe(
    '仅映射HttpOnly会话Cookie，不进入payload',
  ),
});
export type LoginServiceResultDto = z.infer<typeof LoginServiceResultSchema>;
export const ResolvedSessionSchema = z.strictObject({
  actor: ActorSchema.describe('会话解析得到的受信调用身份'),
  user: UserSchema.describe('该会话所属用户的安全公开数据'),
});
export type ResolvedSessionDto = z.infer<typeof ResolvedSessionSchema>;
export const CaptchaResponseSchema = z.object({
  requestId: z.uuid().describe('本次图片挑战请求的追踪标识'),
  payload: CaptchaSchema.describe('公开图片挑战及访客CSRF'),
});
export const UserResponseSchema = z.object({
  requestId: z.uuid().describe('本次账号操作请求的追踪标识'),
  payload: UserSchema.describe('账号安全字段和相应CSRF，不含原始凭据'),
});
/** 认证领域稳定错误码：消息和HTTP映射集中维护，不输出内部异常。 */
export const AuthErrorCodeSchema = z.enum([
  'AUTH_INVALID_CAPTCHA',
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_UNAUTHENTICATED',
  'AUTH_USERNAME_CONFLICT',
  'AUTH_VERSION_CONFLICT',
  'AUTH_CONTEXT_STALE',
  'AUTH_RATE_LIMITED',
  'AUTH_DEPENDENCY_UNAVAILABLE',
]);
export type AuthErrorCode = z.infer<typeof AuthErrorCodeSchema>;
