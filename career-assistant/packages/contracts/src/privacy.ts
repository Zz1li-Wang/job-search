import { z } from 'zod';
export const DeleteDataInputSchema = z.strictObject({
  confirmation: z
    .enum(['CLEAR_PROFILE', 'CLEAR_PERSONAL_DATA', 'DELETE_ACCOUNT'])
    .describe('用户明确选择的删除范围'),
  currentPassword: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('删除账号必须验证当前密码'),
});
export const DeletionSchema = z.strictObject({
  id: z.uuid().describe('删除请求'),
  scope: z
    .enum(['profile', 'personal', 'account', 'resume'])
    .describe('删除范围'),
  status: z
    .enum(['completed', 'pending_cleanup'])
    .describe('访问已撤销；文件仍待清理时明确标记'),
  requestedAt: z.iso.datetime().describe('本地撤销时刻'),
  pendingFiles: z
    .number()
    .int()
    .nonnegative()
    .describe('尚未物理删除的文件数量'),
});
