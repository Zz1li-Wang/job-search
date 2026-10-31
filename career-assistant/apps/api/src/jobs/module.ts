import {
  Module,
  Controller,
  Get,
  Post,
  Inject,
  Param,
  Query,
  Body,
  Req,
  Headers,
  UseGuards,
  UseFilters,
  Catch,
  type DynamicModule,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  BusinessError,
  IngestionError,
  type createJobsServices,
} from '@career/business';
import {
  JobQuerySchema,
  JobPageSchema,
  JobDetailSchema,
  EvidenceBundleSchema,
  EvaluateInputSchema,
  EligibilitySchema,
  ProfileSchema,
  ResourcePathSchema,
  EmptyInputSchema,
  OperationKeySchema,
} from '@career/contracts';
import { z } from 'zod';
import {
  AuthGuard,
  AuthExceptionFilter,
  ContextOperation,
  caller,
  validated,
  type AuthRequest,
} from '../auth/module.js';
export const BUSINESS_HTTP_STATUS: Readonly<Record<string, number>> = {
  INVALID_CURSOR: 400,
  VERSION_CONFLICT: 409,
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  CONVERSATION_BUSY: 409,
  INVALID_TRANSITION: 409,
  TOOL_UNAUTHORIZED: 403,
  MODEL_UNAVAILABLE: 503,
  MODEL_INTERRUPTED: 503,
  MODEL_OUTPUT_INVALID: 422,
  MODEL_CONTEXT_EXCEEDED: 413,
  TOOL_BUDGET_EXHAUSTED: 429,
  FILE_UNSUPPORTED: 415,
  FILE_INVALID: 422,
  FILE_TOO_LARGE: 413,
  FILE_ENCRYPTED: 422,
  FILE_NO_TEXT: 422,
  INVALID_EVIDENCE: 422,
  DEPENDENCY_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  INGESTION_NOT_FOUND: 404,
  EVIDENCE_VERSION_CONFLICT: 409,
  TASK_VERSION_CONFLICT: 409,
  INGESTION_RATE_LIMITED: 429,
};
@Catch(BusinessError, IngestionError)
export class BusinessExceptionFilter implements ExceptionFilter {
  catch(error: BusinessError | IngestionError, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest<AuthRequest>();
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(BUSINESS_HTTP_STATUS[error.code] ?? 503)
      .json({
        requestId: request.requestId,
        error: { code: error.code, message: error.message },
      });
  }
}
const JOBS = Symbol('jobs-services');
type Services = ReturnType<typeof createJobsServices>;
@Controller('api/v1')
@UseGuards(AuthGuard)
@UseFilters(BusinessExceptionFilter, AuthExceptionFilter)
export class JobsController {
  constructor(@Inject(JOBS) private readonly services: Services) {}
  @Get('jobs')
  @ContextOperation('session')
  async list(@Query() query: unknown, @Req() r: AuthRequest) {
    return {
      requestId: r.requestId,
      payload: JobPageSchema.parse(
        await this.services.jobs.list(
          validated(JobQuerySchema, query),
          caller(r).actor!,
        ),
      ),
    };
  }
  @Get('jobs/:id')
  @ContextOperation('session')
  async detail(
    @Param() path: unknown,
    @Query() query: unknown,
    @Req() r: AuthRequest,
  ) {
    validated(EmptyInputSchema, query);
    return {
      requestId: r.requestId,
      payload: JobDetailSchema.parse(
        await this.services.jobs.detail(
          validated(ResourcePathSchema, path).id,
          caller(r).actor!,
        ),
      ),
    };
  }
  @Get('jobs/:id/evidence')
  @ContextOperation('session')
  async evidence(
    @Param() path: unknown,
    @Query() query: unknown,
    @Req() r: AuthRequest,
  ) {
    const input = validated(
      z.strictObject({ expectedJobVersion: z.uuid().optional() }),
      query,
    );
    return {
      requestId: r.requestId,
      payload: EvidenceBundleSchema.parse(
        await this.services.jobs.evidence(
          validated(ResourcePathSchema, path).id,
          input.expectedJobVersion,
          caller(r).actor!,
        ),
      ),
    };
  }
  @Get('profile')
  @ContextOperation('session')
  async profile(@Query() query: unknown, @Req() r: AuthRequest) {
    validated(EmptyInputSchema, query);
    return {
      requestId: r.requestId,
      payload: ProfileSchema.parse(
        await this.services.profile.execute(caller(r).actor!),
      ),
    };
  }
  @Post('eligibility-checks')
  @ContextOperation('write')
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: EligibilitySchema.parse(
        await this.services.eligibility.create(
          validated(EvaluateInputSchema, body),
          validated(OperationKeySchema, key),
          caller(r).actor!,
        ),
      ),
    };
  }
  @Get('eligibility-checks/:id')
  @ContextOperation('session')
  async check(
    @Param() path: unknown,
    @Query() query: unknown,
    @Req() r: AuthRequest,
  ) {
    validated(EmptyInputSchema, query);
    return {
      requestId: r.requestId,
      payload: EligibilitySchema.parse(
        await this.services.eligibility.get(
          validated(ResourcePathSchema, path).id,
          caller(r).actor!,
        ),
      ),
    };
  }
}
@Module({})
export class JobsHttpModule {
  static register(services: Services, auth: DynamicModule): DynamicModule {
    return {
      module: JobsHttpModule,
      imports: [auth],
      controllers: [JobsController],
      providers: [
        { provide: JOBS, useValue: services },
        BusinessExceptionFilter,
      ],
      exports: [BusinessExceptionFilter],
    };
  }
}
