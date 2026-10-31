import type { Response } from 'express';
import type { AuthConfig } from '@career/config';
import { AUTH_POLICY } from '@career/business';
import {
  SessionCredentialInputSchema,
  type AuthErrorCode,
} from '@career/contracts';
import { BadRequestException, HttpStatus } from '@nestjs/common';

export const CredentialSchema =
  SessionCredentialInputSchema.shape.sessionCredential.unwrap();
/** 固定HostOnly Cookie属性，不能由请求体或Host头决定安全设置。 */
export class AuthCookiePolicy {
  readonly isSecure: boolean;
  readonly sessionName: string;
  readonly visitorName: string;
  constructor(config: AuthConfig) {
    this.isSecure = config.AUTH_PUBLIC_ORIGIN.startsWith('https://');
    this.sessionName = this.isSecure
      ? '__Host-career_session'
      : 'career_session_dev';
    this.visitorName = this.isSecure
      ? '__Host-career_visitor'
      : 'career_visitor_dev';
  }
  read(header: string | undefined, name: string): string | undefined {
    const candidates = (header ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${name}=`));
    if (candidates.length > 1) throw new BadRequestException();
    if (candidates.length === 0) return undefined;
    return candidates[0]?.slice(name.length + 1);
  }
  setVisitor(response: Response, value: string) {
    this.write(
      response,
      this.visitorName,
      value,
      AUTH_POLICY.captchaLifetimeMs / 1000,
    );
  }
  setSession(response: Response, value: string) {
    this.write(
      response,
      this.sessionName,
      value,
      AUTH_POLICY.sessionLifetimeMs / 1000,
    );
  }
  clearSession(response: Response) {
    this.write(response, this.sessionName, '', 0);
  }
  private write(
    response: Response,
    name: string,
    value: string,
    maxAge: number,
  ) {
    response.append(
      'Set-Cookie',
      `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.isSecure ? '; Secure' : ''}`,
    );
  }
}

/** 领域拒绝到HTTP的映射仅存在协议层，不放进Entity或Service。 */
export const AUTH_HTTP_STATUS: Readonly<Record<AuthErrorCode, number>> =
  Object.freeze({
    AUTH_INVALID_CAPTCHA: HttpStatus.BAD_REQUEST,
    AUTH_INVALID_CREDENTIALS: HttpStatus.UNAUTHORIZED,
    AUTH_UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
    AUTH_USERNAME_CONFLICT: HttpStatus.CONFLICT,
    AUTH_VERSION_CONFLICT: HttpStatus.CONFLICT,
    AUTH_CONTEXT_STALE: HttpStatus.CONFLICT,
    AUTH_RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
    AUTH_DEPENDENCY_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  });
