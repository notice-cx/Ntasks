import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { signInAuthenticator, type SignedIn } from '../../src/access/authenticator.ts';
import { mayReach, type Principal } from '../../src/auth.ts';
import { scopedTo } from '../../src/workspaces.ts';
import { TEST_WORKSPACE } from '../store.ts';
import { Browser, call, connectAgent, createProject, meWithToken, ORIGIN } from './client.ts';
import { standInForGitHub } from './github.ts';

standInForGitHub();

interface CreatedService {
  readonly id: string;
  readonly name: string;
  readonly token: string;
  readonly grants: readonly { projectId: string; access: string }[];
}

async function createService(browser: Browser, name: string, grants: unknown): Promise<Response> {
  return browser.fetchJson('/api/access/services', { name, grants });
}

/** The sender a bearer token signs in as; fails the test when it is refused. */
async function senderFor(token: string): Promise<SignedIn> {
  const signedIn = await signInAuthenticator(env).authenticate(
    new Request(`${ORIGIN}/api/mcp`, { headers: { authorization: `Bearer ${token}` } }),
  );
  if (!signedIn) throw new Error('refused');
  return signedIn;
}

/** The sender a bearer token signs in as, as the test workspace's store sees it. A service reaches only its credential's workspace. */
async function principalFor(token: string): Promise<Principal> {
  const sender = await senderFor(token);
  expect(sender.workspaces.map((reach) => reach.workspace)).toEqual([TEST_WORKSPACE]);
  return scopedTo(sender, sender.workspaces[0]!);
}

/** GET an API path with a bearer token, through the Worker. */
async function getWith(token: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await call(path, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

describe('a service credential', () => {
  it('reaches the project it was granted and no other', async () => {
    const granted = await createProject('Granted');
    const other = await createProject('Other');
    const browser = new Browser();
    await browser.signInAsOwner();

    const response = await createService(browser, 'noticeos-laptop', [{ projectId: granted, access: 'write' }]);
    expect(response.status).toBe(201);
    const { service } = await response.json<{ service: CreatedService }>();
    expect(service.token).toMatch(/^ntasks_service\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u);

    expect(await senderFor(service.token)).toMatchObject({
      principal: { kind: 'service', name: 'noticeos-laptop', workspace: TEST_WORKSPACE },
    });
    const principal = await principalFor(service.token);
    expect(principal).toEqual({
      id: `service:${service.id}`,
      name: 'service:noticeos-laptop',
      scopes: ['tasks:read', 'tasks:write'],
      projects: new Map([[granted, 'write']]),
    });
    expect(mayReach(principal, granted, 'read')).toBe(true);
    expect(mayReach(principal, granted, 'write')).toBe(true);
    expect(mayReach(principal, other, 'read')).toBe(false);
    // A service acts for no person: it holds no decide scope and its comments are nobody's own words.
    expect(principal.person).toBeUndefined();
    expect(await (await meWithToken(service.token)).json()).toEqual({
      kind: 'service',
      name: 'noticeos-laptop',
      deploymentAdmin: false,
      projects: [{ workspaceId: TEST_WORKSPACE.id, projectId: granted, access: 'write' }],
    });
  });

  it('through the Worker, reads its project and gets 404 for another, as if it did not exist', async () => {
    const granted = await createProject('Granted');
    const other = await createProject('Other');
    const browser = new Browser();
    await browser.signInAsOwner();
    const { service } = await (
      await createService(browser, 'one-project', [{ projectId: granted, access: 'read' }])
    ).json<{ service: CreatedService }>();

    const listed = await getWith(service.token, '/api/tasks/projects');
    expect(listed.status).toBe(200);
    expect((listed.body.projects as { projectId: string }[]).map((project) => project.projectId)).toEqual([granted]);
    expect((await getWith(service.token, `/api/tasks?project=${granted}`)).status).toBe(200);
    expect(await getWith(service.token, `/api/tasks?project=${other}`)).toEqual({
      status: 404,
      body: { error: 'not_found', detail: `no project ${other}; /api/tasks/projects lists them` },
    });
    expect((await getWith(service.token, `/api/changes?project=${other}`)).status).toBe(404);

    // The owner, signed in in the browser, reaches both.
    const owned = await (
      await browser.fetch('/api/tasks/projects', { method: 'GET' })
    ).json<{
      projects: { projectId: string }[];
    }>();
    expect(owned.projects.map((project) => project.projectId)).toEqual(expect.arrayContaining([granted, other]));
  });

  it('through the Worker, is refused with a bearer challenge once revoked', async () => {
    const project = await createProject('Cut');
    const browser = new Browser();
    await browser.signInAsOwner();
    const { service } = await (
      await createService(browser, 'cut-off', [{ projectId: project, access: 'read' }])
    ).json<{ service: CreatedService }>();
    expect((await getWith(service.token, '/api/tasks/projects')).status).toBe(200);

    await browser.fetch(`/api/access/services/${service.id}/revoke`, { method: 'POST' });
    const refused = await call('/api/tasks/projects', { headers: { authorization: `Bearer ${service.token}` } });
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('with a read grant may read the project but not change it', async () => {
    const project = await createProject('ReadOnly');
    const browser = new Browser();
    await browser.signInAsOwner();
    const { service } = await (
      await createService(browser, 'reader', [{ projectId: project, access: 'read' }])
    ).json<{ service: CreatedService }>();

    const principal = await principalFor(service.token);
    expect(mayReach(principal, project, 'read')).toBe(true);
    expect(mayReach(principal, project, 'write')).toBe(false);
  });

  it('is refused once revoked, and a revoked credential cannot be revoked again', async () => {
    const project = await createProject('Revocable');
    const browser = new Browser();
    await browser.signInAsOwner();
    const { service } = await (
      await createService(browser, 'revocable', [{ projectId: project, access: 'write' }])
    ).json<{ service: CreatedService }>();
    expect((await meWithToken(service.token)).status).toBe(200);

    const revoked = await browser.fetch(`/api/access/services/${service.id}/revoke`, { method: 'POST' });
    expect(revoked.status).toBe(200);
    const refused = await meWithToken(service.token);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toContain('error="invalid_token"');

    expect((await browser.fetch(`/api/access/services/${service.id}/revoke`, { method: 'POST' })).status).toBe(404);
    const listed = await (
      await browser.fetch('/api/access/services')
    ).json<{ services: { id: string; revokedAt: string | null }[] }>();
    expect(listed.services.find((item) => item.id === service.id)?.revokedAt).toBeTruthy();
  });

  it('is refused when its secret is wrong', async () => {
    const project = await createProject('Guarded');
    const browser = new Browser();
    await browser.signInAsOwner();
    const { service } = await (
      await createService(browser, 'guarded', [{ projectId: project, access: 'write' }])
    ).json<{ service: CreatedService }>();
    const wrong = service.token.slice(0, -4) + (service.token.endsWith('AAAA') ? 'BBBB' : 'AAAA');

    expect((await meWithToken(wrong)).status).toBe(401);
  });

  it('stores only a hash of its secret', async () => {
    const project = await createProject('Hashed');
    const browser = new Browser();
    await browser.signInAsOwner();
    const { service } = await (
      await createService(browser, 'hashed', [{ projectId: project, access: 'read' }])
    ).json<{ service: CreatedService }>();
    const secret = service.token.split('.')[2] ?? '';

    const row = await env.DB.prepare('SELECT secret_hash FROM access_service_credentials WHERE id = ?')
      .bind(service.id)
      .first<{ secret_hash: string }>();
    expect(row?.secret_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(row?.secret_hash).not.toContain(secret);
  });

  it('refuses a name already taken, a project that does not exist, and an empty grant list, naming the field at fault', async () => {
    const project = await createProject('Checked');
    const browser = new Browser();
    await browser.signInAsOwner();
    expect((await createService(browser, 'taken', [{ projectId: project, access: 'read' }])).status).toBe(201);
    /** The status and body of a refused credential, whose sentence is in `detail`. */
    const refusalOf = async (response: Response) => ({ status: response.status, body: await response.json() });
    const said = expect.any(String);

    expect(await refusalOf(await createService(browser, 'taken', [{ projectId: project, access: 'read' }]))).toEqual({
      status: 409,
      body: { error: 'name_taken', detail: said, field: 'name' },
    });
    expect(
      await refusalOf(await createService(browser, 'unknown', [{ projectId: crypto.randomUUID(), access: 'read' }])),
    ).toEqual({ status: 400, body: { error: 'unknown_project', detail: said, field: 'grants' } });
    expect(await refusalOf(await createService(browser, 'empty', []))).toEqual({
      status: 400,
      body: { error: 'invalid_request', detail: said, field: 'grants' },
    });
    expect(
      await refusalOf(await createService(browser, 'bad access', [{ projectId: project, access: 'admin' }])),
    ).toEqual({ status: 400, body: { error: 'invalid_request', detail: said, field: 'grants' } });
    expect(await refusalOf(await createService(browser, '', [{ projectId: project, access: 'read' }]))).toEqual({
      status: 400,
      body: { error: 'invalid_request', detail: said, field: 'name' },
    });
    // A refusal that no one body field causes names none.
    expect(
      await refusalOf(await browser.fetch(`/api/access/services/${crypto.randomUUID()}/revoke`, { method: 'POST' })),
    ).toEqual({ status: 404, body: { error: 'not_found', detail: said } });
  });

  it('refuses the name Ntasks records its own changes under, in any case', async () => {
    const project = await createProject('Reserved');
    const browser = new Browser();
    await browser.signInAsOwner();

    for (const name of ['Ntasks', 'ntasks']) {
      const refused = await createService(browser, name, [{ projectId: project, access: 'write' }]);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: 'invalid_request', detail: expect.any(String), field: 'name' });
    }
  });

  it('may not be made by a service credential', async () => {
    const project = await createProject('Owned');
    const browser = new Browser();
    await browser.signInAsOwner();
    const { service } = await (
      await createService(browser, 'not-an-owner', [{ projectId: project, access: 'write' }])
    ).json<{ service: CreatedService }>();

    const response = await call('/api/access/services', {
      method: 'POST',
      headers: { authorization: `Bearer ${service.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'second', grants: [{ projectId: project, access: 'write' }] }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'owner_only',
      detail: 'only a person signed in in their browser may manage access, not an agent, a service or a connected app',
    });
  });
});

describe('the backup route through the Worker', () => {
  it('answers a backup credential granted no project, which reads no project otherwise', async () => {
    await createProject('Backed up');
    const browser = new Browser();
    await browser.signInAsOwner();
    const response = await browser.fetchJson('/api/access/services', { name: 'nightly-backup', backup: true });
    expect(response.status).toBe(201);
    const { service } = await response.json<{ service: CreatedService & { backup: boolean } }>();
    expect(service).toMatchObject({ backup: true, grants: [] });
    expect(await principalFor(service.token)).toMatchObject({ scopes: ['tasks:backup'], projects: new Map() });

    const page = await getWith(service.token, '/api/backup');
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ format: 'ntasks-backup-v1', table: 'projects' });
    expect((page.body.rows as unknown[]).length).toBeGreaterThan(0);
    expect(await getWith(service.token, '/api/tasks/projects')).toEqual({
      status: 403,
      body: { error: 'insufficient_scope', detail: 'this route needs tasks:read' },
    });
    const listed = await (
      await browser.fetch('/api/access/services', { method: 'GET' })
    ).json<{
      services: { id: string; backup: boolean }[];
    }>();
    expect(listed.services.find((listedService) => listedService.id === service.id)).toMatchObject({ backup: true });
  });

  it('answers the owner, and refuses an agent and a credential made without the backup choice', async () => {
    const project = await createProject('Not backed up');
    const browser = new Browser();
    await browser.signInAsOwner();
    expect((await browser.fetch('/api/backup', { method: 'GET' })).status).toBe(200);

    const { service } = await (
      await createService(browser, 'writer', [{ projectId: project, access: 'write' }])
    ).json<{ service: CreatedService & { backup: boolean } }>();
    expect(service.backup).toBe(false);
    const { tokens } = await connectAgent(browser, [project]);
    for (const token of [service.token, tokens.access_token]) {
      expect(await getWith(token, '/api/backup')).toEqual({
        status: 403,
        body: { error: 'insufficient_scope', detail: 'this route needs tasks:backup' },
      });
    }
  });

  it('makes a credential with no grants only for a backup, and takes backup only as true or false', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    expect((await browser.fetchJson('/api/access/services', { name: 'no-grants' })).status).toBe(400);
    const notBoolean = await browser.fetchJson('/api/access/services', { name: 'yes-backup', backup: 'yes' });
    expect(notBoolean.status).toBe(400);
    expect(await notBoolean.json()).toEqual({ error: 'invalid_request', detail: expect.any(String), field: 'backup' });
  });
});

describe('the restore route through the Worker', () => {
  /** POST /api/restore with a bearer token: refused with 409 when the store holds rows, 403 without the scope. */
  async function beginWith(token: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await call('/api/restore', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ migrations: [] }),
    });
    return { status: response.status, body: await response.json<Record<string, unknown>>() };
  }

  it('lets a restore credential granted no project reach it, and no project otherwise', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    const response = await browser.fetchJson('/api/access/services', { name: 'cutover-load', restore: true });
    expect(response.status).toBe(201);
    const { service } = await response.json<{ service: CreatedService & { restore: boolean } }>();
    expect(service).toMatchObject({ restore: true, backup: false, grants: [] });
    expect(await principalFor(service.token)).toMatchObject({ scopes: ['tasks:restore'], projects: new Map() });
    // No migrations match the store's, so the load is refused, after the scope check let it through.
    expect(await beginWith(service.token)).toMatchObject({ status: 409, body: { error: 'schema_mismatch' } });
    expect((await getWith(service.token, '/api/tasks/projects')).status).toBe(403);
  });

  it('lets the owner reach it, and refuses an agent and a credential made without the restore choice', async () => {
    const project = await createProject('Not loaded');
    const browser = new Browser();
    await browser.signInAsOwner();
    const owner = await browser.fetch('/api/restore', { method: 'POST', json: { migrations: [] } });
    expect(owner.status).toBe(409);

    const { service } = await (
      await createService(browser, 'no-restore', [{ projectId: project, access: 'write' }])
    ).json<{ service: CreatedService & { restore: boolean } }>();
    expect(service.restore).toBe(false);
    const { tokens } = await connectAgent(browser, [project]);
    for (const token of [service.token, tokens.access_token]) {
      expect(await beginWith(token)).toEqual({
        status: 403,
        body: { error: 'insufficient_scope', detail: 'this route needs tasks:restore' },
      });
    }
    const notBoolean = await browser.fetchJson('/api/access/services', { name: 'yes-restore', restore: 'yes' });
    expect(await notBoolean.json()).toEqual({ error: 'invalid_request', detail: expect.any(String), field: 'restore' });
  });
});
