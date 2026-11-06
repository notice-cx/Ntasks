import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ON_BEHALF_OF_HEADER, signInAuthenticator, type SignedIn } from '../../src/access/authenticator.ts';
import { actorOf } from '../../src/access/principal.ts';
import type { TaskStore } from '../../src/store/index.ts';
import { store } from '../store.ts';
import { Browser, call, connectAgent, createProject, ORIGIN, OWNER_GITHUB_ID } from './client.ts';
import { standInForGitHub } from './github.ts';

standInForGitHub();

const authenticator = signInAuthenticator(env);
const SESSION_COOKIE = '__Secure-ntasks.session_token';

/** A service credential named `name`, granted `projectId` for writing; returns its id and token. */
async function serviceFor(browser: Browser, name: string, projectId: string): Promise<{ id: string; token: string }> {
  const response = await browser.fetchJson('/api/access/services', {
    name,
    grants: [{ projectId, access: 'write' }],
  });
  expect(response.status).toBe(201);
  return (await response.json<{ service: { id: string; token: string } }>()).service;
}

/** The sender a request with these headers signs in as, or null when refused. */
function signIn(headers: Record<string, string>): Promise<SignedIn | null> {
  return authenticator.authenticate(new Request(`${ORIGIN}/api/mcp`, { headers }));
}

async function signedIn(headers: Record<string, string>): Promise<SignedIn> {
  const sender = await signIn(headers);
  if (!sender) throw new Error('refused');
  return sender;
}

/** A SHA-256 request hash, as the API sends the engine with a retry key. */
async function hashOf(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Calls an MCP tool through the Worker with these headers, and returns its structured answer. */
async function tool(headers: Record<string, string>, name: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await call('/api/mcp', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const reply = await response.json<{ result?: { isError?: boolean; content: { text: string }[] } }>();
  if (!reply.result || reply.result.isError) throw new Error(`${name} failed: ${JSON.stringify(reply)}`);
  return JSON.parse(reply.result.content[0]?.text ?? 'null') as unknown;
}

describe('a service acting for an agent it names', () => {
  it('signs in as service:<credential>/<agent>, with the retry principal scoped to the agent', async () => {
    const project = await createProject('Shared');
    const browser = new Browser();
    await browser.signInAsOwner();
    const service = await serviceFor(browser, 'noticeos', project);
    const bearer = { authorization: `Bearer ${service.token}` };

    const plain = await signedIn(bearer);
    const forAgent = await signedIn({ ...bearer, [ON_BEHALF_OF_HEADER]: 'outcome-review-filer' });
    expect(plain).toMatchObject({ id: `service:${service.id}`, name: 'service:noticeos' });
    expect(forAgent).toMatchObject({
      id: `service:${service.id}/outcome-review-filer`,
      name: 'service:noticeos/outcome-review-filer',
      scopes: plain.scopes,
      projects: plain.projects,
    });
  });

  it('records the agent as the filer and the claim’s assignee, and lists its tasks as its own', async () => {
    const project = await createProject('Claimed');
    const browser = new Browser();
    await browser.signInAsOwner();
    const service = await serviceFor(browser, 'noticeos-claims', project);
    const bearer = { authorization: `Bearer ${service.token}` };
    const agentA = await signedIn({ ...bearer, [ON_BEHALF_OF_HEADER]: 'agent-a' });

    const task = await runInDurableObject(store(), async (instance: TaskStore) => {
      const actor = actorOf(agentA.principal, 'example-model');
      const created = await instance.tasks.createTask(project, { title: 'Write the report' }, actor);
      const claimed = await instance.tasks.writeTask(
        project,
        created.task.id,
        { expectedVersion: created.task.version, set: { assignee: agentA.name, status: 'in_progress' } },
        actor,
      );
      return claimed.task;
    });
    expect(task.filedBy).toBe('service:noticeos-claims/agent-a');
    expect(task.assignee).toBe('service:noticeos-claims/agent-a');

    // Through the Worker, "assigned to me" means the agent the header names.
    const mine = (headers: Record<string, string>) =>
      tool(headers, 'list_tasks', { workspace: env.WORKSPACE_ID, project, assignee: 'me' }) as Promise<{
        tasks: { id: string }[];
      }>;
    expect((await mine({ ...bearer, [ON_BEHALF_OF_HEADER]: 'agent-a' })).tasks.map((found) => found.id)).toEqual([
      task.id,
    ]);
    expect((await mine({ ...bearer, [ON_BEHALF_OF_HEADER]: 'agent-b' })).tasks).toEqual([]);
  });

  it('keeps two agents’ idempotency keys apart', async () => {
    const project = await createProject('Retried');
    const browser = new Browser();
    await browser.signInAsOwner();
    const service = await serviceFor(browser, 'noticeos-retries', project);
    const bearer = { authorization: `Bearer ${service.token}` };
    const agentA = await signedIn({ ...bearer, [ON_BEHALF_OF_HEADER]: 'agent-a' });
    const agentB = await signedIn({ ...bearer, [ON_BEHALF_OF_HEADER]: 'agent-b' });
    const input = { title: 'File the same thing' };
    const requestHash = await hashOf(JSON.stringify(input));

    const [first, second, again] = await runInDurableObject(store(), async (instance: TaskStore) => {
      const create = (sender: SignedIn) =>
        instance.tasks.createTask(project, input, actorOf(sender.principal), {
          principal: sender.id,
          operation: 'create_task',
          key: 'same-key-0001',
          requestHash,
        });
      return [await create(agentA), await create(agentB), await create(agentA)];
    });
    expect(first.task.id).not.toBe(second.task.id);
    expect(again).toMatchObject({ replayed: true, task: { id: first.task.id } });
  });

  it('files and claims a task through the MCP write tools as the agent it names', async () => {
    const project = await createProject('Written');
    const browser = new Browser();
    await browser.signInAsOwner();
    const service = await serviceFor(browser, 'noticeos-writes', project);
    const bearer = { authorization: `Bearer ${service.token}` };
    const agentA = { ...bearer, [ON_BEHALF_OF_HEADER]: 'agent-a' };
    const agentB = { ...bearer, [ON_BEHALF_OF_HEADER]: 'agent-b' };
    const workspace = env.WORKSPACE_ID;
    const create = (headers: Record<string, string>) =>
      tool(headers, 'create_task', {
        workspace,
        project,
        title: 'File it through the tool',
        model: 'example-model',
        idempotency_key: 'create-same-key-0001',
      }) as Promise<{ id: string; replayed: boolean }>;

    const created = await create(agentA);
    const claimed = (await tool(agentA, 'claim_task', {
      workspace,
      project,
      task: created.id,
      model: 'example-model',
      idempotency_key: 'claim-agent-a-0001',
    })) as { task: { assignee: string } };
    expect(claimed.task.assignee).toBe('service:noticeos-writes/agent-a');
    const stored = await runInDurableObject(store(), (instance: TaskStore) =>
      instance.tasks.getTask(project, created.id),
    );
    expect(stored).toMatchObject({
      filedBy: 'service:noticeos-writes/agent-a',
      filedModel: 'example-model',
      assignee: 'service:noticeos-writes/agent-a',
      assigneeModel: 'example-model',
    });

    // The same idempotency key from another agent files that agent's own task;
    // from the first agent again, it replays the first answer.
    const fromB = await create(agentB);
    expect(fromB).toMatchObject({ replayed: false });
    expect(fromB.id).not.toBe(created.id);
    expect(await create(agentA)).toEqual({ ...created, replayed: true });
  });

  it('refuses a malformed or too long agent name with 400, through the Worker', async () => {
    const project = await createProject('Refused');
    const browser = new Browser();
    await browser.signInAsOwner();
    const service = await serviceFor(browser, 'noticeos-refusals', project);
    const longName = await serviceFor(browser, 'n'.repeat(64), project);
    const get = (token: string, agent: string) =>
      call('/api/tasks/projects', { headers: { authorization: `Bearer ${token}`, [ON_BEHALF_OF_HEADER]: agent } });

    expect((await get(service.token, 'agent-a')).status).toBe(200);
    for (const agent of ['has space', 'agent#1', 'x'.repeat(129)]) {
      const refused = await get(service.token, agent);
      expect(refused.status, agent).toBe(400);
      expect(await refused.json()).toEqual({
        error: 'invalid_request',
        detail: `${ON_BEHALF_OF_HEADER} is 1 to 128 of the characters A-Z a-z 0-9 . _ : / -`,
      });
    }
    // service:<64-character name>/ leaves 55 characters of the 128 an actor may have.
    expect((await get(longName.token, 'a'.repeat(55))).status).toBe(200);
    const tooLong = await get(longName.token, 'a'.repeat(56));
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({
      error: 'invalid_request',
      detail: `${ON_BEHALF_OF_HEADER} is at most 55 characters with this credential`,
    });
  });
});

describe('the owner and OAuth agents', () => {
  it('ignore the header, even a malformed one', async () => {
    const project = await createProject('Ignored');
    const browser = new Browser();
    await browser.signInAsOwner();
    const cookie = { cookie: `${SESSION_COOKIE}=${browser.cookie(SESSION_COOKIE)}` };

    for (const agent of ['agent-a', 'has space']) {
      expect(await signedIn({ ...cookie, [ON_BEHALF_OF_HEADER]: agent })).toMatchObject({
        name: `Person ${OWNER_GITHUB_ID}`,
        id: expect.stringMatching(/^person:[^/]+$/u),
      });
    }

    const { tokens } = await connectAgent(browser, [project]);
    for (const agent of ['agent-a', 'has space']) {
      expect(
        await signedIn({ authorization: `Bearer ${tokens.access_token}`, [ON_BEHALF_OF_HEADER]: agent }),
      ).toMatchObject({
        name: 'agent:Example Agent',
        id: expect.stringMatching(/^agent:[^/]+$/u),
      });
    }
  });
});
