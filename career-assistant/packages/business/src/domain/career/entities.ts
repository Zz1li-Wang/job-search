import { z } from 'zod';
import { ApplicationStatusSchema } from '@career/contracts';
import { BusinessError } from '../shared/errors.js';
export const ApplicationStateSchema = z.object({
  id: z.uuid().describe('记录'),
  userId: z.uuid().describe('本人'),
  jobId: z.uuid().describe('岗位'),
  title: z.string().describe('标题快照'),
  status: ApplicationStatusSchema,
  actionDate: z.string().nullable().describe('手动记录日期'),
  note: z.string().max(2000).describe('私有备注'),
  version: z.number().int().positive().describe('并发版本'),
  createdAt: z.date().describe('建立时间'),
  updatedAt: z.date().describe('修改时间'),
});
export type ApplicationState = z.infer<typeof ApplicationStateSchema>;
export class ApplicationEntity {
  private readonly state: ApplicationState;
  constructor(state: ApplicationState) {
    this.state = structuredClone(ApplicationStateSchema.parse(state));
  }
  snapshot() {
    return structuredClone(this.state);
  }
  revise(
    input: {
      expectedVersion: number;
      status: ApplicationState['status'];
      actionDate: string | null;
      note: string;
    },
    now: Date,
  ) {
    if (this.state.version !== input.expectedVersion)
      throw new BusinessError('VERSION_CONFLICT');
    if (input.actionDate && input.actionDate > now.toISOString().slice(0, 10))
      throw new BusinessError('INVALID_EVIDENCE');
    if (
      this.state.status === input.status &&
      this.state.actionDate === input.actionDate &&
      this.state.note === input.note
    )
      return this;
    return new ApplicationEntity({
      ...this.state,
      status: input.status,
      actionDate: input.actionDate,
      note: input.note,
      version: this.state.version + 1,
      updatedAt: now,
    });
  }
}
export interface FavoriteRecord {
  userId: string;
  jobId: string;
  title: string;
  createdAt: Date;
}
export interface ApplicationHistoryRecord {
  id: string;
  applicationId: string;
  version: number;
  status: ApplicationState['status'];
  actionDate: string | null;
  note: string;
  createdAt: Date;
}
