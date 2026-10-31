import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  createPersistence,
  createAuthSecurity,
  createAuthServices,
  type PasswordHasher,
  type Clock,
  type AuthServices,
  type AuthDependencies,
} from '@career/business';
import { ApiConfigSchema, AuthConfigSchema } from '@career/config';
import {
  CaptchaResponseSchema,
  UserResponseSchema,
  type CaptchaDto,
  type AuthContextDto,
  type RegisterInputDto,
  type UserDto,
  type LoginServiceResultDto,
} from '@career/contracts';
import { createApiApplication } from '../../apps/api/src/app.js';

export const TEST_PASSWORD = 'fictional-password-123';
export const TEST_NEW_PASSWORD = 'fictional-new-password-456';
export const TEST_CAPTCHA_ANSWER = '234567';
export const TEST_ORIGIN = 'http://127.0.0.1:5173';
export class MutableClock implements Clock {
  private time = Date.now();
  now() {
    return new Date(this.time);
  }
  advance(milliseconds: number) {
    this.time += milliseconds;
  }
}
/** 替身只用于用例编排；实际scrypt另有真实适配器和浏览器测试。 */
export const fakePasswords: PasswordHasher = {
  hash: async (password) =>
    `fixture$${createHash('sha256').update(password).digest('hex')}`,
  verify: async (password, encoded) =>
    encoded === (await fakePasswords.hash(password)),
  dummyHash: 'fixture$not-a-user',
};
export function uniqueUsername() {
  return `u${randomUUID().replaceAll('-', '').slice(0, 14)}`;
}
export { isolatedDatabaseUrl } from './database.js';
import { isolatedDatabaseUrl } from './database.js';

interface AuthFixture {
  persistence: ReturnType<typeof createPersistence>;
  clock: MutableClock;
  security: Awaited<ReturnType<typeof createAuthSecurity>>;
  dependencies: AuthDependencies;
  services: AuthServices;
  caller: Pick<AuthContextDto, 'requesterDigest'>;
  challenge(): Promise<{
    input: Pick<RegisterInputDto, 'captchaId' | 'captchaAnswer'>;
    caller: AuthContextDto;
  }>;
  register(username?: string): Promise<{ username: string; user: UserDto }>;
  login(username: string, password?: string): Promise<LoginServiceResultDto>;
  close(): Promise<void>;
}
export async function makeAuthFixture(
  passwords = fakePasswords,
): Promise<AuthFixture> {
  const databaseUrl = isolatedDatabaseUrl();
  const persistence = createPersistence(databaseUrl);
  const clock = new MutableClock();
  const security = await createAuthSecurity(
    {
      tokenPepper: randomBytes(32).toString('hex'),
      csrfSecret: randomBytes(32).toString('hex'),
    },
    { answer: () => TEST_CAPTCHA_ANSWER, passwords },
  );
  const dependencies = {
    unitOfWork: persistence.unitOfWork,
    repositories: persistence.auth,
    clock,
    ...security,
  };
  const services: AuthServices = createAuthServices(dependencies);
  const caller = {
    requesterDigest: security.tokens.digest('network-origin', randomUUID()),
  };
  async function challenge() {
    const result = await services.captcha.issue(caller);
    return {
      input: {
        captchaId: result.captcha.captchaId,
        captchaAnswer: TEST_CAPTCHA_ANSWER,
      },
      caller: {
        ...caller,
        visitorDigest: security.tokens.digest(
          'visitor',
          result.visitorCredential,
        ),
        csrfToken: result.captcha.csrfToken,
      },
    };
  }
  async function register(username = uniqueUsername()) {
    const ticket = await challenge();
    const user = await services.register.execute(
      { ...ticket.input, username, password: TEST_PASSWORD },
      ticket.caller,
    );
    return { username, user };
  }
  async function login(username: string, password = TEST_PASSWORD) {
    const ticket = await challenge();
    return services.login.execute(
      { ...ticket.input, username, password },
      ticket.caller,
    );
  }
  return {
    persistence,
    clock,
    security,
    services,
    dependencies,
    caller,
    challenge,
    register,
    login,
    close: () => persistence.close(),
  };
}
export async function makeAuthHttpFixture() {
  const clock = new MutableClock();
  const api = ApiConfigSchema.parse({
    DATABASE_URL: isolatedDatabaseUrl(),
    SERVICE_AUTH_TOKEN: randomBytes(32).toString('hex'),
  });
  const auth = AuthConfigSchema.parse({
    AUTH_PUBLIC_ORIGIN: TEST_ORIGIN,
    AUTH_TOKEN_PEPPER: randomBytes(32).toString('hex'),
    AUTH_CSRF_SECRET: randomBytes(32).toString('hex'),
  });
  const runtime = await createApiApplication(
    { api, auth },
    { clock, answer: () => TEST_CAPTCHA_ANSWER, passwords: fakePasswords },
  );
  await runtime.app.listen(0, '127.0.0.1');
  const base = await runtime.app.getUrl();
  return {
    base,
    clock,
    close: runtime.close,
    client: () => new AuthHttpClient(base),
  };
}
export class AuthHttpClient {
  readonly cookies = new Map<string, string>();
  constructor(readonly base: string) {}
  cookieHeader() {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
  async request(
    method: string,
    path: string,
    body?: unknown,
    csrfToken?: string,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${this.base}/api/v1/auth/${path}`, {
      method,
      headers: {
        origin: TEST_ORIGIN,
        cookie: this.cookieHeader(),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const first = cookie.split(';')[0] ?? '';
      const index = first.indexOf('=');
      const name = first.slice(0, index);
      const value = first.slice(index + 1);
      if (!value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
  async challenge(): Promise<CaptchaDto> {
    const response = await this.request('GET', 'captcha');
    return CaptchaResponseSchema.parse(await response.json()).payload;
  }
  async credentials(
    mode: 'register' | 'login',
    username: string,
    password = TEST_PASSWORD,
  ) {
    const captcha = await this.challenge();
    return this.request(
      'POST',
      mode,
      {
        username,
        password,
        captchaId: captcha.captchaId,
        captchaAnswer: TEST_CAPTCHA_ANSWER,
      },
      captcha.csrfToken,
    );
  }
  async signedIn(username = uniqueUsername()) {
    const registered = await this.credentials('register', username);
    if (registered.status !== 201) throw Error('测试注册失败');
    const response = await this.credentials('login', username);
    if (response.status !== 200) throw Error('测试登录失败');
    return UserResponseSchema.parse(await response.json()).payload;
  }
}
