import { env } from 'cloudflare:workers';
import { TASK_LIMITS } from '@ntasks/domain';
import { describe, expect, it } from 'vitest';
import { actorOf, personActor, personOf, uniquePersonName } from '../../src/access/principal.ts';
import { verifyRequest } from '../../src/access/verify.ts';
import { TEST_WORKSPACE } from '../store.ts';
import { Browser, connectAgent, createProjects, McpClient, ORIGIN, OWNER_GITHUB_ID } from './client.ts';
import { standInForGitHub } from './github.ts';

standInForGitHub();

describe('approving an agent', () => {
  it('lists every project and accepts one past the first 500', async () => {
    await createProjects(
      Array.from({ length: 500 }, (_, i) => {
        const n = String(i).padStart(3, '0');
        return { name: `Bulk ${n}`, key: `bulk-${n}.example.com`, prefix: `bulk${n}` };
      }),
    );
    // Sorts after every bulk project by key.
    const [last = ''] = await createProjects([{ name: 'Last Project', key: 'zz-last.example.com', prefix: 'zzlast' }]);
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
    const [project = ''] = await createProjects([
      { name: 'Impostor', key: 'impostor.example.com', prefix: 'impostor' },
    ]);
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
    // The agent acts for the owner, whose own comments are recorded under the owner's actor.
    expect(personOf(agent.principal)).toBe(actorOf(owner.principal).name);
  });

  it('prefixes a service the same way', () => {
    const service = {
      kind: 'service',
      id: 'service:x',
      credentialId: 'x',
      name: 'noticeos',
      workspace: TEST_WORKSPACE,
      projects: new Map(),
      backup: false,
      restore: false,
    } as const;
    expect(actorOf(service)).toEqual({ name: 'service:noticeos' });
  });

  it('marks an owner whose own name starts like an agent’s, so the two never meet', () => {
    const owner = {
      kind: 'person',
      id: 'person:x',
      userId: 'x',
      name: 'agent:Alice',
      admin: true,
      memberships: [],
    } as const;
    const agent = {
      kind: 'agent',
      id: 'agent:c:x',
      userId: 'x',
      personName: 'agent:Alice',
      clientId: 'c',
      name: 'Alice',
      workspaces: [],
    } as const;

    expect(actorOf(owner)).toEqual({ name: 'person:agent:Alice' });
    expect(actorOf(agent)).toEqual({ name: 'agent:Alice' });
    // The person an agent acts for is named as that person's own writes are.
    expect(personOf(agent)).toBe('person:agent:Alice');
    expect(personOf(owner)).toBe('person:agent:Alice');
  });
});

describe('the name a new person is recorded under', () => {
  const account = { id: '2301', login: 'alex-gh' };
  const held = (...names: string[]) => {
    const actors = new Set(names.map(personActor));
    return (actor: string) => actors.has(actor);
  };

  it('is their GitHub name, with their login when another person holds it, and their id when that is held too', () => {
    expect(uniquePersonName('Alex', account, held('Sam'))).toBe('Alex');
    expect(uniquePersonName('Alex', account, held('Alex'))).toBe('Alex (alex-gh)');
    expect(uniquePersonName('Alex', account, held('Alex', 'Alex (alex-gh)'))).toBe('Alex (GitHub 2301)');
    // An owner named like an agent keeps the person: prefix their actor gets.
    expect(personActor(uniquePersonName('agent:Alice', account, held('agent:Alice')))).toBe(
      'person:agent:Alice (alex-gh)',
    );
  });

  it('keeps the part in brackets whole in an actor cut to its limit', () => {
    const long = 'A'.repeat(TASK_LIMITS.actor + 20);
    const named = uniquePersonName(long, account, held(long));
    expect(personActor(named)).toHaveLength(TASK_LIMITS.actor);
    expect(personActor(named).endsWith(' (alex-gh)')).toBe(true);
    expect(personActor(named)).not.toBe(personActor(long));
  });
});
