import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { verifyRequest } from '../../src/access/verify.ts';
import { Browser, call, locationOf, ORIGIN, OWNER_GITHUB_ID } from './client.ts';
import { standInForGitHub } from './github.ts';

standInForGitHub();

const SESSION_COOKIE = '__Secure-ntasks.session_token';

describe('owner sign-in with GitHub', () => {
  it('signs in an allowlisted GitHub account and names it as a person', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();

    const cookie = browser.cookie(SESSION_COOKIE);
    expect(cookie).toBeDefined();
    const response = await browser.me();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: 'person', name: `Person ${OWNER_GITHUB_ID}`, projects: 'all' });
  });

  it('keeps the GitHub token from sign-in encrypted', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();

    const row = await env.DB.prepare("SELECT access_token FROM auth_account WHERE provider_id = 'github' AND account_id = ?")
      .bind(String(OWNER_GITHUB_ID))
      .first<{ access_token: string }>();
    expect(row?.access_token).toBeTruthy();
    expect(row?.access_token).not.toContain('stand-in-token');
  });

  it('refuses a GitHub account that is not on the allowlist and creates no one', async () => {
    const browser = new Browser();
    const next = await browser.signInWithGitHub(2002);

    expect(next.pathname).toBe('/sign-in');
    expect(next.searchParams.get('error')).toBe('not_an_owner');
    expect(browser.cookie(SESSION_COOKIE)).toBeUndefined();
    const people = await env.DB.prepare("SELECT count(*) AS n FROM auth_account WHERE account_id = '2002'").first<{ n: number }>();
    expect(people?.n).toBe(0);

    const page = await browser.fetch(next.pathname + next.search);
    expect(await page.text()).toContain('This GitHub account may not sign in to this Ntasks.');
  });

  it('cuts off a signed-in owner whose GitHub id leaves the allowlist', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    const headers = { cookie: `${SESSION_COOKIE}=${browser.cookie(SESSION_COOKIE)}` };

    const still = await verifyRequest(new Request(`${ORIGIN}/api/access/me`, { headers }), env);
    expect(still.ok).toBe(true);
    const removed = await verifyRequest(new Request(`${ORIGIN}/api/access/me`, { headers }), { ...env, OWNER_GITHUB_IDS: '3003' });
    expect(removed).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses a session cookie whose signature does not match', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    const [token = ''] = decodeURIComponent(browser.cookie(SESSION_COOKIE) ?? '').split('.');
    browser.setCookie(SESSION_COOKIE, encodeURIComponent(`${token}.${'A'.repeat(43)}=`));

    const response = await browser.me();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_token' });
  });

  it('refuses a change signed by the session cookie but sent from another site', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();

    const response = await browser.fetch('/api/access/services', {
      method: 'POST',
      origin: 'https://elsewhere.example.com',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'cross_site_request' });
  });

  it('refuses a sign-in form posted from another site', async () => {
    const browser = new Browser();
    const response = await browser.fetch('/sign-in', { form: { action: 'github' }, origin: 'https://elsewhere.example.com' });
    expect(response.status).toBe(403);
  });

  it('signs out, and the old cookie no longer works', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    const cookie = browser.cookie(SESSION_COOKIE) ?? '';

    const signedOut = await browser.fetch('/sign-in', { form: { action: 'sign-out' } });
    expect(locationOf(signedOut).pathname).toBe('/sign-in');
    expect(browser.cookie(SESSION_COOKIE)).toBeUndefined();

    browser.setCookie(SESSION_COOKIE, cookie);
    expect((await browser.me()).status).toBe(401);
  });

  it('shows the sign-in page, and who is signed in once they are', async () => {
    const browser = new Browser();
    const before = await browser.fetch('/sign-in');
    expect(before.status).toBe(200);
    expect(before.headers.get('x-frame-options')).toBe('DENY');
    expect(await before.text()).toContain('Sign in with GitHub');

    await browser.signInAsOwner();
    const after = await browser.fetch('/sign-in');
    expect(await after.text()).toContain(`You are signed in as Person ${OWNER_GITHUB_ID}.`);
  });
});

describe('a request with no credential', () => {
  it('gets a bearer challenge naming the resource metadata', async () => {
    const response = await call('/api/access/me');

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp", scope="tasks:read tasks:write"`,
    );
  });

  it('is refused as invalid when its Authorization header is malformed', async () => {
    const response = await call('/api/access/me', { headers: { authorization: 'Basic abc' } });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });
});
