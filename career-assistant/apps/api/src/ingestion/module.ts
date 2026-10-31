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
  HttpCode,
  UseGuards,
  UseFilters,
  Catch,
  type DynamicModule,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { IngestionError, type IngestionServices } from '@career/business';
import {
  EmptyInputSchema,
  ResourcePathSchema,
  OperationKeySchema,
  TaskSchema,
  TrustSchema,
} from '@career/contracts';
import {
  AuthGuard,
  AuthExceptionFilter,
  ContextOperation,
  caller,
  validated,
  type AuthRequest,
} from '../auth/module.js';
const INGESTION = Symbol('ingestion-services');
const STATUS = {
  SOURCE_ACCESS_BLOCKED: 503,
  SOURCE_BUDGET_EXHAUSTED: 503,
  SOURCE_RATE_LIMITED: 429,
  SOURCE_PARSE_UNSUPPORTED: 503,
  SOURCE_UNAVAILABLE: 503,
  TASK_VERSION_CONFLICT: 409,
  EVIDENCE_VERSION_CONFLICT: 409,
  EVIDENCE_INCOMPLETE: 400,
  IDEMPOTENCY_CONFLICT: 409,
  INGESTION_NOT_FOUND: 404,
  INGESTION_RATE_LIMITED: 429,
  INGESTION_STORAGE_UNAVAILABLE: 503,
} as const;
@Catch(IngestionError)
class IngestionFilter implements ExceptionFilter {
  catch(error: IngestionError, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest<AuthRequest>();
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(STATUS[error.code])
      .json({
        requestId: request.requestId,
        error: { code: error.code, message: error.message },
      });
  }
}
@Controller('api/v1')
@UseFilters(IngestionFilter, AuthExceptionFilter)
export class IngestionController {
  constructor(
    @Inject(INGESTION) private readonly services: IngestionServices,
  ) {}
  @Post('jobs/:id/refresh')
  @HttpCode(202)
  @UseGuards(AuthGuard)
  @ContextOperation('write')
  async refresh(
    @Param() path: unknown,
    @Query() query: unknown,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() request: AuthRequest,
  ) {
    const { id } = validated(ResourcePathSchema, path);
    validated(EmptyInputSchema, query);
    validated(EmptyInputSchema, body);
    const operationKey = validated(OperationKeySchema, key);
    const actor = caller(request).actor!;
    return {
      requestId: request.requestId,
      payload: TaskSchema.parse(
        await this.services.refresh.execute(id, operationKey, actor),
      ),
    };
  }
  @Get('tasks/:id')
  @UseGuards(AuthGuard)
  @ContextOperation('session')
  async task(
    @Param() path: unknown,
    @Query() query: unknown,
    @Req() request: AuthRequest,
  ) {
    const { id } = validated(ResourcePathSchema, path);
    validated(EmptyInputSchema, query);
    return {
      requestId: request.requestId,
      payload: TaskSchema.parse(
        await this.services.task.execute(id, caller(request).actor!),
      ),
    };
  }
  @Get('trust')
  async trust(@Query() query: unknown, @Req() request: AuthRequest) {
    validated(EmptyInputSchema, query);
    return {
      requestId: request.requestId,
      payload: TrustSchema.parse(await this.services.coverage.execute()),
    };
  }
}
@Module({})
export class IngestionHttpModule {
  static register(
    services: IngestionServices,
    auth: DynamicModule,
  ): DynamicModule {
    return {
      module: IngestionHttpModule,
      imports: [auth],
      controllers: [IngestionController],
      providers: [{ provide: INGESTION, useValue: services }, IngestionFilter],
    };
  }
}
