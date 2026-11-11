// Connected apps through the Worker, as a host's page uses one: an owner
// registers it, a person signs in to it in their browser, and the page calls
// the API with the token, from its own origin.
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { verifyRequest } from '../../src/access/verify.ts';
import type { TaskStore } from '../../src/store/index.ts';
import { store, TEST_WORKSPACE } from '../store.ts';
import {
  addMember,
  appTokenRequest,
  authorizeApp,
  Browser,
  call,
  choiceOf,
  connectApp,
  createProject,
  EVERY_APP_SCOPE as EVERY_SCOPE,
  locationOf,
  McpClient,
  MCP_RESOURCE,
  meWithToken,
  ORIGIN,
  OWNER_GITHUB_ID,
  REDIRECT_URI,
  userIdOf,
} from './client.ts';
import { standInForGitHub } from './github.ts';

standInForGitHub();

const OTHER_WORKSPACE = Object.freeze({ id: '0b5d2c41-8e7f-4a96-b3c2-5d1e9f7a6c84', name: 'Other workspace' });

/** A registered app: its client id and the origin its page runs at, a new one for each test. */
interface App {
  readonly clientId: string;
  readonly origin: string;
  readonly redirect: string;
}

interface ListedApp {
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly connectedAt: string | null;
}

/** An origin no other test's app runs at. */
function newOrigin(): string {
  return `https://tower-${crypto.randomUUID().slice(0, 8)}.example.com`;
}

/** Registers an app in the test workspace, or the one `workspaceId` names, as the owner signed in to `owner`. */
async function registerApp(owner: Browser, workspaceId = TEST_WORKSPACE.id): Promise<App> {
  const origin = newOrigin();
  const redirect = `${origin}/tasks/signed-in`;
  const response = await owner.fetch('/api/access/apps', {
    method: 'POST',
    json: { name: 'Example Tower', redirectUris: [redirect] },
    headers: { 'x-ntasks-workspace': workspaceId },
  });
  expect(response.status).toBe(201);
  const { app } = await response.json<{ app: ListedApp }>();
  return { clientId: app.clientId, origin, redirect };
}

/** The workspace's apps, as the person signed in to `browser` sees them. */
async function appsSeenBy(browser: Browser, workspaceId = TEST_WORKSPACE.id): Promise<ListedApp[]> {
  const response = await browser.fetch('/api/access/apps', { headers: { 'x-ntasks-workspace': workspaceId } });
  expect(response.status).toBe(200);
  return (await response.json<{ apps: ListedApp[] }>()).apps;
}

/** Calls the API from the app's page with its bearer token. */
function fromApp(
  app: App,
  token: string,
  path: string,
  init: { method?: string; json?: unknown; workspace?: string } = {},
) {
  const headers = new Headers({ authorization: `Bearer ${token}`, origin: app.origin });
  if (init.workspace) headers.set('x-ntasks-workspace', init.workspace);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  return call(path, {
    method: init.method ?? (init.json === undefined ? 'GET' : 'POST'),
    headers,
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
  });
}

/** A decision with two options in a new project of the test workspace, waiting on a person. */
async function decision(title = 'Pick a launch day'): Promise<{ projectId: string; taskId: string }> {
  const projectId = await createProject('Decided');
  const taskId = await runInDurableObject(store(), async (instance: TaskStore) => {
    const { task } = await instance.tasks.createTask(
      projectId,
      {
        title,
        type: 'decision',
        labels: ['human'],
        choices: {
          question: 'Which day?',
          options: [
            { key: 'a', label: 'Monday', recommended: true },
            { key: 'b', label: 'Friday' },
          ],
        },
      },
      { name: 'agent:planner' },
    );
    return task.id;
  });
  return { projectId, taskId };
}

/** Reads a task as the person signed in to `browser`. */
async function taskRead(browser: Browser, { projectId, taskId }: { projectId: string; taskId: string }) {
  const response = await browser.fetch(`/api/tasks/${taskId}?project=${projectId}`, {
    headers: { 'x-ntasks-workspace': TEST_WORKSPACE.id },
  });
  expect(response.status).toBe(200);
  return response.json<{ task: Record<string, unknown> }>();
}

describe('registering a connected app', () => {
  it('lets an owner register one that every member of the workspace sees, and refuses a member', async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const app = await registerApp(owner);
    const member = new Browser({ joinTestWorkspace: false });
    // A member's invitation is how they join; the test writes the membership.
    expect((await member.signInWithGitHub(1002)).pathname).toBe('/');
    await addMember(TEST_WORKSPACE, (await userIdOf(1002))!, 'member');

    expect((await appsSeenBy(member)).find((listed) => listed.clientId === app.clientId)).toEqual({
      clientId: app.clientId,
      name: 'Example Tower',
      redirectUris: [app.redirect],
      createdAt: expect.any(String) as unknown,
      connectedAt: null,
    });
    const refused = await member.fetch('/api/access/apps', {
      method: 'POST',
      json: { name: 'Another app', redirectUris: [app.redirect] },
      headers: { 'x-ntasks-workspace': TEST_WORKSPACE.id },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'owner_only' });
  });

  it.each([
    ['http on a public host', 'http://tower.example.com/tasks'],
    ['http on a public IPv4 address beside the private ranges', 'http://172.32.0.1/tasks'],
    ['http on an IPv6 link-local address', 'http://[fe80::1]/tasks'],
    ['Ntasks’s own return page', `${ORIGIN}/api/access/return?to=http%3A%2F%2Ftower.local%2Ftasks`],
    ['https on this machine', 'https://localhost/tasks'],
    ['an address with a fragment', 'https://tower.example.com/tasks#signed-in'],
    ['an address with no path', 'https://tower.example.com'],
  ])('refuses a redirect address that is %s', async (_, address) => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const response = await owner.fetch('/api/access/apps', {
      method: 'POST',
      json: { name: 'Example Tower', redirectUris: [address] },
      headers: { 'x-ntasks-workspace': TEST_WORKSPACE.id },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  });
});

/** A service credential of the test workspace, made by its owner signed in to `owner`. */
async function serviceOf(owner: Browser): Promise<{ id: string; token: string }> {
  const projectId = await createProject('Served');
  const made = await owner.fetch('/api/access/services', {
    method: 'POST',
    json: { name: `Example host ${crypto.randomUUID().slice(0, 8)}`, grants: [{ projectId, access: 'write' }] },
    headers: { 'x-ntasks-workspace': TEST_WORKSPACE.id },
  });
  expect(made.status).toBe(201);
  return (await made.json<{ service: { id: string; token: string } }>()).service;
}

/** Registers a client with RFC 7591 metadata, sending the service credential as the initial access token. */
function registerAsService(token: string, metadata: Record<string, unknown>): Promise<Response> {
  return call('/api/auth/oauth2/register', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(metadata),
  });
}

describe('a service registering its own connected app', () => {
  it('registers an app of its workspace once, which a person then allows and decides through', async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const service = await serviceOf(owner);
    const origin = newOrigin();
    const redirect = `${origin}/tasks/signed-in`;

    const first = await registerAsService(service.token, { client_name: 'NoticeOS Tower', redirect_uris: [redirect] });
    expect(first.status).toBe(201);
    const registered = await first.json<{ client_id: string; scope: string; token_endpoint_auth_method: string }>();
    expect(registered).toMatchObject({ token_endpoint_auth_method: 'none' });
    expect(registered.scope.split(' ').sort()).toEqual(EVERY_SCOPE.split(' ').sort());
    const again = await registerAsService(service.token, { client_name: 'NoticeOS Tower', redirect_uris: [redirect] });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ client_id: registered.client_id, redirect_uris: [redirect] });
    expect((await appsSeenBy(owner)).filter((listed) => listed.redirectUris.includes(redirect))).toEqual([
      expect.objectContaining({ clientId: registered.client_id, name: 'NoticeOS Tower', connectedAt: null }),
    ]);

    const app = { clientId: registered.client_id, origin, redirect };
    const tokens = await connectApp(owner, app);
    const asked = await decision('Picked through a service-registered app');
    const chose = await fromApp(app, tokens.access_token, `/api/tasks/${asked.taskId}/choose`, {
      json: { projectId: asked.projectId, option: 'a' },
    });
    expect(chose.status).toBe(200);
    const { task } = await taskRead(owner, asked);
    expect(task).toMatchObject({ choice: { option: 'a', app: registered.client_id } });
    expect((task.choice as { by: string }).by).not.toMatch(/^service:/u);
  });

  it('stores only the scopes a registration asked for, so its app cannot later ask to decide', async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const service = await serviceOf(owner);
    const redirect = `${newOrigin()}/tasks/signed-in`;
    const reader = await registerAsService(service.token, {
      client_name: 'Reading Tower',
      redirect_uris: [redirect],
      scope: 'tasks:read offline_access',
    });
    expect(reader.status).toBe(201);
    const registered = await reader.json<{ client_id: string; scope: string }>();
    expect(registered.scope.split(' ').sort()).toEqual(['offline_access', 'tasks:read']);
    const { landing } = await authorizeApp(
      owner,
      { clientId: registered.client_id, redirect },
      'tasks:read tasks:decide',
    );
    expect(`${landing.origin}${landing.pathname}`).toBe(redirect);
    expect(landing.searchParams.get('error')).toBe('invalid_scope');
  });

  it.each([
    [
      'a redirect address an app may not use',
      { redirect_uris: ['http://tower.example.com/tasks'] },
      'invalid_redirect_uri',
    ],
    ['a client secret', { token_endpoint_auth_method: 'client_secret_basic' }, 'invalid_client_metadata'],
    ['a scope a connected app never holds', { scope: 'tasks:read tasks:backup' }, 'invalid_client_metadata'],
  ])('refuses %s', async (_, change, error) => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const service = await serviceOf(owner);
    const refused = await registerAsService(service.token, {
      client_name: 'NoticeOS Tower',
      redirect_uris: [`${newOrigin()}/tasks/signed-in`],
      ...change,
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error, error_description: expect.any(String) as unknown });
  });

  it('refuses a revoked credential and registers nothing', async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const service = await serviceOf(owner);
    const revoked = await owner.fetch(`/api/access/services/${service.id}/revoke`, {
      method: 'POST',
      json: {},
      headers: { 'x-ntasks-workspace': TEST_WORKSPACE.id },
    });
    expect(revoked.status).toBe(200);
    const redirect = `${newOrigin()}/tasks/signed-in`;
    const refused = await registerAsService(service.token, {
      client_name: 'NoticeOS Tower',
      redirect_uris: [redirect],
    });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: 'invalid_token' });
    expect((await appsSeenBy(owner)).filter((listed) => listed.redirectUris.includes(redirect))).toEqual([]);
  });
});

describe('a person signed in through a connected app', () => {
  it('is that person, in the app’s workspace, holding only the scopes they allowed', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    const app = await registerApp(browser);
    const { projectId } = await decision();

    const reader = await connectApp(browser, app, 'tasks:read');
    expect(await (await meWithToken(reader.access_token)).json()).toMatchObject({
      kind: 'person',
      deploymentAdmin: false,
      projects: 'all',
      app: { clientId: app.clientId, name: 'Example Tower', workspaceId: TEST_WORKSPACE.id, scopes: ['tasks:read'] },
    });
    expect((await fromApp(app, reader.access_token, `/api/tasks?project=${projectId}`)).status).toBe(200);
    const write = await fromApp(app, reader.access_token, '/api/tasks', {
      json: { projectId, title: 'Filed by the app' },
    });
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ error: 'insufficient_scope' });

    const writer = await connectApp(browser, app, EVERY_SCOPE);
    expect(await (await meWithToken(writer.access_token)).json()).toMatchObject({
      app: { scopes: ['tasks:read', 'tasks:write', 'tasks:decide'] },
    });
    const filed = await fromApp(app, writer.access_token, '/api/tasks', {
      json: { projectId, title: 'Filed by the app' },
    });
    expect(filed.status).toBe(200);
  });

  it('records a pick under the person’s name, as their session does, with the app’s client id beside it', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    const app = await registerApp(browser);
    const tokens = await connectApp(browser, app);
    const inBrowser = await decision('Picked in the web app');
    const inApp = await decision('Picked through the app');

    const direct = await browser.fetch(`/api/tasks/${inBrowser.taskId}/choose`, {
      method: 'POST',
      json: { projectId: inBrowser.projectId, option: 'b' },
      headers: { 'x-ntasks-workspace': TEST_WORKSPACE.id },
    });
    expect(direct.status).toBe(200);
    const through = await fromApp(app, tokens.access_token, `/api/tasks/${inApp.taskId}/choose`, {
      json: { projectId: inApp.projectId, option: 'b' },
    });
    expect(through.status).toBe(200);

    const personal = (await taskRead(browser, inBrowser)).task;
    const viaApp = (await taskRead(browser, inApp)).task;
    const person = (personal.choice as { by: string }).by;
    expect(viaApp).toMatchObject({
      status: 'closed',
      closedBy: person,
      choice: { option: 'b', by: person, app: app.clientId },
      answer: { recordedBy: person, relayed: false, app: app.clientId },
    });
    expect(personal).toMatchObject({ closedBy: person, answer: { recordedBy: person, relayed: false, app: null } });
    expect(personal.choice).not.toHaveProperty('app');

    const history = await fromApp(
      app,
      tokens.access_token,
      `/api/tasks/${inApp.taskId}/history?project=${inApp.projectId}`,
    );
    const { changes } = await history.json<{ changes: { actor: string; fields: Record<string, unknown> }[] }>();
    expect(changes[0]).toMatchObject({
      actor: person,
      fields: { choice: { new: { by: person, app: app.clientId } } },
    });
  });

  it('never manages access or creates a workspace, whatever the person may do in their own browser', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    const app = await registerApp(browser);
    const { access_token: token } = await connectApp(browser, app);

    for (const path of ['/api/access/agents', '/api/access/services', '/api/access/members', '/api/access/apps']) {
      const response = await fromApp(app, token, path, { workspace: TEST_WORKSPACE.id });
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toMatchObject({ error: 'owner_only' });
    }
    const created = await fromApp(app, token, '/api/workspaces', { json: { name: 'Made by the app' } });
    expect(created.status).toBe(403);
    const renamed = await fromApp(app, token, '/api/workspaces', {
      method: 'PATCH',
      json: { workspaceId: TEST_WORKSPACE.id, name: 'Renamed by the app' },
    });
    expect(renamed.status).toBe(403);
  });

  it('reaches only the workspace the app belongs to', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    await addMember(OTHER_WORKSPACE, (await userIdOf(OWNER_GITHUB_ID))!, 'owner');
    const app = await registerApp(browser, OTHER_WORKSPACE.id);
    const { access_token: token } = await connectApp(browser, app);

    const listed = await (
      await fromApp(app, token, '/api/workspaces')
    ).json<{
      workspaces: { workspaceId: string }[];
    }>();
    expect(listed.workspaces.map((workspace) => workspace.workspaceId)).toEqual([OTHER_WORKSPACE.id]);
    const elsewhere = await fromApp(app, token, '/api/tasks/projects', { workspace: TEST_WORKSPACE.id });
    expect(elsewhere.status).toBe(404);
    const own = await fromApp(app, token, '/api/tasks/projects', { workspace: OTHER_WORKSPACE.id });
    expect(own.status).toBe(200);
  });

  it('cannot be allowed by a person who is not a member of its workspace', async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const app = await registerApp(owner);
    const outsider = new Browser({ joinTestWorkspace: false });
    await outsider.signInWithGitHub(1003);

    const { landing } = await authorizeApp(outsider, app, EVERY_SCOPE);
    expect(landing.pathname).toBe('/agent-access');
    const page = await (await outsider.fetch(landing.pathname + landing.search)).text();
    expect(page).not.toContain('value="allow"');
    const allowed = await outsider.fetch('/agent-access', {
      form: { oauth_query: landing.search.slice(1), decision: 'allow' },
    });
    expect(allowed.status).toBe(200);
    const consents = await env.DB.prepare('SELECT count(*) AS n FROM auth_oauth_consent WHERE client_id = ?')
      .bind(app.clientId)
      .first<{ n: number }>();
    expect(consents?.n).toBe(0);
  });
});

describe('ending a connected app’s access', () => {
  it('ends a removed member’s sign-in to the workspace’s apps, and keeps their apps in other workspaces', async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const here = await registerApp(owner);
    const person = new Browser({ joinTestWorkspace: false });
    await person.signInWithGitHub(1004);
    const userId = (await userIdOf(1004))!;
    await addMember(TEST_WORKSPACE, userId, 'member');
    const elsewhere = Object.freeze({ id: '6a2f8e13-4c5b-4d7a-9e06-1b3c5d7f9a28', name: 'Elsewhere' });
    await addMember(elsewhere, userId, 'owner');
    const there = await registerApp(person, elsewhere.id);
    const before = await connectApp(person, here);
    const tokenHere = before.access_token;
    const tokenThere = (await connectApp(person, there)).access_token;

    const removed = await owner.fetch(`/api/access/members/${userId}/remove`, {
      method: 'POST',
      headers: { 'x-ntasks-workspace': TEST_WORKSPACE.id },
    });
    expect(removed.status).toBe(200);

    expect((await meWithToken(tokenHere)).status).toBe(401);
    expect((await meWithToken(tokenThere)).status).toBe(200);
    // Invited again, the person allows this workspace's app again before it
    // acts as them, and the tokens from before stay refused.
    await addMember(TEST_WORKSPACE, userId, 'member');
    expect((await meWithToken(tokenHere)).status).toBe(401);
    const again = await connectApp(person, here, 'tasks:read');
    expect((await meWithToken(again.access_token)).status).toBe(200);
    expect((await meWithToken(tokenHere)).status).toBe(401);
    const refresh = await appTokenRequest(here, {
      grant_type: 'refresh_token',
      refresh_token: before.refresh_token ?? '',
      resource: MCP_RESOURCE,
    });
    expect(refresh.status).toBe(400);
  });

  it('refuses the token and its refresh once the person revokes their sign-in, and the app shows signed out', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    const app = await registerApp(browser);
    const tokens = await connectApp(browser, app);
    const before = (await appsSeenBy(browser)).find((listed) => listed.clientId === app.clientId);
    expect(before?.connectedAt).toEqual(expect.any(String));

    const revoked = await browser.fetch(`/api/access/apps/${app.clientId}/revoke`, {
      method: 'POST',
      headers: { 'x-ntasks-workspace': TEST_WORKSPACE.id },
    });
    expect(revoked.status).toBe(200);

    expect((await meWithToken(tokens.access_token)).status).toBe(401);
    const refresh = await appTokenRequest(app, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token ?? '',
      resource: MCP_RESOURCE,
    });
    expect(refresh.status).toBe(400);
    const after = (await appsSeenBy(browser)).find((listed) => listed.clientId === app.clientId);
    expect(after?.connectedAt).toBeNull();
  });

  it('is revoked from its workspace’s list of apps, not as an agent', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    const app = await registerApp(browser);
    const tokens = await connectApp(browser, app);

    const asAgent = await browser.fetch(`/api/access/agents/${app.clientId}/revoke`, { method: 'POST' });
    expect(asAgent.status).toBe(404);
    expect((await meWithToken(tokens.access_token)).status).toBe(200);
    const agents = await (await browser.fetch('/api/access/agents')).json<{ agents: { clientId: string }[] }>();
    expect(agents.agents.map((agent) => agent.clientId)).not.toContain(app.clientId);
  });

  it('ends every person’s sign-in when an owner removes the app, and stops answering its page', async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const app = await registerApp(owner);
    const tokens = await connectApp(owner, app);

    const removed = await owner.fetch(`/api/access/apps/${app.clientId}/remove`, {
      method: 'POST',
      headers: { 'x-ntasks-workspace': TEST_WORKSPACE.id },
    });
    expect(removed.status).toBe(200);

    expect((await meWithToken(tokens.access_token)).status).toBe(401);
    expect((await appsSeenBy(owner)).map((listed) => listed.clientId)).not.toContain(app.clientId);
    const preflight = await call('/api/tasks', {
      method: 'OPTIONS',
      headers: { origin: app.origin, 'access-control-request-method': 'GET' },
    });
    expect(preflight.status).toBe(403);
  });
});

describe('agents and services still never decide', () => {
  it('refuses tasks:decide to a client that registered itself, which stays an agent', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    const project = await createProject('AgentDecides');
    const registration = {
      client_name: 'Example Tower',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
    const register = (body: Record<string, unknown>) =>
      call('/api/auth/oauth2/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const asking = await register({ ...registration, scope: 'tasks:read tasks:decide' });
    expect(asking.status).toBe(400);
    expect(await asking.json()).toMatchObject({ error: 'invalid_scope' });
    // A registration that claims to be a connected app: the library keeps neither claim.
    const claiming = await register({
      ...registration,
      reference_id: `ntasks-app:${TEST_WORKSPACE.id}`,
      metadata: { workspace: TEST_WORKSPACE.id },
    });
    expect(claiming.status).toBe(201);
    const self = new McpClient();
    self.clientId = (await claiming.json<{ client_id: string }>()).client_id;

    const refused = (await self.authorize(browser, 'tasks:read tasks:decide')).landing;
    expect(`${refused.origin}${refused.pathname}`).toBe(REDIRECT_URI);
    expect(refused.searchParams.get('error')).toBe('invalid_scope');
    const { landing, verifier } = await self.authorize(browser, 'tasks:read tasks:write');
    expect(landing.pathname).toBe('/agent-access');
    const approved = await browser.fetch('/agent-access', {
      form: { oauth_query: landing.search.slice(1), decision: 'allow', project: choiceOf(project) },
    });
    const tokens = await self.exchange(locationOf(approved).searchParams.get('code') ?? '', verifier);
    const verified = await verifyRequest(
      new Request(`${ORIGIN}/api/mcp`, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
      env,
    );
    expect(verified).toMatchObject({
      ok: true,
      principal: { kind: 'agent', id: `agent:${self.clientId}:${(await userIdOf(OWNER_GITHUB_ID))!}` },
    });
    const { projectId, taskId } = await decision();
    const chose = await call(`/api/tasks/${taskId}/choose`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, option: 'a' }),
    });
    expect(chose.status).toBe(403);
    expect(await chose.json()).toMatchObject({ error: 'insufficient_scope' });
  });

  it('refuses a decision sent with a service credential', async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const { projectId, taskId } = await decision();
    const made = await owner.fetch('/api/access/services', {
      method: 'POST',
      json: { name: `Example host ${crypto.randomUUID().slice(0, 8)}`, grants: [{ projectId, access: 'write' }] },
      headers: { 'x-ntasks-workspace': TEST_WORKSPACE.id },
    });
    expect(made.status).toBe(201);
    const { service } = await made.json<{ service: { token: string } }>();

    const chose = await call(`/api/tasks/${taskId}/choose`, {
      method: 'POST',
      headers: { authorization: `Bearer ${service.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, option: 'a' }),
    });
    expect(chose.status).toBe(403);
    expect(await chose.json()).toMatchObject({ error: 'insufficient_scope' });
  });
});

describe('calls from a page at another origin', () => {
  it('answers a preflight from a connected app’s origin, without credentials', async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const app = await registerApp(owner);
    const tokens = await connectApp(owner, app);

    const preflight = await call('/api/tasks/projects', {
      method: 'OPTIONS',
      headers: {
        origin: app.origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization, x-ntasks-workspace',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(app.origin);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();

    const read = await fromApp(app, tokens.access_token, '/api/tasks/projects');
    expect(read.status).toBe(200);
    expect(read.headers.get('access-control-allow-origin')).toBe(app.origin);
    expect(read.headers.get('access-control-allow-credentials')).toBeNull();
    // The page reads the API's version, as a client checks it.
    expect(read.headers.get('access-control-expose-headers')).toContain('x-ntasks-api-version');
  });

  it('refuses a write with an app’s token from an origin no app registered, and writes nothing', async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const app = await registerApp(owner);
    const tokens = await connectApp(owner, app);
    const asked = await decision('Picked from a stray page');

    const stray = { ...app, origin: newOrigin() };
    const chose = await fromApp(stray, tokens.access_token, `/api/tasks/${asked.taskId}/choose`, {
      json: { projectId: asked.projectId, option: 'a' },
    });
    expect(chose.status).toBe(403);
    expect(await chose.json()).toMatchObject({ error: 'origin_not_allowed' });
    expect((await taskRead(owner, asked)).task).toMatchObject({ status: 'open', choice: null });
  });

  it('refuses a preflight from an origin no app registered', async () => {
    const preflight = await call('/api/tasks/projects', {
      method: 'OPTIONS',
      headers: { origin: newOrigin(), 'access-control-request-method': 'GET' },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });
});

/** An http address on a home network that no other test's app uses. */
function homeAddress(): { readonly origin: string; readonly redirect: string } {
  const origin = `http://tower-${crypto.randomUUID().slice(0, 8)}.local:5173`;
  return { origin, redirect: `${origin}/tasks/signed-in` };
}

/** A browser's preflight from a page at `origin` before it calls the API with a bearer token. */
function preflightFrom(origin: string): Promise<Response> {
  return call('/api/tasks/projects', {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
  });
}

/** The addresses Ntasks holds for a service's app: it registers the app again, which answers the same one. */
async function heldFor(token: string, redirect: string): Promise<readonly string[]> {
  const again = await registerAsService(token, { client_name: 'NoticeOS Tower', redirect_uris: [redirect] });
  expect(again.status).toBe(200);
  return (await again.json<{ held_redirect_uris: string[] }>()).held_redirect_uris;
}

/** Follows the approval page's answer through Ntasks's return page to where it sends the browser. */
async function passedOn(browser: Browser, answered: Response): Promise<URL> {
  const relay = locationOf(answered);
  expect(`${relay.origin}${relay.pathname}`).toBe(`${ORIGIN}/api/access/return`);
  return locationOf(await browser.fetch(`${relay.pathname}${relay.search}`));
}

/** Signs the person in to an app at a home-network address: authorize, Allow, and exchange the code from that address. */
async function connectAtHome(browser: Browser, app: App): Promise<Response> {
  const { landing, verifier } = await authorizeApp(browser, app, EVERY_SCOPE);
  expect(landing.pathname).toBe('/agent-access');
  const allowed = await browser.fetch('/agent-access', {
    form: { oauth_query: landing.search.slice(1), decision: 'allow' },
  });
  const back = await passedOn(browser, allowed);
  expect(`${back.origin}${back.pathname}`).toBe(app.redirect);
  expect(back.searchParams.get('state')).toBe('app-state');
  return appTokenRequest(app, {
    grant_type: 'authorization_code',
    code: back.searchParams.get('code') ?? '',
    redirect_uri: app.redirect,
    code_verifier: verifier,
    resource: MCP_RESOURCE,
  });
}

describe('an app at an http address on a home network', () => {
  it.each([
    ['a .local name', () => homeAddress().redirect],
    ['a private IPv4 address', () => `http://10.${crypto.getRandomValues(new Uint8Array(1))[0]}.0.20:5173/signed-in`],
    ['an IPv6 unique-local address', () => `http://[fd12:${crypto.randomUUID().slice(0, 4)}::20]:5173/signed-in`],
  ])('registers on %s, held until an owner allows it', async (_, address) => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const service = await serviceOf(owner);
    const redirect = address();
    const first = await registerAsService(service.token, { client_name: 'NoticeOS Tower', redirect_uris: [redirect] });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ redirect_uris: [redirect], held_redirect_uris: [redirect] });
  });

  it('completes no sign-in and answers no call from the address until an owner allows it, then signs anyone in', async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const service = await serviceOf(owner);
    const { origin, redirect } = homeAddress();
    const registered = await registerAsService(service.token, {
      client_name: 'NoticeOS Tower',
      redirect_uris: [redirect],
    });
    const app = { clientId: (await registered.json<{ client_id: string }>()).client_id, origin, redirect };
    expect((await preflightFrom(origin)).status).toBe(403);

    // A member who is not an owner reaches the approval page but cannot allow
    // the address, and Deny returns them to the app.
    const member = new Browser({ joinTestWorkspace: false });
    await member.signInWithGitHub(1002);
    await addMember(TEST_WORKSPACE, (await userIdOf(1002))!, 'member');
    const asked = await authorizeApp(member, app, EVERY_SCOPE);
    expect(asked.landing.pathname).toBe('/agent-access');
    expect(await (await member.fetch(`/agent-access${asked.landing.search}`)).text()).not.toContain('value="allow"');
    const tried = await member.fetch('/agent-access', {
      form: { oauth_query: asked.landing.search.slice(1), decision: 'allow' },
    });
    expect(tried.status).toBe(200);
    expect(await heldFor(service.token, redirect)).toEqual([redirect]);
    const denied = await passedOn(
      member,
      await member.fetch('/agent-access', { form: { oauth_query: asked.landing.search.slice(1), decision: 'deny' } }),
    );
    expect(`${denied.origin}${denied.pathname}`).toBe(redirect);
    expect(denied.searchParams.get('error')).toBe('access_denied');
    expect(denied.searchParams.has('code')).toBe(false);

    // An owner's one Allow allows the address and signs them in from it.
    const ownerTokens = await connectAtHome(owner, app);
    expect(ownerTokens.status).toBe(200);
    expect(ownerTokens.headers.get('access-control-allow-origin')).toBe(origin);
    expect(await heldFor(service.token, redirect)).toEqual([]);
    const allowedPreflight = await preflightFrom(origin);
    expect(allowedPreflight.status).toBe(204);
    expect(allowedPreflight.headers.get('access-control-allow-origin')).toBe(origin);

    const memberTokens = await connectAtHome(member, app);
    expect(memberTokens.status).toBe(200);
    const { access_token } = await memberTokens.json<{ access_token: string }>();
    expect(await (await meWithToken(access_token)).json()).toMatchObject({ app: { clientId: app.clientId } });
    expect((await appsSeenBy(owner)).find((listed) => listed.clientId === app.clientId)).toMatchObject({
      redirectUris: [redirect],
    });
  });

  it('asks for the approval page while held, even from an owner who allowed the app before, and passes no code on', async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const https = `${newOrigin()}/tasks/signed-in`;
    const home = homeAddress();
    const registered = await owner.fetch('/api/access/apps', {
      method: 'POST',
      json: { name: 'Example Tower', redirectUris: [https, home.redirect] },
      headers: { 'x-ntasks-workspace': TEST_WORKSPACE.id },
    });
    expect(registered.status).toBe(201);
    const { app } = await registered.json<{ app: ListedApp }>();
    expect(app.redirectUris).toEqual([https, home.redirect]);
    await connectApp(owner, { clientId: app.clientId, redirect: https });

    const { landing } = await authorizeApp(owner, { clientId: app.clientId, redirect: home.redirect }, EVERY_SCOPE);
    expect(landing.pathname).toBe('/agent-access');
    const relayed = new URL(`${ORIGIN}/api/access/return`);
    relayed.searchParams.set('to', home.redirect);
    relayed.searchParams.set('code', 'a-code-for-the-held-address');
    const stopped = await owner.fetch(`${relayed.pathname}${relayed.search}`);
    expect(stopped.status).toBe(403);
    expect(stopped.headers.get('location')).toBeNull();
    expect((await preflightFrom(home.origin)).status).toBe(403);
  });

  it('refuses an agent that names Ntasks’s own return page as its redirect address', async () => {
    const relay = new URL(`${ORIGIN}/api/access/return`);
    relay.searchParams.set('to', homeAddress().redirect);
    const refused = await call('/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Relaying agent',
        redirect_uris: [relay.toString()],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'invalid_redirect_uri' });
  });
});
