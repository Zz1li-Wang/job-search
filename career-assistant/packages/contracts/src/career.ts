import { z } from 'zod';
export const ApplicationStatusSchema = z
  .enum([
    'preparing',
    'submitted',
    'assessment',
    'interview',
    'offered',
    'rejected',
    'withdrawn',
  ])
  .describe('准备投递、已投递、笔试、面试、录用、未通过、撤回；仅用户手动变更');
export const FavoriteSchema = z.strictObject({
  jobId: z.uuid().describe('收藏岗位'),
  title: z.string().describe('收藏时标题快照'),
  createdAt: z.iso.datetime().describe('收藏时间'),
});
export const ApplicationInputSchema = z.strictObject({
  jobId: z.uuid().describe('目标岗位'),
});
export const ApplicationPatchSchema = z.strictObject({
  expectedVersion: z.number().int().positive().describe('编辑时版本'),
  status: ApplicationStatusSchema,
  actionDate: z.iso
    .date()
    .nullable()
    .describe('实际发生日期，未知留空，不能在未来'),
  note: z.string().max(2000).describe('用户记录备注'),
});
export const ApplicationSchema = z.strictObject({
  id: z.uuid().describe('本人记录'),
  jobId: z.uuid().describe('岗位ID'),
  title: z.string().describe('创建时岗位标题'),
  status: ApplicationStatusSchema,
  actionDate: z.iso.date().nullable().describe('用户记录日期'),
  note: z.string().describe('本人备注'),
  version: z.number().int().positive().describe('乐观版本'),
  createdAt: z.iso.datetime().describe('创建时间'),
  updatedAt: z.iso.datetime().describe('最后修改'),
});
export type ApplicationDto = z.infer<typeof ApplicationSchema>;
export const ApplicationHistorySchema = z.strictObject({
  id: z.uuid().describe('历史事件'),
  version: z.number().int().positive().describe('发生版本'),
  status: ApplicationStatusSchema,
  actionDate: z.iso.date().nullable().describe('当时日期'),
  note: z.string().describe('当时备注'),
  createdAt: z.iso.datetime().describe('记录时刻'),
});
