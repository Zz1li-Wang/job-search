import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from 'pg';
import {
  createAuthServices,
  createPersistence,
  AUTH_POLICY,
  AccountEntity,
  SessionEntity,
  ChallengeEntity,
  type PasswordHasher,
  type AuthRepositories,
} from '@career/business';
import {
  makeAuthFixture,
  fakePasswords,
  uniqueUsername,
  TEST_PASSWORD,
  TEST_NEW_PASSWORD,
  TEST_CAPTCHA_ANSWER,
  isolatedDatabaseUrl,
} from '../fixtures/auth.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});
async function fixture(passwords = fakePasswords) {
  const current = await makeAuthFixture(passwords);
  cleanups.push(current.close);
  return current;
}
function gate() {
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release: () => release() };
}

describe('认证Service真实事务与并发', () => {
  it('数据库拒绝负计数和不存在账号的会话', async () => {
    const current = await fixture();
    const client = new Client({ connectionString: isolatedDatabaseUrl() });
    await client.connect();
    try {
      await expect(
        client.query(
          'INSERT INTO auth_attempts(identity_digest,consecutive_failures,updated_at) VALUES($1,-1,NOW())',
          [current.security.tokens.digest('identity', randomUUID())],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        client.query(
          'INSERT INTO sessions(id,user_id,token_digest,auth_epoch,expires_at,created_at) VALUES($1,$2,$3,0,NOW(),NOW())',
          [
            randomUUID(),
            randomUUID(),
            current.security.tokens.digest('session', randomUUID()),
          ],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.end();
    }
  });
  it('真实迁移结果与Prisma模型无漂移', async () => {
    const { stdout } = await promisify(execFile)(
      'pnpm',
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'packages/business/prisma/schema.prisma',
        '--exit-code',
      ],
      { env: process.env },
    );
    expect(stdout).toContain('No difference detected');
  });
  it('同一验证码两条独立事务竞争，至多一个消费并创建账号', async () => {
    const current = await fixture();
    const challenge = await current.challenge();
    const username = uniqueUsername();
    const input = { ...challenge.input, username, password: TEST_PASSWORD };
    const outcomes = await Promise.allSettled([
      current.services.register.execute(input, challenge.caller),
      current.services.register.execute(input, challenge.caller),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.find((outcome) => outcome.status === 'rejected'),
    ).toMatchObject({ reason: { code: 'AUTH_INVALID_CAPTCHA' } });
    const stored = await current.persistence.unitOfWork.run((context) =>
      current.persistence
        .auth(context)
        .challenges.getForUpdate(input.captchaId),
    );
    expect(stored?.snapshot().consumedAt).not.toBeNull();
  });
  it('不同挑战抢大小写用户名，唯一约束仅允许一个账号', async () => {
    const current = await fixture();
    const username = uniqueUsername();
    const tickets = await Promise.all([
      current.challenge(),
      current.challenge(),
    ]);
    const outcomes = await Promise.allSettled(
      tickets.map((ticket, index) =>
        current.services.register.execute(
          {
            ...ticket.input,
            username: index ? username.toUpperCase() : username,
            password: TEST_PASSWORD,
          },
          ticket.caller,
        ),
      ),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.find((outcome) => outcome.status === 'rejected'),
    ).toMatchObject({ reason: { code: 'AUTH_USERNAME_CONFLICT' } });
  });
  it('两个API连接池共享IP预算，不能并发超发', async () => {
    const current = await fixture();
    const other = createPersistence(isolatedDatabaseUrl());
    cleanups.push(() => other.close());
    const second = createAuthServices({
      ...current.dependencies,
      unitOfWork: other.unitOfWork,
      repositories: other.auth,
    });
    const caller = {
      ...current.caller,
      visitorDigest: 'a'.repeat(64),
      csrfToken: 'b'.repeat(64),
    };
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? second : current.services).register.execute(
          {
            username: uniqueUsername(),
            password: TEST_PASSWORD,
            captchaId: randomUUID(),
            captchaAnswer: TEST_CAPTCHA_ANSWER,
          },
          caller,
        ),
      ),
    );
    const codes = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason.code as string] : [],
    );
    expect(
      codes.filter((code) => code === 'AUTH_INVALID_CAPTCHA'),
    ).toHaveLength(10);
    expect(codes.filter((code) => code === 'AUTH_RATE_LIMITED')).toHaveLength(
      10,
    );
  });
  it('并发密码失败累计准确，不存在的用户名同样冷却', async () => {
    const current = await fixture();
    const username = uniqueUsername();
    const tickets = await Promise.all(
      Array.from({ length: AUTH_POLICY.failureLimit }, () =>
        current.challenge(),
      ),
    );
    const outcomes = await Promise.allSettled(
      tickets.map((ticket) =>
        current.services.login.execute(
          { ...ticket.input, username, password: TEST_PASSWORD },
          ticket.caller,
        ),
      ),
    );
    expect(
      outcomes.every(
        (outcome) =>
          outcome.status === 'rejected' &&
          outcome.reason.code === 'AUTH_INVALID_CREDENTIALS',
      ),
    ).toBe(true);
    await expect(current.login(username)).rejects.toMatchObject({
      code: 'AUTH_RATE_LIMITED',
    });
    const identity = current.security.tokens.digest('identity', username);
    const attempt = await current.persistence.unitOfWork.run((context) =>
      current.persistence.auth(context).attempts.getForUpdate(identity),
    );
    expect(attempt.snapshot().consecutiveFailures).toBe(5);
  });
  it('登录密码计算期间改密，不能补建旧版本会话', async () => {
    const current = await fixture();
    const registered = await current.register();
    const signed = await current.login(registered.username);
    const actor = (
      await current.services.session.resolve({
        sessionCredential: signed.sessionCredential,
      })
    ).actor;
    const started = gate();
    const release = gate();
    const passwords: PasswordHasher = {
      ...fakePasswords,
      verify: async (...arguments_) => {
        started.release();
        await release.ready;
        return fakePasswords.verify(...arguments_);
      },
    };
    const delayed = createAuthServices({ ...current.dependencies, passwords });
    const ticket = await current.challenge();
    const pending = delayed.login.execute(
      {
        ...ticket.input,
        username: registered.username,
        password: TEST_PASSWORD,
      },
      ticket.caller,
    );
    const result = pending.then(
      () => 'unexpected-success',
      (error) => error.code as string,
    );
    try {
      await started.ready;
      await current.services.password.execute(
        { currentPassword: TEST_PASSWORD, newPassword: TEST_NEW_PASSWORD },
        { ...current.caller, actor },
      );
    } finally {
      release.release();
    }
    expect(await result).toBe('AUTH_INVALID_CREDENTIALS');
    await expect(
      current.services.session.resolve({
        sessionCredential: signed.sessionCredential,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_UNAUTHENTICATED' });
  });
  it('两个改密运算并发，只有一个版本提交且全部旧会话失效', async () => {
    const current = await fixture();
    const registered = await current.register();
    const signed = await current.login(registered.username);
    const actor = (
      await current.services.session.resolve({
        sessionCredential: signed.sessionCredential,
      })
    ).actor;
    const both = gate();
    let arrived = 0;
    const passwords: PasswordHasher = {
      ...fakePasswords,
      hash: async (password) => {
        arrived++;
        if (arrived === 2) both.release();
        await both.ready;
        return fakePasswords.hash(password);
      },
    };
    const concurrent = createAuthServices({
      ...current.dependencies,
      passwords,
    });
    const outcomes = await Promise.allSettled(
      [TEST_NEW_PASSWORD, 'another-new-password-789'].map((newPassword) =>
        concurrent.password.execute(
          { currentPassword: TEST_PASSWORD, newPassword },
          { ...current.caller, actor },
        ),
      ),
    );
    expect(arrived).toBe(2);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.find((outcome) => outcome.status === 'rejected'),
    ).toMatchObject({ reason: { code: 'AUTH_VERSION_CONFLICT' } });
    const account = await current.persistence.unitOfWork.run((context) =>
      current.persistence.auth(context).accounts.getById(registered.user.id),
    );
    expect(account?.snapshot().authEpoch).toBe(1);
    await expect(
      current.services.session.resolve({
        sessionCredential: signed.sessionCredential,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_UNAUTHENTICATED' });
  });
  it('哈希失败不创建账号，先前验证码消费不恢复', async () => {
    const current = await fixture();
    const ticket = await current.challenge();
    const username = uniqueUsername();
    const broken = createAuthServices({
      ...current.dependencies,
      passwords: {
        ...fakePasswords,
        hash: async () => {
          throw Error('synthetic private adapter failure');
        },
      },
    });
    await expect(
      broken.register.execute(
        { ...ticket.input, username, password: TEST_PASSWORD },
        ticket.caller,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_DEPENDENCY_UNAVAILABLE' });
    expect(
      await current.persistence.unitOfWork.run((context) =>
        current.persistence.auth(context).accounts.getByUsername(username),
      ),
    ).toBeNull();
    await expect(
      current.services.register.execute(
        { ...ticket.input, username, password: TEST_PASSWORD },
        ticket.caller,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CAPTCHA' });
  });
  it('会话插入失败回滚失败计数重置，消费动作保留', async () => {
    const current = await fixture();
    const registered = await current.register();
    await expect(
      current.login(registered.username, TEST_NEW_PASSWORD),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    const broken = createAuthServices({
      ...current.dependencies,
      repositories: (context) => {
        const repositories = current.persistence.auth(context);
        return {
          ...repositories,
          sessions: {
            ...repositories.sessions,
            insert: async () => {
              throw Error('synthetic database failure');
            },
          },
        };
      },
    });
    const ticket = await current.challenge();
    await expect(
      broken.login.execute(
        {
          ...ticket.input,
          username: registered.username,
          password: TEST_PASSWORD,
        },
        ticket.caller,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_DEPENDENCY_UNAVAILABLE' });
    const attempt = await current.persistence.unitOfWork.run((context) =>
      current.persistence
        .auth(context)
        .attempts.getForUpdate(
          current.security.tokens.digest('identity', registered.username),
        ),
    );
    expect(attempt.snapshot().consecutiveFailures).toBe(1);
    const challenge = await current.persistence.unitOfWork.run((context) =>
      current.persistence
        .auth(context)
        .challenges.getForUpdate(ticket.input.captchaId),
    );
    expect(challenge?.snapshot().consumedAt).not.toBeNull();
  });
  it('撤销会话失败时密码更新一起回滚', async () => {
    const current = await fixture();
    const registered = await current.register();
    const signed = await current.login(registered.username);
    const actor = (
      await current.services.session.resolve({
        sessionCredential: signed.sessionCredential,
      })
    ).actor;
    const broken = createAuthServices({
      ...current.dependencies,
      repositories: (context) => {
        const repositories = current.persistence.auth(context);
        return {
          ...repositories,
          sessions: {
            ...repositories.sessions,
            setAllRevokedAt: async () => {
              throw Error('synthetic revoke failure');
            },
          },
        };
      },
    });
    await expect(
      broken.password.execute(
        { currentPassword: TEST_PASSWORD, newPassword: TEST_NEW_PASSWORD },
        { ...current.caller, actor },
      ),
    ).rejects.toMatchObject({ code: 'AUTH_DEPENDENCY_UNAVAILABLE' });
    expect(
      (
        await current.services.session.resolve({
          sessionCredential: signed.sessionCredential,
        })
      ).user.id,
    ).toBe(registered.user.id);
    const account = await current.persistence.unitOfWork.run((context) =>
      current.persistence.auth(context).accounts.getById(registered.user.id),
    );
    expect(account?.snapshot().authEpoch).toBe(0);
    expect(
      await fakePasswords.verify(
        TEST_PASSWORD,
        account!.snapshot().passwordHash,
      ),
    ).toBe(true);
  });
  it('密码计算不持事务，PNG失败不插入新挑战', async () => {
    const current = await fixture();
    let activeTransactions = 0;
    let inserted = 0;
    const passwords: PasswordHasher = {
      ...fakePasswords,
      hash: async (password) => {
        expect(activeTransactions).toBe(0);
        return fakePasswords.hash(password);
      },
      verify: async (...arguments_) => {
        expect(activeTransactions).toBe(0);
        return fakePasswords.verify(...arguments_);
      },
    };
    const services = createAuthServices({
      ...current.dependencies,
      passwords,
      unitOfWork: {
        run: (operation) =>
          current.persistence.unitOfWork.run(async (context) => {
            activeTransactions++;
            try {
              return await operation(context);
            } finally {
              activeTransactions--;
            }
          }),
      },
    });
    const ticket = await current.challenge();
    const username = uniqueUsername();
    await services.register.execute(
      { ...ticket.input, username, password: TEST_PASSWORD },
      ticket.caller,
    );
    const loginTicket = await current.challenge();
    await services.login.execute(
      { ...loginTicket.input, username, password: TEST_PASSWORD },
      loginTicket.caller,
    );
    const broken = createAuthServices({
      ...current.dependencies,
      images: {
        ...current.security.images,
        render: async () => {
          throw Error('synthetic image failure');
        },
      },
      repositories: (context) => {
        const repositories: AuthRepositories =
          current.persistence.auth(context);
        return {
          ...repositories,
          challenges: {
            ...repositories.challenges,
            insert: async (challenge) => {
              inserted++;
              await repositories.challenges.insert(challenge);
            },
          },
        };
      },
    });
    await expect(broken.captcha.issue(current.caller)).rejects.toMatchObject({
      code: 'AUTH_DEPENDENCY_UNAVAILABLE',
    });
    expect(inserted).toBe(0);
  });
  it('清理跳过已锁过期挑战，不删除仍有效记录', async () => {
    const current = await fixture();
    const ticket = await current.challenge();
    current.clock.advance(1000);
    const fresh = await current.challenge();
    const held = gate();
    const release = gate();
    let boundary = current.clock.now();
    const pending = current.persistence.unitOfWork.run(async (context) => {
      const locked = await current.persistence
        .auth(context)
        .challenges.getForUpdate(ticket.input.captchaId);
      boundary = locked!.snapshot().expiresAt;
      held.release();
      await release.ready;
    });
    try {
      await held.ready;
      // 只让第一个挑战过期，使用显式维护时间和第二条独立连接。
      const other = createPersistence(isolatedDatabaseUrl());
      cleanups.push(() => other.close());
      await other.unitOfWork.run((context) =>
        other.auth(context).pruneExpired(boundary, 100),
      );
    } finally {
      release.release();
    }
    await pending;
    const retained = await current.persistence.unitOfWork.run((context) =>
      current.persistence
        .auth(context)
        .challenges.getForUpdate(ticket.input.captchaId),
    );
    expect(retained).not.toBeNull();
    await current.persistence.unitOfWork.run((context) =>
      current.persistence.auth(context).pruneExpired(boundary, 100),
    );
    expect(
      await current.persistence.unitOfWork.run((context) =>
        current.persistence
          .auth(context)
          .challenges.getForUpdate(ticket.input.captchaId),
      ),
    ).toBeNull();
    expect(
      await current.persistence.unitOfWork.run((context) =>
        current.persistence
          .auth(context)
          .challenges.getForUpdate(fresh.input.captchaId),
      ),
    ).not.toBeNull();
  });
  it('单次清理跨表累计不超过100条', async () => {
    const current = await fixture();
    const old = new Date('2000-01-01T00:00:00.000Z');
    const deadline = new Date('2000-01-02T00:00:00.000Z');
    const user = new AccountEntity({
      id: randomUUID(),
      usernameNormalized: uniqueUsername(),
      passwordHash: 'fixture-hash',
      authEpoch: 0,
      createdAt: old,
      updatedAt: old,
      deletedAt: null,
    });
    const challenges = Array.from(
      { length: 60 },
      () =>
        new ChallengeEntity({
          id: randomUUID(),
          visitorDigest: 'a'.repeat(64),
          answerDigest: 'b'.repeat(64),
          createdAt: old,
          expiresAt: old,
          consumedAt: null,
        }),
    );
    const sessions = Array.from(
      { length: 60 },
      () =>
        new SessionEntity({
          id: randomUUID(),
          userId: user.snapshot().id,
          tokenDigest: current.security.tokens.digest('session', randomUUID()),
          createdAt: old,
          expiresAt: old,
          revokedAt: null,
          authEpoch: 0,
        }),
    );
    // 写入、被测清理与计数在同一事务，其他合法清理看不到尚未提交的过期样本。
    const remaining = await current.persistence.unitOfWork.run(
      async (context) => {
        const repositories = current.persistence.auth(context);
        await repositories.accounts.insertIfAbsent(user);
        for (const challenge of challenges)
          await repositories.challenges.insert(challenge);
        for (const session of sessions)
          await repositories.sessions.insert(session);
        await repositories.pruneExpired(deadline, 100);
        let retained = 0;
        for (const challenge of challenges)
          if (
            await repositories.challenges.getForUpdate(challenge.snapshot().id)
          )
            retained++;
        for (const session of sessions)
          if (await repositories.sessions.getById(session.snapshot().id))
            retained++;
        return retained;
      },
    );
    expect(remaining).toBe(20);
  });
});
