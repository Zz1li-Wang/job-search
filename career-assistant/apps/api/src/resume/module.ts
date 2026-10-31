import { RESUME_POLICY } from '@career/contracts';
import {
  Module,
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  Headers,
  Inject,
  UseGuards,
  UseFilters,
  HttpCode,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { extname } from 'node:path';
import { z } from 'zod';
import { BusinessError, type createResumeServices } from '@career/business';
import {
  ResumeTextInputSchema,
  ParseResumeSchema,
  DraftInputSchema,
  DraftPatchSchema,
  DraftConfirmSchema,
  ResourcePathSchema,
  OperationKeySchema,
} from '@career/contracts';
import {
  AuthGuard,
  AuthExceptionFilter,
  ContextOperation,
  caller,
  validated,
  type AuthRequest,
} from '../auth/module.js';
import { BusinessExceptionFilter } from '../jobs/module.js';
const RESUMES = Symbol('resumes');
type Services = ReturnType<typeof createResumeServices>;
@Controller('api/v1')
@UseGuards(AuthGuard)
@UseFilters(BusinessExceptionFilter, AuthExceptionFilter)
export class ResumeController {
  constructor(@Inject(RESUMES) private readonly services: Services) {}
  @Post('resumes')
  @ContextOperation('write')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: RESUME_POLICY.maxFileBytes, files: 1, fields: 1 },
    }),
  )
  async upload(
    @UploadedFile() file: unknown,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() r: AuthRequest,
  ) {
    const uploaded = validated(
        z.object({
          originalname: z.string().max(255),
          buffer: z.instanceof(Buffer),
        }),
        file,
      ),
      title =
        validated(
          z.strictObject({
            title: z.string().trim().min(1).max(100).optional(),
          }),
          body,
        ).title ?? uploaded.originalname,
      format = extname(uploaded.originalname).slice(1).toLowerCase();
    if (!['pdf', 'docx', 'txt'].includes(format))
      throw new BusinessError('FILE_UNSUPPORTED');
    return {
      requestId: r.requestId,
      payload: await this.services.resumes.upload(
        title,
        format as 'pdf' | 'docx' | 'txt',
        uploaded.buffer,
        validated(OperationKeySchema, key),
        caller(r).actor!,
      ),
    };
  }
  @Post('resumes/text') @ContextOperation('write') async text(
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() r: AuthRequest,
  ) {
    const input = validated(ResumeTextInputSchema, body);
    return {
      requestId: r.requestId,
      payload: await this.services.resumes.upload(
        input.title,
        'txt',
        Buffer.from(input.text),
        validated(OperationKeySchema, key),
        caller(r).actor!,
      ),
    };
  }
  @Get('resumes') @ContextOperation('session') async list(
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.services.resumes.list(caller(r).actor!),
    };
  }
  @Get('resumes/:id') @ContextOperation('session') async get(
    @Param() p: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.services.resumes.get(
        validated(ResourcePathSchema, p).id,
        caller(r).actor!,
      ),
    };
  }
  @Post('resumes/:id/parse')
  @HttpCode(202)
  @ContextOperation('write')
  async parse(
    @Param() p: unknown,
    @Body() body: unknown,
    @Req() r: AuthRequest,
  ) {
    const input = validated(ParseResumeSchema, body);
    return {
      requestId: r.requestId,
      payload: await this.services.resumes.parse(
        validated(ResourcePathSchema, p).id,
        input.expectedResumeVersion,
        input.retry,
        caller(r).actor!,
        input.expectedTaskId,
      ),
    };
  }
  @Delete('resumes/:id') @HttpCode(202) @ContextOperation('write') async remove(
    @Param() p: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.services.resumes.remove(
        validated(ResourcePathSchema, p).id,
        caller(r).actor!,
      ),
    };
  }
  @Get('resumes/:id/content') @ContextOperation('session') async content(
    @Param() p: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.services.resumes.content(
        validated(ResourcePathSchema, p).id,
        caller(r).actor!,
      ),
    };
  }
  @Post('profile/drafts') @ContextOperation('write') async draft(
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.services.resumes.createDraft(
        validated(DraftInputSchema, body),
        validated(OperationKeySchema, key),
        caller(r).actor!,
      ),
    };
  }
  @Get('profile/drafts/:id') @ContextOperation('session') async getDraft(
    @Param() p: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.services.resumes.getDraft(
        validated(ResourcePathSchema, p).id,
        caller(r).actor!,
      ),
    };
  }
  @Patch('profile/drafts/:id') @ContextOperation('write') async patchDraft(
    @Param() p: unknown,
    @Body() b: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.services.resumes.patchDraft(
        validated(ResourcePathSchema, p).id,
        validated(DraftPatchSchema, b),
        caller(r).actor!,
      ),
    };
  }
  @Post('profile/drafts/:id/confirm')
  @HttpCode(200)
  @ContextOperation('write')
  async confirm(
    @Param() p: unknown,
    @Body() b: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.services.resumes.confirm(
        validated(ResourcePathSchema, p).id,
        validated(DraftConfirmSchema, b),
        caller(r).actor!,
      ),
    };
  }
}
@Module({})
export class ResumeHttpModule {
  static register(services: Services, auth: DynamicModule): DynamicModule {
    return {
      module: ResumeHttpModule,
      imports: [auth],
      controllers: [ResumeController],
      providers: [
        { provide: RESUMES, useValue: services },
        BusinessExceptionFilter,
      ],
    };
  }
}
