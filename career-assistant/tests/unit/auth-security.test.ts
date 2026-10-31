import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import {
  createAuthSecurity,
  createPasswordHasher,
  HashCalculationGate,
  AUTH_POLICY,
} from '@career/business';
import { fakePasswords } from '../fixtures/auth.js';

describe('真实密码与图片适配器', () => {
  it('正式scrypt参数随机盐、正确错误密码和畸形参数拒绝', async () => {
    const passwords = await createPasswordHasher();
    const started = performance.now();
    const first = await passwords.hash('synthetic-password-only');
    const durationMs = Math.round(performance.now() - started);
    const second = await passwords.hash('synthetic-password-only');
    expect(first).not.toBe(second);
    expect(first).toMatch(/^scrypt\$131072\$8\$1\$/);
    expect(await passwords.verify('synthetic-password-only', first)).toBe(true);
    expect(await passwords.verify('other-synthetic-password', first)).toBe(
      false,
    );
    expect(
      await passwords.verify('synthetic-password-only', passwords.dummyHash),
    ).toBe(false);
    expect(
      await passwords.verify('x', first.replace('131072', '1073741824')),
    ).toBe(false);
    expect(await passwords.verify('x', 'broken')).toBe(false);
    await mkdir('.artifacts', { recursive: true });
    await writeFile(
      '.artifacts/auth-crypto-profile.json',
      JSON.stringify(
        {
          algorithm: 'scrypt',
          N: AUTH_POLICY.scrypt.N,
          r: 8,
          p: 1,
          oneHashDurationMs: durationMs,
          observedProcessMaxRssKiB: process.resourceUsage().maxRSS,
          scope: '单个测试进程样本，不代表所有硬件或并发容量',
        },
        null,
        2,
      ),
    );
  });
  it('计算门容量和失败释放许可', async () => {
    const gate = new HashCalculationGate(1, 1);
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = gate.run(() => barrier);
    const second = gate.run(async () => 'queued');
    await expect(gate.run(async () => 'excess')).rejects.toMatchObject({
      code: 'AUTH_RATE_LIMITED',
    });
    release();
    await first;
    expect(await second).toBe('queued');
    await expect(
      gate.run(async () => {
        throw Error('synthetic failure');
      }),
    ).rejects.toThrow('synthetic failure');
    expect(await gate.run(async () => true)).toBe(true);
  });
  it('生产随机源、HMAC用途隔离、PNG可解码且无文字块', async () => {
    const security = await createAuthSecurity(
      { tokenPepper: 'p'.repeat(32), csrfSecret: 's'.repeat(32) },
      { passwords: fakePasswords },
    );
    const credential = security.tokens.credential();
    expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(security.tokens.credential()).not.toBe(credential);
    expect(security.tokens.digest('session', credential)).not.toBe(
      security.tokens.digest('visitor', credential),
    );
    expect(security.tokens.csrf('session', credential)).not.toBe(
      security.tokens.csrf('visitor', credential),
    );
    expect(security.tokens.matches('a', 'b')).toBe(false);
    for (let index = 0; index < 20; index++)
      expect(security.images.answer()).toMatch(/^[2-9]{6}$/);
    const data = Buffer.from(
      (await security.images.render('234567')).split(',')[1]!,
      'base64',
    );
    expect(data.readUInt32BE(16)).toBe(240);
    expect(data.readUInt32BE(20)).toBe(80);
    const chunks: string[] = [];
    let offset = 8;
    while (offset < data.length) {
      const size = data.readUInt32BE(offset);
      chunks.push(data.toString('ascii', offset + 4, offset + 8));
      offset += size + 12;
    }
    expect(chunks).not.toContain('tEXt');
    expect(chunks).not.toContain('iTXt');
    await expect(security.images.render('123456')).rejects.toThrow();
  });
});
