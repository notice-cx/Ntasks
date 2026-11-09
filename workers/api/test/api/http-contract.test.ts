// The HTTP API only adds (docs/api.md#versions): a route keeps every field of
// its answer, with its type, at every later version, and every answer under
// /api names the version. fixtures/http-api.json records the fields version
// by version. This file sends every recorded route through the Worker as
// deployed, as the owner of the test workspace signed in to the web app, and
// compares the answers with the record.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { hex } from '../../src/access/crypto.ts';
import { API_VERSION, API_VERSION_HEADER, OLDEST_API_VERSION } from '../../src/version.ts';
import { WORKSPACE_HEADER } from '../../src/workspaces.ts';
import { Browser, call, connectAgent, connectApp, meWithToken } from '../access/client.ts';
import { standInForGitHub } from '../access/github.ts';
import RECORD from '../fixtures/http-api.json';
import { TEST_WORKSPACE } from '../store.ts';
import { compare, expand, merge, observe, observed, withoutValue, type ContractVersion } from './contract.ts';

standInForGitHub();

// TypeScript reads each version of the JSON as its own type, which stops
// overlapping ContractVersion once two versions record different fields.
const CONTRACT = merge(RECORD as unknown as readonly ContractVersion[]);

/** One answer a route gave. */
interface Sample {
  readonly route: string;
  readonly path: string;
  readonly status: number;
  readonly version: string | null;
  readonly body: unknown;
}

type Body = Record<string, unknown>;

/** Keeps `route`'s answer to `path`, which must be a success. */
async function keep(samples: Sample[], route: string, path: string, response: Response): Promise<Body> {
  const body = await response.json<Body>();
  samples.push({ route, path, status: response.status, version: response.headers.get(API_VERSION_HEADER), body });
  if (response.status >= 300)
    throw new Error(`${route} (${path}) answered ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

/** Sends `path` as `route` names it, from `browser` in the test workspace, and keeps the answer. */
async function send(samples: Sample[], browser: Browser, route: string, path: string, json?: Body): Promise<Body> {
  const response = await browser.fetch(path, {
    method: route.slice(0, route.indexOf(' ')),
    ...(json === undefined ? {} : { json }),
    headers: { [WORKSPACE_HEADER]: TEST_WORKSPACE.id },
  });
  return keep(samples, route, path, response);
}

/** Calls one MCP tool from `browser`, to set up what the HTTP routes then answer. */
async function tool(browser: Browser, name: string, args: Body): Promise<Body> {
  const response = await browser.fetch('/api/mcp', {
    method: 'POST',
    json: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: { workspace: TEST_WORKSPACE.id, ...args } },
    },
  });
  const reply = await response.json<{ result?: { isError?: boolean; content: { text: string }[] } }>();
  if (!reply.result || reply.result.isError) throw new Error(`${name}: ${JSON.stringify(reply)}`);
  return JSON.parse(reply.result.content[0]!.text) as Body;
}

const idOf = (body: Body, key: string) => (body[key] as { id: string }).id;

/** X-Hub-Signature-256 of `body` under `secret`, as GitHub signs a delivery. */
async function signed(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return `sha256=${hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body))))}`;
}

/** Sends every route the contract records, in states that give each field a value. */
async function drive(): Promise<readonly Sample[]> {
  const samples: Sample[] = [];
  const owner = new Browser();
  await owner.signInAsOwner();
  const as = (route: string, path: string, json?: Body) => send(samples, owner, route, path, json);

  await as('GET /api/version', '/api/version');
  await as('GET /api/access/me', '/api/access/me');

  const { project } = (await as('POST /api/tasks/projects', '/api/tasks/projects', {
    name: 'Contract',
    prefix: 'ct',
    key: 'contract.example.com',
  })) as { project: { projectId: string } };
  const projectId = project.projectId;
  const inProject = (body: Body = {}) => ({ projectId, ...body });
  await as('PATCH /api/tasks/projects', '/api/tasks/projects', inProject({ deploys: true }));
  const field = (body: Body) => as('POST /api/fields', '/api/fields', inProject(body));
  await field({ key: 'severity', name: 'Severity', type: 'single-choice', options: ['low', 'high'] });
  await field({ key: 'points', name: 'Points', type: 'number' });
  await field({ key: 'gone', name: 'Gone', type: 'text' });
  await as('POST /api/fields/:key/retire', '/api/fields/gone/retire', inProject());

  const create = async (body: Body) => (await as('POST /api/tasks', '/api/tasks', inProject(body))).id as string;
  const epic = await create({ title: 'Launch', type: 'epic', priority: 1 });
  const post = await create({
    title: 'Write the launch post',
    description: 'The post that announces the launch.',
    type: 'task',
    priority: 1,
    labels: ['copy'],
    parent: epic,
    acceptance: 'The post is published.',
    notes: 'A first draft exists.',
    design: 'Three short paragraphs.',
    estimateMinutes: 30,
    externalLinks: [{ url: 'https://example.com/pull/1', title: 'The draft', kind: 'pull-request' }],
    fields: { severity: 'high', points: 3 },
    card: {
      valuePerMonth: 120,
      likelihood: 0.4,
      reviewMinutes: 10,
      buildMinutes: 60,
      daysToSignal: 14,
      measurability: 'cohort',
      durability: 1,
      note: 'More visitors read the launch.',
      revenueFamily: 'ads',
      kill: { state: 'Nobody reads it.', date: '2026-12-31' },
    },
    changeClass: 'copy',
  });
  const date = await create({ title: 'Pick the date', parent: epic, labels: ['copy'], dueAt: '2026-11-20' });
  const advert = await create({
    title: 'Buy an advert',
    parent: epic,
    card: { valuePerMonth: 40, likelihood: 0.2, reviewMinutes: 5, daysToSignal: 7, measurability: 'unmeasured' },
  });
  const again = await create({ title: 'Write the launch post again' });
  const later = await create({ title: 'Plan the follow-up' });
  const linked = await create({ title: 'Write the notes', parent: epic });
  const unproved = await create({ title: 'Tidy the folder' });
  const decision = await create({ title: 'Ship on Monday?', type: 'decision', labels: ['human'] });
  const declined = await create({ title: 'Translate the post', labels: ['human'] });

  const task = (id: string, part = '') => `/api/tasks/${id}${part}`;
  await as('PATCH /api/tasks/:id', task(post), inProject({ priority: 0 }));
  await as(
    'PATCH /api/tasks/:id',
    task(post),
    inProject({
      claim: true,
      for: 'helper-1',
      work: {
        session: 'session-1',
        worktree: 'worktrees/launch-post',
        branch: 'launch-post',
        pr: 'https://example.com/pull/1',
        commit: 'f00dfeed',
        next: 'Send the draft.',
        touches: ['posts/launch.md'],
      },
    }),
  );
  await as('POST /api/tasks/:id/comments', task(post, '/comments'), inProject({ text: 'Draft ready.' }));
  // Pinned on the epic, a fact shows on each of its tasks; the second corrects the first, which it unpins.
  const { comment: wrong } = (await as(
    'POST /api/tasks/:id/comments',
    task(epic, '/comments'),
    inProject({ text: 'Launch is on 19 November.', pin: true }),
  )) as { comment: { id: string } };
  await as(
    'POST /api/tasks/:id/comments',
    task(epic, '/comments'),
    inProject({ text: 'Launch is on 20 November.', pin: true, unpin: [wrong.id] }),
  );
  await as('POST /api/tasks/:id/close', task(date, '/close'), inProject({ reason: 'Chosen.', commit: 'a1b2c3d4e5f6' }));
  for (const stage of ['merged', 'live'])
    await as('POST /api/delivery', '/api/delivery', { repository: 'example/launch', stage, commits: ['a1b2c3d4e5f6'] });
  await as(
    'POST /api/tasks/:id/close',
    task(advert, '/close'),
    inProject({ reason: 'Bought.', pullRequest: 'https://github.com/example/launch/pull/7' }),
  );
  await as(
    'POST /api/tasks/:id/close',
    task(again, '/close'),
    inProject({ reason: 'Filed twice.', resolution: 'duplicate', duplicateOf: post }),
  );
  await as('PATCH /api/tasks/:id', task(later), inProject({ defer: '2026-12-01' }));
  await tool(owner, 'link_tasks', { task: date, to: post, type: 'merges-after' });
  const checked = (await tool(owner, 'create_task', { project: projectId, title: 'Check the links' })).id as string;
  await tool(owner, 'claim_task', { task: checked, model: 'claude-sonnet-5-5' });
  await tool(owner, 'close_task', {
    task: checked,
    reason: 'Checked.',
    commit: 'c0ffee12',
    model: 'claude-sonnet-5-5',
  });
  const held = (await tool(owner, 'create_task', { project: projectId, title: 'Fix the links' })).id as string;
  await tool(owner, 'claim_task', { task: held, model: 'claude-sonnet-5-5' });
  await as(
    'POST /api/tasks/:id/close',
    task(linked, '/close'),
    inProject({ reason: 'Written.', link: 'https://example.com/notes' }),
  );
  await as('POST /api/tasks/:id/close', task(unproved, '/close'), inProject({ reason: 'Tidied.' }));
  await as('POST /api/tasks/:id/respond', task(decision, '/respond'), inProject({ response: 'Yes, Monday.' }));
  await as('POST /api/tasks/:id/dismiss', task(declined, '/dismiss'), inProject({ reason: 'Not this time.' }));

  const choice = (
    await tool(owner, 'create_task', {
      project: projectId,
      title: 'Pick the headline',
      labels: ['human'],
      choices: {
        question: 'Which headline?',
        options: [
          { key: 'a', label: 'Launch day', recommended: true },
          { key: 'b', label: 'It is here' },
        ],
      },
    })
  ).id as string;
  await as('POST /api/tasks/:id/choose', task(choice, '/choose'), inProject({ option: 'a', note: 'Shorter.' }));

  const deploy = (await tool(owner, 'create_task', { project: projectId, title: 'Deploy the post' })).id as string;
  const approval = idOf(
    await tool(owner, 'request_human_approval', { task: deploy, reason: 'Publish the post.' }),
    'approval',
  );
  await as('POST /api/gates/:id/resolve', `/api/gates/${approval}/resolve`, inProject());

  const mailing = (await tool(owner, 'create_task', { project: projectId, title: 'Email the list' })).id as string;
  const relayed = idOf(
    await tool(owner, 'request_human_approval', { task: mailing, reason: 'Email the list.' }),
    'approval',
  );
  const { proposalVersion } = await tool(owner, 'get_task', { task: relayed });
  await tool(owner, 'reconcile_task', {
    task: relayed,
    action: 'answer',
    proposal_version: proposalVersion,
    quote: 'Send it.',
    source: 'comment:example',
  });
  await as('POST /api/tasks/:id/dispute', task(relayed, '/dispute'), inProject());

  const ask = async (title: string) => {
    const waiting = (await tool(owner, 'create_task', { project: projectId, title })).id as string;
    const asked = await tool(owner, 'request_human_action', {
      task: waiting,
      title,
      context: 'The demo still runs the old release.',
      steps: [
        { text: 'On the demo host, update to the release.', command: './update.sh --commit a1b2c3d4' },
        { text: 'Open the demo and sign in.' },
      ],
    });
    return idOf(asked, 'request');
  };
  const step = (gate: string, body: Body) =>
    as('POST /api/gates/:id/steps', `/api/gates/${gate}/steps`, inProject(body));
  const stuck = await ask('Update the demo');
  await step(stuck, { step: 2, done: true, note: 'Signed in as a visitor.' });
  await step(stuck, { step: 1, stuck: 'The host asks for a password.' });
  const done = await ask('Update the staging copy');
  await step(done, { step: 2, done: true });
  await step(done, { step: 1, done: true });

  // Tasks accepted as done on a person's own call: in the web app, relayed by an agent, and through a connected app.
  const criteria = '- Contributions are live.\n- An accountant confirms the tax treatment.';
  const acceptable = async (title: string) =>
    (await tool(owner, 'create_task', { project: projectId, title, acceptance: criteria })).id as string;
  const shownOn = async (id: string) => (await tool(owner, 'get_task', { task: id })).proposalVersion as string;
  const contributions = await acceptable('Take contributions');
  await as(
    'POST /api/tasks/:id/accept',
    task(contributions, '/accept'),
    inProject({ met: [1], reason: 'I accept the tax risk.', proposalVersion: await shownOn(contributions) }),
  );
  const donations = await acceptable('Take donations');
  await tool(owner, 'reconcile_task', {
    task: donations,
    action: 'accepted',
    met: [1, 2],
    proposal_version: await shownOn(donations),
    quote: 'Close it, both are done.',
    source: 'comment:example',
  });

  await as('GET /api/tasks/projects', '/api/tasks/projects');
  await as('GET /api/tasks/capabilities', '/api/tasks/capabilities');
  await as('GET /api/tasks', `/api/tasks?project=${projectId}`);
  await as('GET /api/tasks', `/api/tasks?project=${projectId}&status=closed&closedDays=56`);
  await as('GET /api/tasks', `/api/tasks?project=${projectId}&field.severity=high`);
  await as('GET /api/tasks', `/api/tasks?project=${projectId}&stage=built,merged,live`);
  const page = await as('GET /api/tasks?label', `/api/tasks?project=${projectId}&label=copy&limit=1`);
  await as('GET /api/tasks?label', `/api/tasks?project=${projectId}&label=copy&after=${String(page.next)}`);
  await as('GET /api/tasks/search', '/api/tasks/search?q=launch');
  for (const id of [post, date, advert, linked, unproved, choice, approval, relayed, stuck, done, donations])
    await as('GET /api/tasks/:id', `${task(id)}?project=${projectId}`);
  for (const id of [post, checked])
    await as('GET /api/tasks/:id/history', `${task(id, '/history')}?project=${projectId}`);
  await as('GET /api/changes', `/api/changes?after=0&project=${projectId}`);
  await as('GET /api/fields', `/api/fields?project=${projectId}`);
  await as('GET /api/tasks/agent-stats', `/api/tasks/agent-stats?project=${projectId}`);
  let next: unknown = null;
  do {
    next = (await as('GET /api/backup', next === null ? '/api/backup' : `/api/backup?page=${String(next)}`)).next;
  } while (next !== null);

  const { workspace } = (await as('POST /api/workspaces', '/api/workspaces', { name: 'Second' })) as {
    workspace: { workspaceId: string };
  };
  await as('PATCH /api/workspaces', '/api/workspaces', { workspaceId: workspace.workspaceId, name: 'Second, renamed' });
  await as('GET /api/workspaces', '/api/workspaces');
  await as('POST /api/access/invitations', '/api/access/invitations', { githubLogin: 'person-2201' });
  const revoked = (await as('POST /api/access/invitations', '/api/access/invitations', { githubLogin: 'person-2202' }))
    .invitation as { invitationId: string };
  const member = new Browser({ joinTestWorkspace: false });
  await member.signInWithGitHub(2201);
  const { members } = (await as('GET /api/access/members', '/api/access/members')) as {
    members: { userId: string; githubLogin: string }[];
  };
  await as('POST /api/access/invitations/:id/revoke', `/api/access/invitations/${revoked.invitationId}/revoke`, {});
  const joined = members.find((entry) => entry.githubLogin === 'person-2201')!;
  await as('POST /api/access/members/:id/remove', `/api/access/members/${joined.userId}/remove`, {});

  const { client, tokens } = await connectAgent(owner, [projectId]);
  // The page an agent names when it registers, which the stand-in client leaves out.
  await env.DB.prepare('UPDATE auth_oauth_client SET uri = ? WHERE client_id = ?')
    .bind('https://agent.example.com', client.clientId)
    .run();
  await keep(samples, 'GET /api/access/me', '/api/access/me', await meWithToken(tokens.access_token));
  await as('GET /api/access/agents', '/api/access/agents');
  await as('POST /api/access/agents/:id/revoke', `/api/access/agents/${client.clientId}/revoke`, {});
  const service = (body: Body) => as('POST /api/access/services', '/api/access/services', body);
  await service({ name: 'Deploys', grants: [{ projectId, access: 'write' }] });
  const backups = (await service({ name: 'Backups', backup: true })).service as { id: string };
  await as('POST /api/access/services/:id/revoke', `/api/access/services/${backups.id}/revoke`, {});
  await as('GET /api/access/services', '/api/access/services');

  // GitHub's deliveries, signed with the secret the owner saves: one moves a task, and a ping moves none.
  const secret = 'contract-webhook-secret-0123456789abcdef';
  await as('GET /api/access/github', '/api/access/github');
  await as('POST /api/access/github', '/api/access/github', { secret, deployChecks: ['Deploy'] });
  const deployed = await create({ title: 'Deploy the launch page' });
  await as(
    'POST /api/tasks/:id/close',
    task(deployed, '/close'),
    inProject({ reason: 'Live.', commit: 'c3d4e5f6a7b8' }),
  );
  const checkRun = {
    action: 'completed',
    check_run: {
      name: 'Deploy',
      conclusion: 'success',
      head_sha: 'c3d4e5f6a7b8',
      check_suite: { head_branch: 'main' },
    },
    repository: { full_name: 'example/launch', default_branch: 'main' },
  };
  for (const [event, payload] of [
    ['check_run', checkRun],
    ['ping', { hook_id: 1 }],
  ] as const) {
    const body = JSON.stringify(payload);
    const path = `/api/github/${TEST_WORKSPACE.id}`;
    const delivery = await call(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-hub-signature-256': await signed(secret, body),
      },
      body,
    });
    await keep(samples, 'POST /api/github/:workspaceId', path, delivery);
  }
  await as('POST /api/access/github/remove', '/api/access/github/remove', {});

  // A connected app: the owner registers it, signs in through it and picks an option with its token.
  const registered = (
    await as('POST /api/access/apps', '/api/access/apps', {
      name: 'Example Tower',
      redirectUris: ['https://tower.example.com/tasks/signed-in'],
    })
  ).app as { clientId: string };
  const app = { clientId: registered.clientId, redirect: 'https://tower.example.com/tasks/signed-in' };
  const { access_token: appToken } = await connectApp(owner, app);
  await keep(samples, 'GET /api/access/me', '/api/access/me', await meWithToken(appToken));
  const picked = (
    await tool(owner, 'create_task', {
      project: projectId,
      title: 'Pick the image',
      labels: ['human'],
      choices: {
        question: 'Which image?',
        options: [
          { key: 'a', label: 'The photo', recommended: true },
          { key: 'b', label: 'The drawing' },
        ],
      },
    })
  ).id as string;
  const fromApp = await call(task(picked, '/choose'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${appToken}`,
      'content-type': 'application/json',
      [WORKSPACE_HEADER]: TEST_WORKSPACE.id,
    },
    body: JSON.stringify(inProject({ option: 'b', note: 'Clearer.' })),
  });
  await keep(samples, 'POST /api/tasks/:id/choose', task(picked, '/choose'), fromApp);
  await as('GET /api/tasks/:id', `${task(picked)}?project=${projectId}`);
  const ticked = await ask('Update the copy at the office');
  for (const body of [
    { step: 1, done: true, note: 'Took two minutes.' },
    { step: 2, stuck: 'The office is closed today.' },
  ]) {
    const fromTower = await call(`/api/gates/${ticked}/steps`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${appToken}`,
        'content-type': 'application/json',
        [WORKSPACE_HEADER]: TEST_WORKSPACE.id,
      },
      body: JSON.stringify(inProject(body)),
    });
    await keep(samples, 'POST /api/gates/:id/steps', `/api/gates/${ticked}/steps`, fromTower);
  }
  const grants = await acceptable('Take grants');
  const acceptedInApp = await call(task(grants, '/accept'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${appToken}`,
      'content-type': 'application/json',
      [WORKSPACE_HEADER]: TEST_WORKSPACE.id,
    },
    body: JSON.stringify(inProject({ met: [], proposalVersion: await shownOn(grants) })),
  });
  await keep(samples, 'POST /api/tasks/:id/accept', task(grants, '/accept'), acceptedInApp);
  await as('GET /api/access/apps', '/api/access/apps');
  await as('POST /api/access/apps/:id/revoke', `/api/access/apps/${app.clientId}/revoke`, {});
  await as('POST /api/access/apps/:id/remove', `/api/access/apps/${app.clientId}/remove`, {});
  return samples;
}

let driven: Promise<readonly Sample[]> | undefined;
/** The answers of every route, sent once for the whole file. */
const answers = () => (driven ??= drive());

/** Each route's answers, compared with its recorded contract. */
async function differences() {
  const byRoute = new Map<string, Sample[]>();
  for (const sample of await answers()) byRoute.set(sample.route, [...(byRoute.get(sample.route) ?? []), sample]);
  return [...new Set([...Object.keys(CONTRACT.routes), ...byRoute.keys()])].map((route) => {
    const contract = expand(CONTRACT.routes[route] ?? {}, CONTRACT.shapes);
    const held = observed();
    for (const sample of byRoute.get(route) ?? []) observe(sample.body, contract, held);
    return {
      route,
      sent: byRoute.has(route),
      recorded: route in CONTRACT.routes,
      ...compare(route, contract, held),
    };
  });
}

describe('the version', () => {
  it('answers GET /api/version before sign-in, with the version every answer under /api names', async () => {
    const response = await call('/api/version');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: API_VERSION, oldest: OLDEST_API_VERSION });
    for (const [path, status] of [
      ['/api/version', 200],
      ['/api/tasks/projects', 401],
      ['/api/elsewhere', 404],
      ['/api/access/me', 401],
    ] as const) {
      const answer = await call(path);
      expect(answer.status, path).toBe(status);
      expect(answer.headers.get(API_VERSION_HEADER), path).toBe(String(API_VERSION));
    }
    expect((await call('/api/version', { method: 'POST' })).status).toBe(405);
  });

  it('is the version the contract is recorded up to', () => {
    expect(CONTRACT.version).toBe(API_VERSION);
  });

  it('names the version on every answer the contract records', async () => {
    const unnamed = (await answers()).filter((sample) => sample.version !== String(API_VERSION));
    expect(unnamed.map((sample) => `${sample.route} ${sample.path}`)).toEqual([]);
  });
});

describe('the contract', () => {
  it('keeps every recorded route and field, with its recorded type', async () => {
    const found = await differences();
    expect(found.filter((route) => route.recorded && !route.sent).map((route) => route.route)).toEqual([]);
    expect(found.flatMap((route) => route.removed)).toEqual([]);
    expect(found.flatMap((route) => route.retyped)).toEqual([]);
    // A field these answers never give a value has a type nothing checks: the drive above sets one up.
    expect(withoutValue(found)).toEqual([]);
  });

  // An addition passes the test above. Recording it, under a new version, is
  // what holds it to the contract and tells a client which version has it.
  it('records every field the routes answer', async () => {
    expect((await differences()).flatMap((route) => route.unrecorded)).toEqual([]);
  });

  it('finds a removed or retyped field, and lets an added one through as unrecorded', () => {
    const contract = expand(
      { tasks: 'array', 'tasks[]': '@task' },
      { task: { id: 'string', assignee: 'null|string' } },
    );
    const against = (...answers: unknown[]) => {
      const seen = observed();
      for (const answer of answers) observe(answer, contract, seen);
      return compare('GET /x', contract, seen);
    };
    const kept = against({
      tasks: [
        { id: 'a', assignee: 'agent-a' },
        { id: 'b', assignee: null },
      ],
    });
    expect(kept).toMatchObject({ removed: [], retyped: [], unrecorded: [] });
    expect(withoutValue([kept])).toEqual([]);
    expect(against({ tasks: [{ id: 'a', assignee: 'agent-a', dueAt: '2026-12-01' }] })).toMatchObject({
      removed: [],
      retyped: [],
      unrecorded: ['shapes.task: "dueAt": "string"'],
    });
    expect(against({ tasks: [{ assignee: 'agent-a' }] }).removed).toEqual(['GET /x tasks[].id (shape task)']);
    expect(against({ tasks: [{ id: 7, assignee: 'agent-a' }] }).retyped).toEqual([
      'GET /x tasks[].id (shape task): answered as number, recorded as string',
    ]);
    expect(against({ tasks: [{ id: 'a', assignee: 'agent-a' }, { id: 'b' }] }).retyped).toEqual([
      'GET /x tasks[].assignee (shape task): answered as absent|string, recorded as null|string',
    ]);
    // One answer leaving a field out is found though another answer of the route holds it.
    expect(against({ tasks: [{ id: 'a', assignee: 'agent-a' }] }, { tasks: [{ assignee: null }] }).retyped).toEqual([
      'GET /x tasks[].id (shape task): answered as absent|string, recorded as string',
    ]);
    const unassigned = against({ tasks: [{ id: 'a', assignee: null }] });
    expect(withoutValue([unassigned])).toEqual(['shape task assignee']);
    expect(withoutValue([unassigned, kept])).toEqual([]);
  });

  it('refuses a field recorded twice, so a later version cannot change its type', () => {
    expect(() =>
      merge([
        { version: 1, routes: { 'GET /x': { id: 'string' } } },
        { version: 2, routes: { 'GET /x': { id: 'number' } } },
      ]),
    ).toThrow('GET /x id is recorded twice');
  });
});
