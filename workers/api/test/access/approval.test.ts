import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { actorOf } from '../../src/access/principal.ts';
import { verifyRequest } from '../../src/access/verify.ts';
import { Browser, connectAgent, McpClient, ORIGIN, OWNER_GITHUB_ID } from './client.ts';
import { standInForGitHub } from './github.ts';

standInForGitHub();

describe('approving an agent', () => {
  it('lists every project and accepts one past the first 500', async () => {
    const now = new Date().toISOString();
    const bulk = Array.from({ length: 500 }, (_, i) => {
      const n = String(i).padStart(3, '0');
      return env.DB.prepare('INSERT INTO projects (id, key, name, prefix, created_at) VALUES (?, ?, ?, ?, ?)').bind(
        crypto.randomUUID(),
        `bulk-${n}.example.com`,
        `Bulk ${n}`,
        `bulk${n}`,
        now,
      );
    });
    await env.DB.batch(bulk);
    // Sorts after every bulk project by key.
    const last = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO projects (id, key, name, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(last, 'zz-last.example.com', 'Last Project', 'zzlast', now)
      .run();
    const browser = new Browser();
    await browser.signInAsOwner();

    const client = new McpClient();
    await client.register();
    const { landing } = await client.authorize(browser, 'tasks:write');
    expect(await (await browser.fetch(landing.pathname + landing.search)).text()).toContain('Last Project');

    const { tokens } = await connectAgent(browser, [last]);
    expect(await (await browser.fetch('/api/access/me', { method: 'GET' })).json()).toMatchObject({ kind: 'person' });
    const me = await (
      await browser.fetch('/api/access/agents', { method: 'GET' })
    ).json<{ agents: { grants: { projectId: string }[] }[] }>();
    expect(me.agents.some((agent) => agent.grants.some((grant) => grant.projectId === last))).toBe(true);
    expect(tokens.access_token).toBeTruthy();
  });
});

describe('the actor an agent writes as', () => {
  it('keeps an agent named after the owner apart from the owner', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    const project = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO projects (id, key, name, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(project, 'impostor.example.com', 'Impostor', 'impostor', new Date().toISOString())
      .run();
    const ownerName = `Person ${OWNER_GITHUB_ID}`;

    const { tokens } = await connectAgent(browser, [project], 'tasks:write', ownerName);
    const agent = await verifyRequest(
      new Request(`${ORIGIN}/api/mcp`, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
      env,
    );
    const owner = await verifyRequest(
      new Request(`${ORIGIN}/api/access/me`, {
        headers: { cookie: `__Secure-ntasks.session_token=${browser.cookie('__Secure-ntasks.session_token')}` },
      }),
      env,
    );
    if (!agent.ok || !owner.ok) throw new Error('both should verify');

    expect(agent.principal.name).toBe(ownerName);
    expect(actorOf(agent.principal, 'example-model')).toEqual({ name: `agent:${ownerName}`, model: 'example-model' });
    expect(actorOf(owner.principal)).toEqual({ name: ownerName });
  });

  it('prefixes a service the same way', () => {
    const service = {
      kind: 'service',
      id: 'service:x',
      credentialId: 'x',
      name: 'noticeos',
      projects: new Map(),
    } as const;
    expect(actorOf(service)).toEqual({ name: 'service:noticeos' });
  });
});
