import { z } from 'zod';

const PortSchema = z.coerce.number().int().min(1).max(65535);
const ServerSchema = z.object({
  API_PORT: PortSchema.default(3001).describe('业务API监听端口'),
  AGENT_PORT: PortSchema.default(3002).describe('Agent监听端口'),
  SERVICE_AUTH_TOKEN: z.string().min(32).describe('仅服务间使用的Bearer凭据'),
});
export const ApiConfigSchema = ServerSchema.extend({
  DATABASE_URL: z
    .url()
    .refine((value) =>
      ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
    )
    .describe('PostgreSQL连接串，仅注入基础设施'),
  PRIVATE_FILE_ROOT: z
    .string()
    .min(1)
    .default('./var/private')
    .describe('受保护本地文件目录'),
});
export const AgentConfigSchema = ServerSchema.extend({
  API_INTERNAL_URL: z
    .url()
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol))
    .describe('业务服务内部健康入口基地址'),
  MODEL_BASE_URL: z
    .url()
    .default('https://api.deepseek.com')
    .describe('用户配置的模型服务地址'),
  MODEL_NAME: z
    .literal('deepseek-v4-pro')
    .default('deepseek-v4-pro')
    .describe('用户确认的模型标识'),
  MODEL_API_KEY: z.string().min(1).describe('私有模型密钥，健康检查不调用模型'),
});
export type ApiConfig = z.infer<typeof ApiConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const AuthConfigSchema = z
  .object({
    AUTH_PUBLIC_ORIGIN: z
      .url()
      .default('http://127.0.0.1:5173')
      .refine((value) => {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) && url.origin === value
        );
      })
      .describe('浏览器精确Origin，不含路径或末尾斜杠'),
    AUTH_TOKEN_PEPPER: z
      .string()
      .min(32)
      .describe('会话、挑战和隔离摘要HMAC密钥'),
    AUTH_CSRF_SECRET: z.string().min(32).describe('独立用途的CSRF HMAC密钥'),
    AUTH_TRUSTED_PROXIES: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
      )
      .describe('可选可信代理IP或CIDR，默认不信任转发头'),
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development')
      .describe('生产强制HTTPS和安全Cookie'),
  })
  .superRefine((config, context) => {
    if (config.AUTH_TOKEN_PEPPER === config.AUTH_CSRF_SECRET)
      context.addIssue({
        code: 'custom',
        path: ['AUTH_CSRF_SECRET'],
        message: '秘密必须独立',
      });
    if (config.NODE_ENV === 'production') {
      for (const key of ['AUTH_TOKEN_PEPPER', 'AUTH_CSRF_SECRET'] as const) {
        if (config[key].startsWith('replace_'))
          context.addIssue({
            code: 'custom',
            path: [key],
            message: '生产不能使用模板值',
          });
      }
    }
    if (
      config.NODE_ENV === 'production' &&
      !config.AUTH_PUBLIC_ORIGIN.startsWith('https://')
    )
      context.addIssue({
        code: 'custom',
        path: ['AUTH_PUBLIC_ORIGIN'],
        message: '生产必须HTTPS',
      });
  });
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

/** 安全配置异常只携带字段名，入口可记录message，不记录Zod原始异常。 */
export class ConfigurationError extends Error {
  constructor(fieldNames: readonly string[]) {
    super(`配置无效：${fieldNames.join(', ')}`);
  }
}

/** 启动失败只暴露字段名称，Zod原始issue可能包含输入值，不直接记录。 */
export function readConfig<T>(
  schema: z.ZodType<T>,
  environment: NodeJS.ProcessEnv,
): T {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) {
    const names = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.'))),
    ];
    throw new ConfigurationError(names);
  }
  return parsed.data;
}

export const IngestionConfigSchema = z.object({
  INGESTION_NETWORK_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true')
    .describe('真实来源网络显式开关，默认关闭'),
  INGESTION_BUDGET_ID: z
    .string()
    .min(1)
    .max(200)
    .default('step6-approved-verification')
    .describe('本次获准验证的持久预算键，重启不得换键清零'),
  INGESTION_REQUEST_LIMIT: z.coerce
    .number()
    .int()
    .min(0)
    .max(40)
    .default(40)
    .describe('本步最多40次请求，包含robots和重定向'),
  INGESTION_COOKIE_FILE: z
    .string()
    .default('tools/verification/.env.source')
    .describe('仅启用来源网络的Worker读取的私有Cookie配置'),
  INGESTION_OPERATOR_REFERENCE: z
    .string()
    .max(200)
    .default('')
    .describe('CLI必须显式配置的服务器运营身份'),
  INGESTION_EXPORT_ROOT: z
    .string()
    .min(1)
    .default('./var/exports')
    .describe('受保护的固定导出目录'),
});
export type IngestionConfig = z.infer<typeof IngestionConfigSchema>;
