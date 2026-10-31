import {
  Module,
  Controller,
  Delete,
  Get,
  Param,
  Body,
  Req,
  Headers,
  Inject,
  UseGuards,
  UseFilters,
  HttpCode,
  type DynamicModule,
} from '@nestjs/common';
import type { PrivacyService } from '@career/business';
import {
  DeleteDataInputSchema,
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
const PRIVACY = Symbol('privacy');
@Controller('api/v1')
@UseGuards(AuthGuard)
@UseFilters(BusinessExceptionFilter, AuthExceptionFilter)
export class PrivacyController {
  constructor(@Inject(PRIVACY) private readonly service: PrivacyService) {}
  @Delete('profile') @HttpCode(202) @ContextOperation('write') async profile(
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.service.remove(
        'profile',
        validated(DeleteDataInputSchema, body),
        validated(OperationKeySchema, key),
        caller(r).actor!,
      ),
    };
  }
  @Delete('me/data') @HttpCode(202) @ContextOperation('write') async data(
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.service.remove(
        'personal',
        validated(DeleteDataInputSchema, body),
        validated(OperationKeySchema, key),
        caller(r).actor!,
      ),
    };
  }
  @Delete('me') @HttpCode(202) @ContextOperation('write') async account(
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.service.remove(
        'account',
        validated(DeleteDataInputSchema, body),
        validated(OperationKeySchema, key),
        caller(r).actor!,
      ),
    };
  }
  @Get('deletions/:id') @ContextOperation('session') async status(
    @Param() p: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.service.get(
        validated(ResourcePathSchema, p).id,
        caller(r).actor!,
      ),
    };
  }
}
@Module({})
export class PrivacyHttpModule {
  static register(service: PrivacyService, auth: DynamicModule): DynamicModule {
    return {
      module: PrivacyHttpModule,
      imports: [auth],
      controllers: [PrivacyController],
      providers: [
        { provide: PRIVACY, useValue: service },
        BusinessExceptionFilter,
      ],
    };
  }
}
