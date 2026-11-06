import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createAuth } from '../../src/access/auth.ts';
import { signInConfig } from '../../src/access/config.ts';
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
    const off = { DB: env.DB, SIGN_IN_LIMIT: env.SIGN_IN_LIMIT, REGISTER_LIMIT: env.REGISTER_LIMIT };
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

  it('caps agent registrations from all addresses together', async () => {
    // A stand-in for the REGISTER_LIMIT binding that allows two calls. The
    // tests raise the real binding's limit so they can register freely.
    const keys: string[] = [];
    const registrations = {
      limit: ({ key }: RateLimitOptions) => {
        keys.push(key);
        return Promise.resolve({ success: keys.length <= 2 });
      },
    } satisfies RateLimit;
    const register = (address: string) =>
      handleAccess(
        new Request(`${ORIGIN}/api/auth/oauth2/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': address },
          body: JSON.stringify({
            client_name: 'Example Agent',
            redirect_uris: ['http://127.0.0.1:43110/callback'],
            token_endpoint_auth_method: 'none',
          }),
        }),
        { ...env, REGISTER_LIMIT: registrations },
      );

    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await register(freshAddress()))?.status);
    expect(statuses).toEqual([201, 201, 429]);
    expect(new Set(keys).size).toBe(1);
  });

  it('leaves the resource metadata unlimited, since it reads nothing', async () => {
    const address = freshAddress();
    for (let i = 0; i < 31; i += 1) {
      expect((await call('/.well-known/oauth-protected-resource/api/mcp', {}, address)).status).toBe(200);
    }
  });
});
