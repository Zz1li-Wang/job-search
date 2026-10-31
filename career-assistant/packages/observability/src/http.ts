import 'reflect-metadata';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import {
  Controller,
  Get,
  Inject,
  Module,
  Query,
  Res,
  Req,
  UseGuards,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
  Catch,
  HttpException,
  type CanActivate,
  type ExecutionContext,
  type ExceptionFilter,
  type ArgumentsHost,
  type DynamicModule,
  type ModuleMetadata,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request, Response, NextFunction } from 'express';
import {
  HealthQuerySchema,
  HealthSchema,
  type HealthResponseDto,
  type ErrorResponseDto,
} from '@career/contracts';
import { HealthService } from './health.js';
import { createSafeLogger } from './logger.js';

interface TracedRequest extends Request {
  requestId: string;
}
export interface HealthHttpOptions {
  readonly health: HealthService;
  readonly authentication?: {
    readonly token: string;
    readonly scopes: readonly string[];
  };
}
const OPTIONS = Symbol('health-http-options');

class HealthGuard implements CanActivate {
  constructor(@Inject(OPTIONS) private readonly options: HealthHttpOptions) {}
  canActivate(context: ExecutionContext): boolean {
    const expected = this.options.authentication;
    if (!expected) return true;
    const authorization = context.switchToHttp().getRequest<Request>()
      .headers.authorization;
    const digest = (value: string) =>
      createHash('sha256').update(value).digest();
    if (
      !authorization ||
      !timingSafeEqual(
        digest(authorization),
        digest(`Bearer ${expected.token}`),
      )
    )
      throw new UnauthorizedException();
    if (!expected.scopes.includes('health:read'))
      throw new ForbiddenException();
    return true;
  }
}

@Controller('health')
@UseGuards(HealthGuard)
export class HealthController {
  constructor(@Inject(HealthService) private readonly service: HealthService) {}
  @Get('live')
  live(
    @Query() query: unknown,
    @Req() request: TracedRequest,
  ): HealthResponseDto {
    const parsed = HealthQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException();
    return {
      requestId: request.requestId,
      payload: HealthSchema.parse(this.service.live(parsed.data)),
    };
  }
  @Get('ready')
  async ready(
    @Query() query: unknown,
    @Req() request: TracedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<HealthResponseDto> {
    const parsed = HealthQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException();
    const payload = HealthSchema.parse(await this.service.ready(parsed.data));
    if (payload.status !== 'ok') response.status(503);
    return { requestId: request.requestId, payload };
  }
}

/** 稳定错误映射：结构错误由调用方修正；认证/权限错误需凭据或作用域；其余内部失败不泄漏细节。 */
@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<TracedRequest>();
    const response = http.getResponse<Response>();
    const parsingStatus =
      exception instanceof Error && 'type' in exception
        ? exception.type === 'entity.too.large'
          ? 413
          : exception.type === 'entity.parse.failed'
            ? 400
            : null
        : null;
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : (parsingStatus ?? 500);
    const errors: Record<number, ErrorResponseDto['error']> = {
      // 正文超过传输上限；客户端应缩小内容后重试。
      413: {
        code: 'REQUEST_TOO_LARGE',
        message: '请求正文超过允许大小，请缩小内容后重试',
      },
      400: { code: 'INVALID_INPUT', message: '请求参数不符合契约' },
      401: { code: 'UNAUTHORIZED', message: '需要有效服务凭据' },
      403: { code: 'FORBIDDEN', message: '服务无此操作权限' },
      404: { code: 'NOT_FOUND', message: '请求入口不存在' },
    };
    response.status(status).json({
      requestId: request.requestId,
      error: errors[status] ?? {
        code: 'INTERNAL_ERROR',
        message: '服务暂时无法完成请求',
      },
    } satisfies ErrorResponseDto);
  }
}

@Module({})
class HealthModule {
  static register(
    options: HealthHttpOptions,
    imports: ModuleMetadata['imports'] = [],
  ): DynamicModule {
    return {
      module: HealthModule,
      imports,
      controllers: [HealthController],
      providers: [
        { provide: OPTIONS, useValue: options },
        { provide: HealthService, useValue: options.health },
        HealthGuard,
      ],
    };
  }
}

/** 创建可测试的Nest入口，实际listen由应用或E2E控制。 */
export async function createHealthApplication(
  options: HealthHttpOptions,
  imports: ModuleMetadata['imports'] = [],
) {
  const app = await NestFactory.create(
    HealthModule.register(options, imports),
    {
      logger: false,
      abortOnError: false,
    },
  );
  const logger = createSafeLogger(options.health.service);
  app.use((request: TracedRequest, response: Response, next: NextFunction) => {
    const incoming = request.headers['x-request-id'];
    request.requestId =
      typeof incoming === 'string' &&
      /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(
        incoming,
      )
        ? incoming
        : randomUUID();
    response.setHeader('x-request-id', request.requestId);
    response.on('finish', () =>
      logger.info(
        {
          requestId: request.requestId,
          method: request.method,
          statusCode: response.statusCode,
        },
        'request_completed',
      ),
    );
    next();
  });
  app.useGlobalFilters(new SafeExceptionFilter());
  return app;
}
