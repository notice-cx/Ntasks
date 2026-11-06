import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createAuth } from '../../src/access/auth.ts';
import { signInConfig } from '../../src/access/config.ts';
import { registrationDay, registrationsOn, REGISTRATIONS_PER_DAY } from '../../src/access/grants.ts';
import { handleAccess } from '../../src/access/routes.ts';
import { refusal, verifyRequest } from '../../src/access/verify.ts';
import { call, freshAddress, ORIGIN } from './client.ts';

describe('the sign-in tables', () => {
  it('match the schema Better Auth expects, column for column', async () => {
    const config = signInConfig(env);
    expect(config).not.toBeNull();
    const context = await createAuth(env.DB, config!, { validateSchema: true }).$context;

    expect(context.checkSchema).toBeTypeOf('function');
    await expect(context.checkSchema?.()).resolves.toBeUndefined();
  });
});

describe('the sign-in settings', () => {
  const valid = {
    NTASKS_ORIGIN: 'https://ntasks.example.com',
    AUTH_SECRET: 'x'.repeat(32),
    GITHUB_CLIENT_ID: 'id',
    GITHUB_CLIENT_SECRET: 'secret',
    OWNER_GITHUB_IDS: '1001, 1002',
  };

  it('read an https origin, a long secret and numeric GitHub ids', () => {
    expect(signInConfig(valid)).toMatchObject({
      origin: 'https://ntasks.example.com',
      secure: true,
      owners: new Set(['1001', '1002']),
    });
  });

  it('accept a local http origin without the Secure cookie flag', () => {
    expect(signInConfig({ ...valid, NTASKS_ORIGIN: 'http://localhost:8787' })).toMatchObject({ secure: false });
  });

  it.each([
    ['an http origin that is not local', { NTASKS_ORIGIN: 'http://ntasks.example.com' }],
    ['an origin with a path', { NTASKS_ORIGIN: 'https://ntasks.example.com/app' }],
    ['a secret under 32 characters', { AUTH_SECRET: 'short' }],
    ['a GitHub login instead of an id', { OWNER_GITHUB_IDS: 'octocat' }],
    ['no owners', { OWNER_GITHUB_IDS: '' }],
    ['no GitHub client', { GITHUB_CLIENT_ID: '' }],
  ])('turn sign-in off with %s', (_, change) => {
    expect(signInConfig({ ...valid, ...change })).toBeNull();
  });

  it('refuse every caller while sign-in is off', async () => {
    const off = {
      DB: env.DB,
      SIGN_IN_LIMIT: env.SIGN_IN_LIMIT,
      REGISTER_LIMIT: env.REGISTER_LIMIT,
      REGISTER_ADDRESS_LIMIT: env.REGISTER_ADDRESS_LIMIT,
      TASK_STORE: env.TASK_STORE,
    };
    const request = new Request(`${ORIGIN}/api/access/me`, {
      headers: { authorization: 'Bearer some-token-of-sixteen-or-more' },
    });

    const verification = await verifyRequest(request, off);
    expect(verification).toEqual({ ok: false, reason: 'not_configured' });
    expect(verification.ok ? 0 : refusal(verification, {}).status).toBe(503);
    const page = await handleAccess(new Request(`${ORIGIN}/sign-in`), off);
    expect(page?.status).toBe(503);
  });
});

describe('a request body', () => {
  it('is refused once it passes 16 KiB, even with no Content-Length', async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode('a'.repeat(4096));
    // Endless unless the reader stops: proves the limit holds while reading.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const request = new Request(`${ORIGIN}/sign-in`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        'cf-connecting-ip': freshAddress(),
      },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(request.headers.get('content-length')).toBeNull();

    const response = await handleAccess(request, env);
    expect(response?.status).toBe(413);
    expect(pulled).toBeLessThan(10);
  });
});

// Cloudflare's rate limiting binding counts in fixed windows of a period, so
// a test that counts requests against the real binding fails whenever its
// requests straddle the start of a new window. These tests drive the limits
// with stand-ins that have no clock; test/node/routing.ts checks the limits
// wrangler.jsonc sets.
describe('the sign-in rate limit', () => {
  /**
   * A stand-in for a rate limiting binding: it allows `allowed` calls for
   * each key, for as long as the test runs, and records every key it is asked.
   */
  function limiter(allowed: number): RateLimit & { readonly keys: string[] } {
    const keys: string[] = [];
    return {
      keys,
      limit: ({ key }: RateLimitOptions) => {
        keys.push(key);
        return Promise.resolve({ success: keys.filter((asked) => asked === key).length <= allowed });
      },
    };
  }

  /** Limits that never refuse in a test. */
  const OPEN = 1_000;

  it('refuses the 31st sign-in request from one address', async () => {
    const signIn = limiter(30);
    const me = (address: string) =>
      handleAccess(new Request(`${ORIGIN}/api/access/me`, { headers: { 'cf-connecting-ip': address } }), {
        ...env,
        SIGN_IN_LIMIT: signIn,
      });
    const address = freshAddress();
    for (let i = 0; i < 30; i += 1) expect((await me(address))?.status).toBe(401);

    const limited = await me(address);
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get('retry-after')).toBe('60');
    expect((await me(freshAddress()))?.status).toBe(401);
    expect(new Set(signIn.keys).size).toBe(2);
  });

  const validRegistration = {
    client_name: 'Example Agent',
    redirect_uris: ['http://127.0.0.1:43110/callback'],
    token_endpoint_auth_method: 'none',
  };

  function register(
    address: string,
    limits: { readonly shared?: RateLimit; readonly fromAddress?: RateLimit } = {},
    body: unknown = validRegistration,
  ): Promise<Response | null> {
    return handleAccess(
      new Request(`${ORIGIN}/api/auth/oauth2/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': address },
        body: JSON.stringify(body),
      }),
      {
        ...env,
        SIGN_IN_LIMIT: limiter(OPEN),
        REGISTER_LIMIT: limits.shared ?? limiter(OPEN),
        REGISTER_ADDRESS_LIMIT: limits.fromAddress ?? limiter(OPEN),
      },
    );
  }

  it('caps agent registrations from all addresses together, under one key', async () => {
    const shared = limiter(2);

    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await register(freshAddress(), { shared }))?.status);
    expect(statuses).toEqual([201, 201, 429]);
    expect(shared.keys).toEqual(['registrations', 'registrations', 'registrations']);
  });

  it('refuses a fourth registration from one address, without spending the shared cap', async () => {
    const shared = limiter(OPEN);
    const fromAddress = limiter(3);
    const address = freshAddress();

    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await register(address, { shared, fromAddress }))?.status);
    expect(statuses).toEqual([201, 201, 201, 429]);
    expect(fromAddress.keys).toEqual([address, address, address, address]);
    expect(shared.keys).toHaveLength(3);
    expect((await register(freshAddress(), { shared, fromAddress }))?.status).toBe(201);
  });

  /** Sets today's count of registrations, and clears it after the test. */
  async function withRegistrationsToday(count: number, test: (day: string) => Promise<void>): Promise<void> {
    const day = registrationDay();
    await env.DB.prepare(
      `INSERT INTO access_registration_days (day, registrations) VALUES (?, ?)
       ON CONFLICT (day) DO UPDATE SET registrations = excluded.registrations`,
    )
      .bind(day, count)
      .run();
    try {
      await test(day);
    } finally {
      await env.DB.prepare('DELETE FROM access_registration_days WHERE day = ?').bind(day).run();
    }
  }

  it('counts every registration that reaches the library in D1, failed ones too', async () => {
    await withRegistrationsToday(1, async (day) => {
      expect((await register(freshAddress()))?.status).toBe(201);
      expect(await registrationsOn(env.DB, day)).toBe(2);
      const malformed = await register(freshAddress(), {}, { client_name: 'No Redirect' });
      expect(malformed?.status).toBe(400);
      expect(await registrationsOn(env.DB, day)).toBe(3);
    });
  });

  it('refuses registration once the day’s budget is spent, until 00:00 UTC, writing nothing', async () => {
    await withRegistrationsToday(REGISTRATIONS_PER_DAY, async (day) => {
      const clients = await env.DB.prepare('SELECT count(*) AS n FROM auth_oauth_client').first<{ n: number }>();

      const response = await register(freshAddress());
      expect(response?.status).toBe(429);
      expect(await response?.json()).toEqual({ error: 'registration_budget_spent' });
      const retryAfter = Number(response?.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(86_400);
      expect(await registrationsOn(env.DB, day)).toBe(REGISTRATIONS_PER_DAY);
      expect(await env.DB.prepare('SELECT count(*) AS n FROM auth_oauth_client').first<{ n: number }>()).toEqual(
        clients,
      );
    });
  });

  it('lets registrations arriving at once take only what is left of the budget', async () => {
    await withRegistrationsToday(REGISTRATIONS_PER_DAY - 2, async (day) => {
      const responses = await Promise.all(Array.from({ length: 5 }, () => register(freshAddress())));

      const statuses = responses.map((response) => response?.status).sort();
      expect(statuses).toEqual([201, 201, 429, 429, 429]);
      expect(await registrationsOn(env.DB, day)).toBe(REGISTRATIONS_PER_DAY);
    });
  });

  it('leaves the resource metadata unlimited, since it reads nothing', async () => {
    const address = freshAddress();
    for (let i = 0; i < 31; i += 1) {
      expect((await call('/.well-known/oauth-protected-resource/api/mcp', {}, address)).status).toBe(200);
    }
  });
});
