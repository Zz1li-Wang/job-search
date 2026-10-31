import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { AUTH_POLICY } from '../../domain/auth/policy.js';
import { AuthError } from '../../domain/auth/errors.js';
import type { PasswordHasher } from '../../application/auth/ports.js';

/** 每进程有界计算门，等待者继承释放的许可，不无限排队占用内存。 */
export class HashCalculationGate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(
    private readonly parallelism: number = AUTH_POLICY.hashParallelism,
    private readonly queueLimit: number = AUTH_POLICY.hashQueueLimit,
  ) {
    if (
      !Number.isInteger(parallelism) ||
      parallelism < 1 ||
      !Number.isInteger(queueLimit) ||
      queueLimit < 0
    )
      throw Error('密码计算门配置无效');
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active < this.parallelism) this.active++;
    else {
      if (this.waiting.length >= this.queueLimit)
        throw new AuthError('AUTH_RATE_LIMITED', 1);
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      return await operation();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export async function createPasswordHasher(): Promise<PasswordHasher> {
  const gate = new HashCalculationGate();
  const policy = AUTH_POLICY.scrypt;
  function derive(password: string, salt: Buffer): Promise<Buffer> {
    return gate.run(
      () =>
        new Promise<Buffer>((resolve, reject) => {
          scrypt(
            password,
            salt,
            policy.keyBytes,
            { N: policy.N, r: policy.r, p: policy.p, maxmem: policy.maxmem },
            (error, key) => (error ? reject(error) : resolve(key)),
          );
        }),
    );
  }
  async function hash(password: string): Promise<string> {
    const salt = randomBytes(policy.saltBytes);
    const key = await derive(password, salt);
    return [
      'scrypt',
      policy.N,
      policy.r,
      policy.p,
      salt.toString('base64url'),
      key.toString('base64url'),
    ].join('$');
  }
  const dummyHash = await hash(randomBytes(32).toString('base64url'));
  return {
    hash,
    dummyHash,
    async verify(password, encoded) {
      const parts = encoded.split('$');
      if (
        parts.length !== 6 ||
        parts[0] !== 'scrypt' ||
        parts[1] !== String(policy.N) ||
        parts[2] !== String(policy.r) ||
        parts[3] !== String(policy.p)
      )
        return false;
      const salt = Buffer.from(parts[4] ?? '', 'base64url');
      const expected = Buffer.from(parts[5] ?? '', 'base64url');
      if (
        salt.length !== policy.saltBytes ||
        expected.length !== policy.keyBytes
      )
        return false;
      return timingSafeEqual(expected, await derive(password, salt));
    },
  };
}
