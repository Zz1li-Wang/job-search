import {
  Module,
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Req,
  Headers,
  Inject,
  UseGuards,
  UseFilters,
  HttpCode,
  type DynamicModule,
} from '@nestjs/common';
import { z } from 'zod';
import type { CareerService } from '@career/business';
import {
  ApplicationInputSchema,
  ApplicationPatchSchema,
  ApplicationStatusSchema,
  OperationKeySchema,
  ResourcePathSchema,
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
const CAREER = Symbol('career');
@Controller('api/v1')
@UseGuards(AuthGuard)
@UseFilters(BusinessExceptionFilter, AuthExceptionFilter)
export class CareerController {
  constructor(@Inject(CAREER) private readonly service: CareerService) {}
  @Get('favorites') @ContextOperation('session') async favorites(
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.service.favorites(caller(r).actor!),
    };
  }
  @Put('favorites/:jobId') @ContextOperation('write') async addFavorite(
    @Param() p: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.service.addFavorite(
        validated(z.strictObject({ jobId: z.uuid() }), p).jobId,
        caller(r).actor!,
      ),
    };
  }
  @Delete('favorites/:jobId')
  @HttpCode(204)
  @ContextOperation('write')
  async deleteFavorite(@Param() p: unknown, @Req() r: AuthRequest) {
    await this.service.removeFavorite(
      validated(z.strictObject({ jobId: z.uuid() }), p).jobId,
      caller(r).actor!,
    );
  }
  @Get('applications') @ContextOperation('session') async list(
    @Query() q: unknown,
    @Req() r: AuthRequest,
  ) {
    const query = validated(
      z.strictObject({ status: ApplicationStatusSchema.optional() }),
      q,
    );
    return {
      requestId: r.requestId,
      payload: await this.service.list(query.status, caller(r).actor!),
    };
  }
  @Post('applications') @ContextOperation('write') async create(
    @Body() b: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.service.create(
        validated(ApplicationInputSchema, b).jobId,
        validated(OperationKeySchema, key),
        caller(r).actor!,
      ),
    };
  }
  @Get('applications/:id') @ContextOperation('session') async get(
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
  @Patch('applications/:id') @ContextOperation('write') async patch(
    @Param() p: unknown,
    @Body() b: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.service.patch(
        validated(ResourcePathSchema, p).id,
        validated(ApplicationPatchSchema, b),
        validated(OperationKeySchema, key),
        caller(r).actor!,
      ),
    };
  }
  @Get('applications/:id/history') @ContextOperation('session') async history(
    @Param() p: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.service.histories(
        validated(ResourcePathSchema, p).id,
        caller(r).actor!,
      ),
    };
  }
  @Delete('applications/:id')
  @HttpCode(204)
  @ContextOperation('write')
  async remove(@Param() p: unknown, @Req() r: AuthRequest) {
    await this.service.remove(
      validated(ResourcePathSchema, p).id,
      caller(r).actor!,
    );
  }
}
@Module({})
export class CareerHttpModule {
  static register(service: CareerService, auth: DynamicModule): DynamicModule {
    return {
      module: CareerHttpModule,
      imports: [auth],
      controllers: [CareerController],
      providers: [
        { provide: CAREER, useValue: service },
        BusinessExceptionFilter,
      ],
    };
  }
}
