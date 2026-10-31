import {
  Module,
  Controller,
  Get,
  Post,
  Put,
  Inject,
  UseGuards,
  UseFilters,
  SetMetadata,
  Req,
  Res,
  Body,
  Query,
  HttpCode,
  BadRequestException,
  ForbiddenException,
  Catch,
  type CanActivate,
  type ExecutionContext,
  type DynamicModule,
  type ExceptionFilter,
  type ArgumentsHost,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { AuthConfig } from '@career/config';
import {
  AuthError,
  type AuthServices,
  type TokenCodec,
} from '@career/business';
import {
  RegisterInputSchema,
  LoginInputSchema,
  PasswordInputSchema,
  CaptchaSchema,
  UserSchema,
  HealthQuerySchema,
  AuthContextSchema,
  type AuthContextDto,
} from '@career/contracts';
import {
  AuthCookiePolicy,
  CredentialSchema,
  AUTH_HTTP_STATUS,
} from './protocol.js';

const AUTH_OPTIONS = Symbol('auth-http-options');
const AUTH_OPERATION = Symbol('auth-http-operation');
interface AuthHttpOptions {
  services: AuthServices;
  tokens: TokenCodec;
  config: AuthConfig;
  cookies: AuthCookiePolicy;
}
export interface AuthRequest extends Request {
  requestId: string;
  authContext?: AuthContextDto;
  sessionCredential?: string;
  visitorCredential?: string;
}
export const ContextOperation = (
  operation:
    'captcha' | 'visitor' | 'session' | 'password' | 'logout' | 'write',
) => SetMetadata(AUTH_OPERATION, operation);
export function caller(request: AuthRequest): AuthContextDto {
  return AuthContextSchema.parse(request.authContext);
}
export function validated<T>(
  schema: {
    safeParse(input: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException();
  return parsed.data;
}

export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH_OPTIONS) private readonly options: AuthHttpOptions,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    const { tokens, cookies, services, config } = this.options;
    const operation = this.reflector.get<string>(
      AUTH_OPERATION,
      context.getHandler(),
    );
    if (
      !operation ||
      ![
        'captcha',
        'visitor',
        'session',
        'password',
        'logout',
        'write',
      ].includes(operation)
    )
      throw new ForbiddenException();
    const visitorRaw = cookies.read(
      request.headers.cookie,
      cookies.visitorName,
    );
    const sessionRaw = cookies.read(
      request.headers.cookie,
      cookies.sessionName,
    );
    const visitor = CredentialSchema.safeParse(visitorRaw);
    const session = CredentialSchema.safeParse(sessionRaw);
    const authContext: AuthContextDto = {
      requesterDigest: tokens.digest('network-origin', request.ip ?? 'unknown'),
    };
    if (visitor.success) request.visitorCredential = visitor.data;
    if (session.success) request.sessionCredential = session.data;
    if (operation !== 'captcha' && operation !== 'session') {
      if (request.headers.origin !== config.AUTH_PUBLIC_ORIGIN)
        throw new ForbiddenException();
      const credential =
        operation === 'visitor'
          ? request.visitorCredential
          : request.sessionCredential;
      if (operation === 'logout' && sessionRaw === undefined) {
        request.authContext = authContext;
        return true;
      }
      if (!credential)
        throw operation === 'visitor'
          ? new ForbiddenException()
          : new AuthError('AUTH_UNAUTHENTICATED');
      const csrf = request.headers['x-csrf-token'];
      const purpose = operation === 'visitor' ? 'visitor' : 'session';
      if (
        typeof csrf !== 'string' ||
        !/^[a-f\d]{64}$/.test(csrf) ||
        !tokens.matches(csrf, tokens.csrf(purpose, credential))
      )
        throw new ForbiddenException();
      authContext.csrfToken = csrf;
      if (operation === 'visitor')
        authContext.visitorDigest = tokens.digest('visitor', credential);
    }
    if (
      operation === 'password' ||
      operation === 'session' ||
      operation === 'write'
    )
      authContext.actor = (
        await services.session.resolve({
          ...(request.sessionCredential
            ? { sessionCredential: request.sessionCredential }
            : {}),
        })
      ).actor;
    request.authContext = authContext;
    return true;
  }
}

@Catch(AuthError)
export class AuthExceptionFilter implements ExceptionFilter {
  constructor(
    @Inject(AUTH_OPTIONS) private readonly options: AuthHttpOptions,
  ) {}
  catch(error: AuthError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<AuthRequest>();
    if (
      error.code === 'AUTH_VERSION_CONFLICT' ||
      error.code === 'AUTH_UNAUTHENTICATED'
    )
      this.options.cookies.clearSession(response);
    if (error.retryAfterSeconds)
      response.setHeader('Retry-After', String(error.retryAfterSeconds));
    response.status(AUTH_HTTP_STATUS[error.code]).json({
      requestId: request.requestId,
      error: { code: error.code, message: error.message },
    });
  }
}

@Controller('api/v1/auth')
@UseGuards(AuthGuard)
@UseFilters(AuthExceptionFilter)
export class AuthController {
  constructor(
    @Inject(AUTH_OPTIONS) private readonly options: AuthHttpOptions,
  ) {}
  @Get('captcha')
  @ContextOperation('captcha')
  async captcha(
    @Query() query: unknown,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    validated(HealthQuerySchema, query);
    const result = await this.options.services.captcha.issue({
      requesterDigest: caller(request).requesterDigest,
      ...(request.visitorCredential
        ? { visitorCredential: request.visitorCredential }
        : {}),
    });
    this.options.cookies.setVisitor(response, result.visitorCredential);
    return {
      requestId: request.requestId,
      payload: CaptchaSchema.parse(result.captcha),
    };
  }
  @Post('register')
  @ContextOperation('visitor')
  async register(@Body() body: unknown, @Req() request: AuthRequest) {
    const user = await this.options.services.register.execute(
      validated(RegisterInputSchema, body),
      caller(request),
    );
    return { requestId: request.requestId, payload: UserSchema.parse(user) };
  }
  @Post('login')
  @HttpCode(200)
  @ContextOperation('visitor')
  async login(
    @Body() body: unknown,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.options.services.login.execute(
      validated(LoginInputSchema, body),
      caller(request),
    );
    this.options.cookies.setSession(response, result.sessionCredential);
    return {
      requestId: request.requestId,
      payload: UserSchema.parse(result.user),
    };
  }
  @Post('logout')
  @HttpCode(204)
  @ContextOperation('logout')
  async logout(
    @Body() body: unknown,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    validated(HealthQuerySchema, body ?? {});
    await this.options.services.logout.execute({
      ...(request.sessionCredential
        ? { sessionCredential: request.sessionCredential }
        : {}),
    });
    this.options.cookies.clearSession(response);
  }
  @Get('me')
  @ContextOperation('session')
  async me(@Query() query: unknown, @Req() request: AuthRequest) {
    validated(HealthQuerySchema, query);
    const result = await this.options.services.session.resolve({
      ...(request.sessionCredential
        ? { sessionCredential: request.sessionCredential }
        : {}),
    });
    return {
      requestId: request.requestId,
      payload: UserSchema.parse(result.user),
    };
  }
  @Put('password')
  @HttpCode(204)
  @ContextOperation('password')
  async password(
    @Body() body: unknown,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.options.services.password.execute(
      validated(PasswordInputSchema, body),
      caller(request),
    );
    this.options.cookies.clearSession(response);
  }
}

@Module({})
export class AuthHttpModule {
  static register(options: Omit<AuthHttpOptions, 'cookies'>): DynamicModule {
    return {
      module: AuthHttpModule,
      controllers: [AuthController],
      exports: [AuthGuard, AuthExceptionFilter, AUTH_OPTIONS],
      providers: [
        {
          provide: AUTH_OPTIONS,
          useValue: {
            ...options,
            cookies: new AuthCookiePolicy(options.config),
          },
        },
        AuthGuard,
        AuthExceptionFilter,
      ],
    };
  }
}
