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

describe('the sign-in rate limit', () => {
  it('refuses the 31st sign-in request in a minute from one address', async () => {
    const address = freshAddress();
    for (let i = 0; i < 30; i += 1) {
      expect((await call('/api/access/me', {}, address)).status).toBe(401);
    }

    const limited = await call('/api/access/me', {}, address);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((await call('/api/access/me', {}, freshAddress())).status).toBe(401);
  });

  /** A stand-in for the shared REGISTER_LIMIT binding that allows `allowed` calls and records their keys. */
  function sharedLimit(allowed: number): RateLimit & { readonly keys: string[] } {
    const keys: string[] = [];
    return {
      keys,
      limit: ({ key }: RateLimitOptions) => {
        keys.push(key);
        return Promise.resolve({ success: keys.length <= allowed });
      },
    };
  }

  const validRegistration = {
    client_name: 'Example Agent',
    redirect_uris: ['http://127.0.0.1:43110/callback'],
    token_endpoint_auth_method: 'none',
  };

  function register(address: string, shared: RateLimit, body: unknown = validRegistration): Promise<Response | null> {
    return handleAccess(
      new Request(`${ORIGIN}/api/auth/oauth2/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': address },
        body: JSON.stringify(body),
      }),
      { ...env, REGISTER_LIMIT: shared },
    );
  }

  // The tests raise the real REGISTER_LIMIT so they can register freely, so
  // these use a stand-in for it; test/node/routing.ts checks its configured
  // value. REGISTER_ADDRESS_LIMIT is the binding as wrangler.jsonc sets it.
  it('caps agent registrations from all addresses together', async () => {
    const shared = sharedLimit(2);

    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await register(freshAddress(), shared))?.status);
    expect(statuses).toEqual([201, 201, 429]);
    expect(new Set(shared.keys).size).toBe(1);
  });

  it('refuses a fourth registration a minute from one address, without spending the shared cap', async () => {
    const shared = sharedLimit(1_000);
    const address = freshAddress();

    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await register(address, shared))?.status);
    expect(statuses).toEqual([201, 201, 201, 429]);
    expect(shared.keys).toHaveLength(3);
    expect((await register(freshAddress(), shared))?.status).toBe(201);
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
      expect((await register(freshAddress(), sharedLimit(1_000)))?.status).toBe(201);
      expect(await registrationsOn(env.DB, day)).toBe(2);
      const malformed = await register(freshAddress(), sharedLimit(1_000), { client_name: 'No Redirect' });
      expect(malformed?.status).toBe(400);
      expect(await registrationsOn(env.DB, day)).toBe(3);
    });
  });

  it('refuses registration once the day’s budget is spent, until 00:00 UTC, writing nothing', async () => {
    await withRegistrationsToday(REGISTRATIONS_PER_DAY, async (day) => {
      const clients = await env.DB.prepare('SELECT count(*) AS n FROM auth_oauth_client').first<{ n: number }>();

      const response = await register(freshAddress(), sharedLimit(1_000));
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
      const shared = sharedLimit(1_000);
      const responses = await Promise.all(Array.from({ length: 5 }, () => register(freshAddress(), shared)));

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
