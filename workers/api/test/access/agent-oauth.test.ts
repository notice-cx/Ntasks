import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { verifyRequest } from '../../src/access/verify.ts';
import {
  Browser,
  call,
  connectAgent,
  createProject,
  locationOf,
  McpClient,
  MCP_RESOURCE,
  meWithToken,
  ORIGIN,
  OWNER_GITHUB_ID,
  REDIRECT_URI,
} from './client.ts';
import { standInForGitHub } from './github.ts';

standInForGitHub();

describe('OAuth discovery for MCP clients', () => {
  it('describes the MCP endpoint as a protected resource', async () => {
    const response = await call('/.well-known/oauth-protected-resource/api/mcp');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: MCP_RESOURCE,
      authorization_servers: [`${ORIGIN}/api/auth`],
      scopes_supported: ['tasks:read', 'tasks:write'],
      bearer_methods_supported: ['header'],
      resource_name: 'Ntasks',
    });
  });

  it.each(['/.well-known/oauth-authorization-server/api/auth', '/.well-known/oauth-authorization-server'])(
    'describes the authorization server at %s',
    async (path) => {
      const response = await call(path);

      expect(response.status).toBe(200);
      const metadata = await response.json<Record<string, unknown>>();
      expect(metadata).toMatchObject({
        issuer: `${ORIGIN}/api/auth`,
        authorization_endpoint: `${ORIGIN}/api/auth/oauth2/authorize`,
        token_endpoint: `${ORIGIN}/api/auth/oauth2/token`,
        registration_endpoint: `${ORIGIN}/api/auth/oauth2/register`,
        revocation_endpoint: `${ORIGIN}/api/auth/oauth2/revoke`,
        code_challenge_methods_supported: ['S256'],
      });
      expect(metadata.scopes_supported).toEqual(
        expect.arrayContaining(['tasks:read', 'tasks:write', 'offline_access']),
      );
    },
  );

  it.each(['/api/auth/get-session', '/api/auth/oauth2/get-clients', '/api/auth/list-sessions'])(
    'keeps the library route %s private',
    async (path) => {
      expect((await call(path)).status).toBe(404);
    },
  );
});

describe('an agent connecting over OAuth', () => {
  it('signs the owner in, asks which projects, and gets a token that reaches only those', async () => {
    const chosen = await createProject('Chosen');
    const other = await createProject('Other');
    const browser = new Browser();
    const client = new McpClient();
    await client.register('Example Agent');

    const { landing, verifier } = await client.authorize(browser, 'tasks:read tasks:write offline_access');
    expect(landing.pathname).toBe('/sign-in');
    const signInPage = await (await browser.fetch(landing.pathname + landing.search)).text();
    expect(signInPage).toContain('An agent asks to connect');

    const afterSignIn = await browser.signInWithGitHub(OWNER_GITHUB_ID, landing.search.slice(1));
    expect(afterSignIn.pathname).toBe('/agent-access');
    const approval = await browser.fetch(afterSignIn.pathname + afterSignIn.search);
    expect(approval.status).toBe(200);
    const page = await approval.text();
    expect(page).toContain('Allow Example Agent to use Ntasks?');
    expect(page).toContain('<dt>Access</dt><dd>Read and change tasks</dd>');
    expect(page).toContain(`<dt>Returns to</dt><dd>${new URL(REDIRECT_URI).origin}</dd>`);
    expect(page).toContain('Chosen');
    expect(page).toContain('Other');

    const approved = await browser.fetch('/agent-access', {
      form: { oauth_query: afterSignIn.search.slice(1), decision: 'allow', project: chosen },
    });
    const back = locationOf(approved);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
    const tokens = await client.exchange(back.searchParams.get('code') ?? '', verifier);
    expect(tokens.refresh_token).toBeTruthy();

    const me = await meWithToken(tokens.access_token);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      kind: 'agent',
      name: 'Example Agent',
      projects: [{ projectId: chosen, access: 'write' }],
    });

    const verified = await verifyRequest(
      new Request(`${ORIGIN}/api/mcp`, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
      env,
    );
    expect(verified.ok && verified.principal.kind === 'agent' && verified.principal.projects.has(other)).toBe(false);

    // Through the Worker, the API lists only the chosen project and answers the other as missing.
    const bearer = { headers: { authorization: `Bearer ${tokens.access_token}` } };
    const listed = await (await call('/api/tasks/projects', bearer)).json<{ projects: { projectId: string }[] }>();
    expect(listed.projects.map((project) => project.projectId)).toEqual([chosen]);
    expect((await call(`/api/tasks?project=${other}`, bearer)).status).toBe(404);
  });

  it('gives a read-only agent read access to the projects it was granted', async () => {
    const project = await createProject('Readable');
    const browser = new Browser();
    await browser.signInAsOwner();

    const { tokens } = await connectAgent(browser, [project], 'tasks:read offline_access');
    expect(await (await meWithToken(tokens.access_token)).json()).toMatchObject({
      projects: [{ projectId: project, access: 'read' }],
    });
  });

  it('refreshes its token, and the new token works', async () => {
    const project = await createProject('Refreshed');
    const browser = new Browser();
    await browser.signInAsOwner();
    const { client, tokens } = await connectAgent(browser, [project]);

    const refreshed = await client.refresh(tokens.refresh_token ?? '');
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json<{ access_token: string }>();
    expect(next.access_token).not.toBe(tokens.access_token);
    expect((await meWithToken(next.access_token)).status).toBe(200);
  });

  it('gets access_denied when the owner denies it, and no grant is recorded', async () => {
    await createProject('Denied');
    const browser = new Browser();
    await browser.signInAsOwner();
    const client = new McpClient();
    await client.register();
    const { landing } = await client.authorize(browser, 'tasks:write');

    const denied = await browser.fetch('/agent-access', {
      form: { oauth_query: landing.search.slice(1), decision: 'deny' },
    });
    const back = locationOf(denied);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
    expect(back.searchParams.get('error')).toBe('access_denied');
    const grants = await env.DB.prepare('SELECT count(*) AS n FROM access_agent_grants WHERE client_id = ?')
      .bind(client.clientId)
      .first<{ n: number }>();
    expect(grants?.n).toBe(0);
  });

  it('asks again when the owner allows it without choosing a project', async () => {
    await createProject('Unchosen');
    const browser = new Browser();
    await browser.signInAsOwner();
    const client = new McpClient();
    await client.register();
    const { landing } = await client.authorize(browser, 'tasks:write');

    const response = await browser.fetch('/agent-access', {
      form: { oauth_query: landing.search.slice(1), decision: 'allow' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Choose at least one project.');
  });

  it('refuses an approval link whose signed query was changed', async () => {
    await createProject('Tampered');
    const browser = new Browser();
    await browser.signInAsOwner();
    const client = new McpClient();
    await client.register();
    const { landing } = await client.authorize(browser, 'tasks:read');
    const changed = landing.search
      .slice(1)
      .replace('tasks%3Aread', 'tasks%3Awrite')
      .replace('tasks:read', 'tasks:write');

    const response = await browser.fetch(`/agent-access?${changed}`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('This link has expired');
  });

  it('may not manage access: that is the owner’s own act', async () => {
    const project = await createProject('Managed');
    const browser = new Browser();
    await browser.signInAsOwner();
    const { tokens } = await connectAgent(browser, [project]);

    const response = await call('/api/access/services', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'owner_only' });
  });
});

describe('revoking an agent', () => {
  it('lists the agent for the owner, and after revocation refuses its token and its refresh', async () => {
    const project = await createProject('Revoked');
    const browser = new Browser();
    await browser.signInAsOwner();
    const { client, tokens } = await connectAgent(browser, [project]);
    expect((await meWithToken(tokens.access_token)).status).toBe(200);

    const listed = await browser.fetch('/api/access/agents');
    const { agents } = await listed.json<{ agents: { clientId: string; name: string; grants: unknown[] }[] }>();
    expect(agents.find((agent) => agent.clientId === client.clientId)).toMatchObject({
      name: 'Example Agent',
      grants: [{ projectId: project, access: 'write' }],
    });

    const revoked = await browser.fetch(`/api/access/agents/${client.clientId}/revoke`, { method: 'POST' });
    expect(revoked.status).toBe(200);

    const refused = await meWithToken(tokens.access_token);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toContain('error="invalid_token"');
    const refresh = await client.refresh(tokens.refresh_token ?? '');
    expect(refresh.status).toBe(400);
  });

  it('refuses a token the client revoked itself (RFC 7009)', async () => {
    const project = await createProject('SelfRevoked');
    const browser = new Browser();
    await browser.signInAsOwner();
    const { client, tokens } = await connectAgent(browser, [project]);

    const response = await call('/api/auth/oauth2/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: tokens.access_token,
        token_type_hint: 'access_token',
        client_id: client.clientId,
      }).toString(),
    });
    expect(response.status).toBe(200);
    expect((await meWithToken(tokens.access_token)).status).toBe(401);
  });

  it('refuses an expired token', async () => {
    const project = await createProject('Expired');
    const browser = new Browser();
    await browser.signInAsOwner();
    const { client, tokens } = await connectAgent(browser, [project]);
    await env.DB.prepare('UPDATE auth_oauth_access_token SET expires_at = ? WHERE client_id = ?')
      .bind('2000-01-01T00:00:00.000Z', client.clientId)
      .run();

    expect((await meWithToken(tokens.access_token)).status).toBe(401);
  });

  it('refuses the agent of an owner who left the allowlist', async () => {
    const project = await createProject('Departed');
    const browser = new Browser();
    await browser.signInAsOwner();
    const { tokens } = await connectAgent(browser, [project]);
    const request = new Request(`${ORIGIN}/api/mcp`, { headers: { authorization: `Bearer ${tokens.access_token}` } });

    expect((await verifyRequest(request, env)).ok).toBe(true);
    expect(await verifyRequest(request, { ...env, OWNER_GITHUB_IDS: '3003' })).toEqual({
      ok: false,
      reason: 'invalid_token',
    });
  });
});
