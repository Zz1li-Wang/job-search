import { z } from 'zod';
export * from './auth.js';

/** 存活不代表业务依赖可用；就绪检查失败时返回unavailable。 */
export const HealthSchema = z.object({
  service: z.enum(['api', 'agent']).describe('返回状态的服务'),
  status: z.enum(['ok', 'unavailable']).describe('当前检查结果'),
  dependencies: z
    .record(z.string(), z.boolean())
    .describe('依赖可用性，无地址或凭据'),
});
export type HealthDto = z.infer<typeof HealthSchema>;
export const HealthQuerySchema = z.strictObject({});
export type HealthQueryDto = z.infer<typeof HealthQuerySchema>;
export const HealthResponseSchema = z.object({
  requestId: z.uuid().describe('服务生成或校验后沿用的请求追踪标识'),
  payload: HealthSchema.describe('服务健康结果'),
});
export type HealthResponseDto = z.infer<typeof HealthResponseSchema>;
export const ErrorResponseSchema = z.object({
  requestId: z.uuid().describe('对应请求标识'),
  error: z.object({
    // 领域枚举各自维护，通用封装约束稳定命名，允许新增领域错误而不破坏信封。
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,99}$/)
      .describe('对应领域登记并注释的稳定错误码'),
    message: z.string().describe('不包含内部堆栈或配置的提示'),
  }),
});
export type ErrorResponseDto = z.infer<typeof ErrorResponseSchema>;
export * from './ingestion.js';
export * from './profile.js';
export * from './jobs.js';
export * from './chat.js';
export * from './resume.js';
export * from './career.js';
export * from './privacy.js';
export * from './execution-policy.js';
