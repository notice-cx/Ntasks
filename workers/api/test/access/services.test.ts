import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { may, type Principal } from '../../src/access/principal.ts';
import { verifyRequest } from '../../src/access/verify.ts';
import { Browser, call, createProject, meWithToken, ORIGIN } from './client.ts';
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

/** The principal a bearer token signs in as; fails the test when it is refused. */
async function principalFor(token: string): Promise<Principal> {
  const verification = await verifyRequest(
    new Request(`${ORIGIN}/api/mcp`, { headers: { authorization: `Bearer ${token}` } }),
    env,
  );
  if (!verification.ok) throw new Error(`refused: ${verification.reason}`);
  return verification.principal;
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

    const principal = await principalFor(service.token);
    expect(principal).toMatchObject({ kind: 'service', name: 'noticeos-laptop', id: `service:${service.id}` });
    expect(may(principal, granted, 'read')).toBe(true);
    expect(may(principal, granted, 'write')).toBe(true);
    expect(may(principal, other, 'read')).toBe(false);
    expect(await (await meWithToken(service.token)).json()).toEqual({
      kind: 'service',
      name: 'noticeos-laptop',
      projects: [{ projectId: granted, access: 'write' }],
    });
  });

  it('with a read grant may read the project but not change it', async () => {
    const project = await createProject('ReadOnly');
    const browser = new Browser();
    await browser.signInAsOwner();
    const { service } = await (
      await createService(browser, 'reader', [{ projectId: project, access: 'read' }])
    ).json<{ service: CreatedService }>();

    const principal = await principalFor(service.token);
    expect(may(principal, project, 'read')).toBe(true);
    expect(may(principal, project, 'write')).toBe(false);
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

  it('refuses a name already taken, a project that does not exist, and an empty grant list', async () => {
    const project = await createProject('Checked');
    const browser = new Browser();
    await browser.signInAsOwner();
    expect((await createService(browser, 'taken', [{ projectId: project, access: 'read' }])).status).toBe(201);

    expect((await createService(browser, 'taken', [{ projectId: project, access: 'read' }])).status).toBe(409);
    const unknown = await createService(browser, 'unknown', [{ projectId: crypto.randomUUID(), access: 'read' }]);
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: 'unknown_project' });
    expect((await createService(browser, 'empty', [])).status).toBe(400);
    expect((await createService(browser, 'bad access', [{ projectId: project, access: 'admin' }])).status).toBe(400);
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
    expect(await response.json()).toEqual({ error: 'owner_only' });
  });
});
