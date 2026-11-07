import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { signInAuthenticator } from '../../src/access/authenticator.ts';
import { mayReach } from '../../src/auth.ts';
import { Browser, connectAgent, createProject, ORIGIN, OWNER_GITHUB_ID } from './client.ts';
import { standInForGitHub } from './github.ts';

standInForGitHub();

const authenticator = signInAuthenticator(env);

/** The id of the person the allowlisted owner's GitHub account belongs to. */
async function ownerUserId(): Promise<string> {
  const row = await env.DB.prepare("SELECT user_id FROM auth_account WHERE provider_id = 'github' AND account_id = ?")
    .bind(String(OWNER_GITHUB_ID))
    .first<{ user_id: string }>();
  if (!row) throw new Error('the owner has not signed in');
  return row.user_id;
}

function bearer(token: string): Request {
  return new Request(`${ORIGIN}/api/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: '{}',
  });
}

describe('the authenticator the API layer calls', () => {
  it('signs in the owner with every scope', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    const request = new Request(`${ORIGIN}/api/tasks`, {
      headers: { cookie: `__Secure-ntasks.session_token=${browser.cookie('__Secure-ntasks.session_token')}` },
    });

    const signedIn = await authenticator.authenticate(request);
    const userId = await ownerUserId();
    expect(signedIn).toMatchObject({
      id: `person:${userId}`,
      name: `Person ${OWNER_GITHUB_ID}`,
      scopes: ['tasks:read', 'tasks:write', 'tasks:backup', 'tasks:restore'],
      projects: 'all',
      principal: { kind: 'person', userId },
    });
  });

  it('gives a read-only agent the read scope, its prefixed actor name and its projects', async () => {
    const granted = await createProject('Granted');
    const other = await createProject('Other');
    const browser = new Browser();
    await browser.signInAsOwner();
    const { client, tokens } = await connectAgent(browser, [granted], 'tasks:read offline_access');

    const request = bearer(tokens.access_token);
    const signedIn = await authenticator.authenticate(request);
    const userId = await ownerUserId();
    expect(signedIn).toMatchObject({
      id: `agent:${client.clientId}:${userId}`,
      name: 'agent:Example Agent',
      scopes: ['tasks:read'],
      principal: { kind: 'agent', clientId: client.clientId, userId },
    });
    expect(signedIn?.projects).toEqual(new Map([[granted, 'read']]));
    expect(signedIn && mayReach(signedIn, granted, 'read')).toBe(true);
    expect(signedIn && mayReach(signedIn, other, 'read')).toBe(false);
    // The body is still there for the MCP endpoint to read.
    expect(await request.text()).toBe('{}');
  });

  it('challenges a request with no credential, naming the resource metadata', async () => {
    const request = new Request(`${ORIGIN}/api/mcp`, { method: 'POST', body: '{}' });

    expect(await authenticator.authenticate(request)).toBeNull();
    const challenge = authenticator.challenge(request);
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp", scope="tasks:read tasks:write"`,
    );
  });

  it('challenges an invalid token as invalid_token', async () => {
    const request = bearer('not-a-real-token-at-all');

    expect(await authenticator.authenticate(request)).toBeNull();
    const challenge = authenticator.challenge(request);
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('refuses a cookie-signed change from another site with 403', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    const request = new Request(`${ORIGIN}/api/tasks`, {
      method: 'POST',
      headers: {
        cookie: `__Secure-ntasks.session_token=${browser.cookie('__Secure-ntasks.session_token')}`,
        origin: 'https://elsewhere.example.com',
      },
    });

    expect(await authenticator.authenticate(request)).toBeNull();
    const challenge = authenticator.challenge(request);
    expect(challenge.status).toBe(403);
    expect(await challenge.json()).toEqual({ error: 'cross_site_request' });
  });

  it('answers 503 while sign-in is off', async () => {
    const off = signInAuthenticator({ DB: env.DB });
    const request = bearer('not-a-real-token-at-all');

    expect(await off.authenticate(request)).toBeNull();
    expect(off.challenge(request).status).toBe(503);
  });
});
