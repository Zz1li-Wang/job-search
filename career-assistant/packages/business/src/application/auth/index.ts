import type { AuthDependencies } from './ports.js';
import { AuthRateLimiter } from './support.js';
import { CaptchaService } from './captcha.js';
import { RegisterService } from './register.js';
import { LoginService } from './login.js';
import { AuthSessionService, LogoutService } from './session.js';
import { ChangePasswordService } from './password.js';

export function createAuthServices(dependencies: AuthDependencies) {
  const limiter = new AuthRateLimiter(dependencies);
  const captcha = new CaptchaService(dependencies, limiter);
  return {
    captcha,
    register: new RegisterService(dependencies, limiter, captcha),
    login: new LoginService(dependencies, limiter, captcha),
    session: new AuthSessionService(dependencies),
    logout: new LogoutService(dependencies),
    password: new ChangePasswordService(dependencies, limiter),
  };
}
export type AuthServices = ReturnType<typeof createAuthServices>;
export type {
  AuthDependencies,
  AuthRepositories,
  Clock,
  PasswordHasher,
  TokenCodec,
  CaptchaImage,
} from './ports.js';
