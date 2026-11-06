import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { signInAuthenticator } from '../../src/access/authenticator.ts';
import { may } from '../../src/access/principal.ts';
import { Browser, connectAgent, createProject, ORIGIN } from './client.ts';
import { standInForGitHub } from './github.ts';

standInForGitHub();

const authenticator = signInAuthenticator(env);

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
    expect(signedIn).toMatchObject({ name: 'Person 1001', scopes: ['tasks:read', 'tasks:write'] });
    expect(signedIn?.id).toMatch(/^person:/u);
  });

  it('gives a read-only agent the read scope, its prefixed actor name and its projects', async () => {
    const granted = await createProject('Granted');
    const other = await createProject('Other');
    const browser = new Browser();
    await browser.signInAsOwner();
    const { tokens } = await connectAgent(browser, [granted], 'tasks:read offline_access');

    const request = bearer(tokens.access_token);
    const signedIn = await authenticator.authenticate(request);
    expect(signedIn).toMatchObject({ name: 'agent:Example Agent', scopes: ['tasks:read'] });
    expect(signedIn && may(signedIn.principal, granted, 'read')).toBe(true);
    expect(signedIn && may(signedIn.principal, other, 'read')).toBe(false);
    // The body is still there for the MCP endpoint to read.
    expect(await request.text()).toBe('{}');
  });

  it('signs nobody in without a valid credential, and challenges with the resource metadata', async () => {
    const request = bearer('not-a-real-token-at-all');

    expect(await authenticator.authenticate(request)).toBeNull();
    const challenge = authenticator.challenge(request);
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`,
    );
  });

  it('answers 503 while sign-in is off', async () => {
    const off = signInAuthenticator({ DB: env.DB });
    const request = bearer('not-a-real-token-at-all');

    expect(await off.authenticate(request)).toBeNull();
    expect(off.challenge(request).status).toBe(503);
  });
});
