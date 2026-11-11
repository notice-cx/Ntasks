// The MCP read tools, as an agent calls them: their results, the workspace
// and scope every call is checked against, and the sentences a refused call
// returns. Names, arguments and result fields are NoticeOS's task tools'.
import { PARENT_CONTEXT_LIMITS, type HeldTask, type Project, type TaskEngine } from '@ntasks/domain';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { SCOPES } from '../../src/auth.ts';
import {
  GUIDE_TOOLS,
  INSTRUCTIONS_BUDGET,
  ON_THE_TASK_BRIEF,
  TASK_QUALITY,
  TASK_START,
  TASK_WORKFLOW,
  taskInstructions,
  unofferedTools,
  WHATS_CHANGED,
} from '../../src/mcp/guide.ts';
import { MCP_TOOLS, taskServer } from '../../src/mcp/server.ts';
import { AGENT, clock, newProject, OWNER } from '../engine/helpers.ts';
import type { Principal } from '../../src/auth.ts';
import {
  api,
  callTool,
  get,
  grantedOnly,
  NOBODY,
  ORIGIN,
  read,
  READER,
  refusal,
  worker,
  WORKSPACE,
  type TestApi,
} from './helpers.ts';

const time = clock('2026-11-06T12:00:00.000Z');
let target: TestApi;
let engine: TaskEngine;
let project: Project;
let other: Project;
/** Task ids by role in the fixture. */
const ids: Record<string, string> = {};

beforeAll(async () => {
  target = api({ now: time.now });
  engine = target.engine;
  project = await newProject(engine);
  other = await newProject(engine);
  const make = async (name: string, input: Parameters<TaskEngine['createTask']>[1], where = project) => {
    ids[name] = (await engine.createTask(where.id, input, AGENT)).task.id;
    time.advance(1);
  };
  await make('epic', { title: 'Launch the guide', type: 'epic', priority: 1 });
  await make('child', { title: 'Write the guide chapter', parentId: ids.epic, labels: ['docs'], priority: 1 });
  await make('blocker', { title: 'Choose the guide format', priority: 0, labels: ['docs', 'human'] });
  await make('blocked', {
    title: 'Publish the guide',
    links: [{ direction: 'depends-on', taskId: ids.blocker!, type: 'blocks' }],
    priority: 2,
  });
  await make('bug', { title: 'Fix the broken guide link', type: 'bug', priority: 3 });
  await make('elsewhere', { title: 'Guide for the other project' }, other);
  await make('closed', { title: 'Draft the guide outline', priority: 2 });
  await engine.writeTask(
    project.id,
    ids.closed!,
    { expectedVersion: 1, close: { reason: 'Merged.', resolution: 'done' } },
    OWNER,
  );
  await engine.writeTask(
    project.id,
    ids.bug!,
    { expectedVersion: 1, set: { assignee: READER.name, status: 'in_progress' } },
    { name: READER.name, model: 'model-a' },
  );
  await engine.addComment(project.id, ids.child!, 'Half written.', OWNER);
});

describe('tools/list', () => {
  it("lists NoticeOS's task tools in its order, then Ntasks' own, each but list_workspaces and get_task_guide naming its workspace", async () => {
    const response = await target.fetch(
      new Request(`${ORIGIN}/api/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    const { result } = (await response.json()) as {
      result: {
        tools: {
          name: string;
          inputSchema: { properties: object; required: string[] };
          annotations: object;
        }[];
      };
    };
    expect(result.tools.map((tool) => tool.name)).toEqual([
      'list_workspaces',
      'get_task_guide',
      'reconcile_task',
      'list_projects',
      'get_agent_stats',
      'list_tasks',
      'get_task',
      'get_task_history',
      'create_task',
      'create_tasks',
      'claim_task',
      'update_task',
      'comment_on_task',
      'link_tasks',
      'request_human_approval',
      'request_human_action',
      'close_task',
      'report_delivery',
      'list_fields',
      'define_field',
      'retire_field',
    ]);
    for (const tool of result.tools.slice(2)) {
      expect(tool.inputSchema.properties, tool.name).toHaveProperty('workspace');
      expect(tool.inputSchema.required, tool.name).not.toContain('workspace');
    }
    const reads = [
      'list_workspaces',
      'get_task_guide',
      'list_projects',
      'get_agent_stats',
      'list_tasks',
      'get_task',
      'get_task_history',
    ];
    for (const tool of result.tools)
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: [...reads, 'list_fields'].includes(tool.name),
      });
  });
});

describe('list_workspaces and get_task_guide', () => {
  it('names the one workspace, the sender role and access, and the guide version', async () => {
    const guide = (await callTool<{ version: string; guide: string }>(target, 'get_task_guide')).value!;
    expect(guide.version).toMatch(/^[0-9a-f]{12}$/u);
    expect(guide.guide.startsWith('# Working with Ntasks tasks')).toBe(true);
    expect((await callTool(target, 'list_workspaces')).value).toEqual({
      guideVersion: guide.version,
      workspaces: [
        { workspaceId: WORKSPACE.id, name: WORKSPACE.name, role: 'viewer', status: 'active', access: [SCOPES.read] },
      ],
    });
    const writer = api({
      principal: { id: 'p-w', name: 'agent-w', scopes: [SCOPES.write, SCOPES.read, 'other:scope'], projects: 'all' },
    });
    const listed = (await callTool<{ workspaces: { role: string; access: string[] }[] }>(writer, 'list_workspaces'))
      .value!;
    expect(listed.workspaces[0]).toMatchObject({ role: 'operator', access: [SCOPES.read, SCOPES.write] });
  });

  it('offer every tool the guide names, so neither says a step does not apply', async () => {
    const response = await target.fetch(
      new Request(`${ORIGIN}/api/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {} },
        }),
      }),
    );
    const { result } = (await response.json()) as { result: { instructions: string } };
    expect(unofferedTools(MCP_TOOLS.map((tool) => tool.name))).toBeNull();
    expect(result.instructions.startsWith(TASK_START)).toBe(true);
    const guide = (await callTool<{ guide: string }>(target, 'get_task_guide')).value!;
    expect(guide.guide).not.toContain('## This endpoint');
    // The note an endpoint gives when it lacks some of them, naming each in any order.
    const note = unofferedTools(['list_tasks']);
    expect(note).toMatch(/^This endpoint does not offer /u);
    expect(note).toContain('list_workspaces');
    expect(note).toContain('list_projects');
    expect(note).not.toContain('list_tasks');
  });

  it('come from a guide that names every tool it lists', () => {
    const text = [TASK_START, ...TASK_WORKFLOW, ...TASK_QUALITY, ...WHATS_CHANGED].join('\n');
    for (const name of GUIDE_TOOLS) expect(text, name).toMatch(new RegExp(`\\b${name}\\b`, 'u'));
    expect(unofferedTools(GUIDE_TOOLS)).toBeNull();
  });

  it('take no arguments', async () => {
    expect(await refusal(target, 'list_workspaces', { workspace: WORKSPACE.id })).toBe(
      'invalid arguments: list_workspaces takes none',
    );
    expect(await refusal(target, 'get_task_guide', { x: 1 })).toBe('invalid arguments: get_task_guide takes none');
  });
});

describe('the workspace and scope of a call', () => {
  it("acts in the sender's only workspace when the call names none, and refuses another one", async () => {
    const named = await callTool<{ projects: unknown[] }>(target, 'list_projects', { workspace: WORKSPACE.id });
    expect(await callTool(target, 'list_projects', {})).toEqual(named);
    expect(named.value?.projects).toContainEqual(expect.objectContaining({ projectId: project.id }));
    expect(await refusal(target, 'list_projects', { workspace: 'elsewhere' })).toBe(
      'refused: workspace elsewhere is not one of yours; list_workspaces lists yours.',
    );
  });

  it('refuses a call that names no workspace from a sender who reaches several, listing them', async () => {
    const other = Object.freeze({ id: 'workspace-two', name: 'Second workspace' });
    const reach = (workspace: typeof WORKSPACE) => ({
      workspace,
      role: null,
      scopes: READER.scopes,
      projects: 'all' as const,
    });
    let ran = 0;
    const server = taskServer([reach(WORKSPACE), reach(other)], async () => {
      ran += 1;
      return { ok: true, value: {} };
    });
    const refused = await server.call('list_projects', {}).then(
      () => null,
      (error: unknown) => (error as Error).message,
    );
    expect(refused).toMatch(/^invalid arguments: workspace /u);
    for (const workspace of [WORKSPACE, other]) expect(refused).toContain(`${workspace.id} (${workspace.name})`);
    expect(refused).toMatch(/\nNothing was written; retrying is safe\.$/u);
    expect(ran).toBe(0);
    await server.call('list_projects', { workspace: other.id });
    expect(ran).toBe(1);
  });

  it('refuses a sender without the read scope, naming what they hold', async () => {
    expect(await refusal(api({ principal: NOBODY }), 'list_projects', { workspace: WORKSPACE.id })).toBe(
      `refused: this call needs tasks:read in workspace ${WORKSPACE.id} (${WORKSPACE.name}), where you have no access; list_workspaces shows what you may do in each.`,
    );
  });

  it('answers 401 from the sign-in when nobody is signed in', async () => {
    const response = await worker(null).fetch(new Request(`${ORIGIN}/api/mcp`, { method: 'POST', body: '{}' }), env);
    expect(response.status).toBe(401);
  });
});

describe('list_projects', () => {
  it('lists each project with its id, key, name, prefix, whether it deploys and is disabled, and its website', async () => {
    const { projects } = await read<{ projects: Record<string, unknown>[] }>(target, 'list_projects');
    expect(projects).toContainEqual({
      projectId: project.id,
      key: project.key,
      name: project.name,
      prefix: project.prefix,
      deploys: false,
      disabled: false,
      websiteUrl: null,
    });
  });
});

interface Listed {
  project?: string;
  total: number;
  nextOffset: number | null;
  tasks: { id: string; project?: string; projectId?: string; projectName?: string; [field: string]: unknown }[];
}

describe('list_tasks', () => {
  const listed = async (args: Record<string, unknown>) =>
    read<Listed>(target, 'list_tasks', { project: project.id, ...args });
  const idsOf = (list: Listed) => list.tasks.map((task) => task.id);

  it('lists most urgent first, open tasks and those closed this week, as summaries', async () => {
    const list = await listed({});
    expect(list.project).toBe(project.key);
    expect(idsOf(list)).toEqual([ids.blocker, ids.epic, ids.child, ids.blocked, ids.closed, ids.bug]);
    const child = list.tasks.find((task) => task.id === ids.child)!;
    expect(child).toMatchObject({
      title: 'Write the guide chapter',
      status: 'open',
      type: 'task',
      parent: ids.epic,
      labels: ['docs'],
      ready: true,
    });
    // A summary leaves out empty fields; get_task reads the rest.
    expect(child).not.toHaveProperty('assignee');
    expect(child).not.toHaveProperty('description');
  });

  it('names a held task stalled once its holder has done nothing on it for a day, or ever, and lists only those with stalled', async () => {
    const later = clock('2026-11-06T12:00:00.000Z');
    const own = api({ now: later.now });
    const where = await newProject(own.engine);
    const make = async (title: string) => (await own.engine.createTask(where.id, { title }, OWNER)).task;
    const quiet = await make('Rebuild the home page');
    const busy = await make('Rebuild the pricing page');
    const handed = await make('Rebuild the about page');
    for (const task of [quiet, busy])
      await own.engine.writeTask(
        where.id,
        task.id,
        { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress' } },
        AGENT,
      );
    // Given to an agent that never wrote to it: its holder has recorded nothing.
    await own.engine.writeTask(
      where.id,
      handed.id,
      { expectedVersion: 1, set: { assignee: 'agent:gone', status: 'in_progress' } },
      OWNER,
    );
    const stalled = async (id: string) =>
      (await read<{ task: { stalled: boolean } }>(own, 'get_task', { project: where.id, task: id })).task.stalled;
    const list = async (args: Record<string, unknown>) =>
      (await read<Listed>(own, 'list_tasks', { project: where.id, ...args })).tasks;

    later.advance(23 * 60);
    expect([await stalled(quiet.id), await stalled(busy.id), await stalled(handed.id)]).toEqual([false, false, true]);
    await own.engine.addComment(where.id, busy.id, 'Still at it.', AGENT);
    later.advance(2 * 60);

    expect([await stalled(quiet.id), await stalled(busy.id), await stalled(handed.id)]).toEqual([true, false, true]);
    // Stalled is shown only: a day of quiet leaves the claim as it was.
    expect(await own.engine.getTask(where.id, quiet.id)).toMatchObject({ status: 'in_progress', assignee: AGENT.name });
    expect((await list({ stalled: true })).map((task) => task.id).sort()).toEqual([quiet.id, handed.id].sort());
    const rows = await list({});
    expect(rows.find((row) => row.id === quiet.id)).toMatchObject({ stalled: true });
    expect(rows.find((row) => row.id === busy.id)).not.toHaveProperty('stalled');
    // A task nobody holds is never stalled, however long it waits.
    expect(await stalled((await make('Write the launch post')).id)).toBe(false);
  });

  it('groups tasks in progress as active within the hour, quiet until a day and stalled after, and lists the groups asked for', async () => {
    const later = clock('2026-11-06T12:00:00.000Z');
    const own = api({ now: later.now });
    const where = await newProject(own.engine);
    const make = async (title: string) => (await own.engine.createTask(where.id, { title }, OWNER)).task.id;
    const hold = (id: string, status: 'in_progress' | 'blocked' = 'in_progress') =>
      own.engine.writeTask(where.id, id, { expectedVersion: 1, set: { assignee: AGENT.name, status } }, AGENT);
    const dayAgo = await make('Rebuild the home page');
    const hourAgo = await make('Rebuild the pricing page');
    const recent = await make('Rebuild the about page');
    const handed = await make('Rebuild the blog index');
    const blocked = await make('Rebuild the contact page');
    const waiting = await make('Write the launch post');
    const done = await make('Fix the footer links');
    await hold(dayAgo);
    later.advance(23 * 60);
    await hold(hourAgo);
    later.advance(1);
    await hold(recent);
    await hold(blocked, 'blocked');
    await own.engine.writeTask(
      where.id,
      done,
      { expectedVersion: 1, close: { reason: 'Fixed.', resolution: 'done' } },
      AGENT,
    );
    // Given to an agent that never wrote to it: its holder has recorded nothing.
    await own.engine.writeTask(
      where.id,
      handed,
      { expectedVersion: 1, set: { assignee: 'agent:gone', status: 'in_progress' } },
      OWNER,
    );
    // A day after the first claim: the second was an hour ago to the minute, the third 59 minutes ago.
    later.advance(59);
    const list = (args: Record<string, unknown>) =>
      read<Listed & { activities?: Record<string, number> }>(own, 'list_tasks', { project: where.id, ...args });
    const activityOf = (answer: Listed) =>
      Object.fromEntries(answer.tasks.map((task) => [task.id, task.activity ?? null]));

    const everything = await list({});
    expect(activityOf(everything)).toEqual({
      [recent]: 'active',
      [hourAgo]: 'quiet',
      [dayAgo]: 'stalled',
      [handed]: 'stalled',
      // Not in progress: in no group, however recent its holder's last change.
      [blocked]: null,
      [waiting]: null,
      [done]: null,
    });
    expect(everything).not.toHaveProperty('activities');
    const task = async (id: string) =>
      (await read<{ task: { activity: string | null } }>(own, 'get_task', { project: where.id, task: id })).task;
    expect([(await task(recent)).activity, (await task(blocked)).activity]).toEqual(['active', null]);

    const counts = { active: 1, quiet: 1, stalled: 2 };
    const watch = await list({ activity: ['quiet', 'stalled'] });
    expect(watch.tasks.map((row) => row.id).sort()).toEqual([hourAgo, dayAgo, handed].sort());
    expect(watch).toMatchObject({ total: 3, activities: counts });
    expect(await list({ activity: ['active'] })).toMatchObject({
      total: 1,
      tasks: [{ id: recent }],
      activities: counts,
    });
    expect((await list({ status: ['in_progress', 'blocked'] })).activities).toEqual(counts);
    // Across every project, the same groups narrow the read.
    const anywhere = await read<Listed>(own, 'list_tasks', { activity: ['stalled'] });
    expect(
      anywhere.tasks
        .filter((row) => row.projectId === where.id)
        .map((row) => row.id)
        .sort(),
    ).toEqual([dayAgo, handed].sort());
    expect(anywhere).toHaveProperty('activities.stalled');

    for (const activity of [[], ['busy'], ['quiet', 'quiet'], 'quiet'])
      expect(await refusal(own, 'list_tasks', { project: where.id, activity })).toBe(
        'invalid arguments: activity (one or more of active, quiet, stalled, each once)',
      );
    expect(await refusal(own, 'list_tasks', { project: where.id, activity: ['quiet'], status: ['open'] })).toBe(
      'invalid arguments: status (an activity is a task in progress: include in_progress, or leave status out)',
    );
    expect(await refusal(own, 'list_tasks', { project: where.id, activity: ['quiet'], stage: 'merged' })).toBe(
      "invalid arguments: activity (a stage is a closed task's and an activity one in progress: name one)",
    );

    // The web app's board reads the same groups over HTTP.
    const board = async (query: string) => get(own, `/api/tasks?project=${where.id}${query}`);
    const watched = await board('&activity=quiet,stalled');
    expect(
      Object.fromEntries(
        (watched.body.tasks as { id: string; activity: string }[]).map((row) => [row.id, row.activity]),
      ),
    ).toEqual({ [hourAgo]: 'quiet', [dayAgo]: 'stalled', [handed]: 'stalled' });
    expect(watched.body.activities).toEqual(counts);
    expect((await board('&status=in_progress')).body.activities).toEqual(counts);
    expect((await board('')).body).not.toHaveProperty('activities');
    for (const query of [
      '&activity=busy',
      '&activity=quiet,quiet',
      '&activity=quiet&status=open',
      '&activity=quiet&stage=merged',
    ])
      expect((await board(query)).status, query).toBe(400);
  });

  it('narrows by readiness, status, assignee, labels, type, parent and words', async () => {
    expect(idsOf(await listed({ ready: true }))).toEqual([ids.blocker, ids.epic, ids.child]);
    expect(idsOf(await listed({ status: ['closed'] }))).toEqual([ids.closed]);
    expect(idsOf(await listed({ assignee: 'me' }))).toEqual([ids.bug]);
    expect(idsOf(await listed({ labels: ['docs', 'human'] }))).toEqual([ids.blocker]);
    expect(idsOf(await listed({ type: ['bug'] }))).toEqual([ids.bug]);
    expect(idsOf(await listed({ parent: ids.epic }))).toEqual([ids.child]);
    expect(idsOf(await listed({ query: 'GUIDE publish' }))).toEqual([ids.blocked]);
    expect(
      idsOf(await listed({ created_after: '2026-11-06T12:03:00Z', created_before: '2026-11-06T12:04:00Z' })),
    ).toEqual([ids.blocked]);
    expect(idsOf(await listed({ created_after: '2028-02-29' }))).toEqual([]);
  });

  it('gives each ready task when it last changed, and its estimate when it has one', async () => {
    const sized = await newProject(engine);
    const estimated = (await engine.createTask(sized.id, { title: 'Sized work', estimateMinutes: 90 }, AGENT)).task;
    const unsized = (await engine.createTask(sized.id, { title: 'Unsized work' }, AGENT)).task;
    const list = await read<Listed>(target, 'list_tasks', { project: sized.id, ready: true });
    expect(list.tasks.find((task) => task.id === estimated.id)).toMatchObject({
      estimateMinutes: 90,
      updatedAt: estimated.updatedAt,
    });
    const row = list.tasks.find((task) => task.id === unsized.id)!;
    expect(row).toMatchObject({ updatedAt: unsized.updatedAt });
    expect(row).not.toHaveProperty('estimateMinutes');
  });

  it('takes as many labels and words as its arguments allow', async () => {
    const labels = Array.from({ length: 200 }, (_, index) => `label-${index}`);
    expect(idsOf(await listed({ labels }))).toEqual([]);
    const oneWord = idsOf(await listed({ query: 'g' }));
    expect(oneWord.length).toBeGreaterThan(0);
    expect(idsOf(await listed({ query: Array.from({ length: 200 }, () => 'g').join(' ') }))).toEqual(oneWord);
  });

  it('pages with limit and offset', async () => {
    const first = await listed({ limit: 2 });
    expect([first.total, first.nextOffset, idsOf(first)]).toEqual([6, 2, [ids.blocker, ids.epic]]);
    const last = await listed({ limit: 4, offset: 4 });
    expect([last.nextOffset, idsOf(last)]).toEqual([null, [ids.closed, ids.bug]]);
  });

  it('sorts by title, dates or priority, either way, with ties most urgent first, before it cuts a page', async () => {
    expect(idsOf(await listed({ sort: 'title' }))).toEqual([
      ids.blocker,
      ids.closed,
      ids.bug,
      ids.epic,
      ids.blocked,
      ids.child,
    ]);
    // Dates read newest first unless asked otherwise.
    expect(idsOf(await listed({ sort: 'created' }))).toEqual([
      ids.closed,
      ids.bug,
      ids.blocked,
      ids.blocker,
      ids.child,
      ids.epic,
    ]);
    expect(idsOf(await listed({ sort: 'created', direction: 'asc' }))[0]).toBe(ids.epic);
    // Only one is closed; the open ones follow most urgent first.
    expect(idsOf(await listed({ sort: 'closed' }))).toEqual([
      ids.closed,
      ids.blocker,
      ids.epic,
      ids.child,
      ids.blocked,
      ids.bug,
    ]);
    // A direction alone reads priority that way; a tie keeps the oldest first.
    expect(idsOf(await listed({ direction: 'desc' }))).toEqual([
      ids.bug,
      ids.blocked,
      ids.closed,
      ids.epic,
      ids.child,
      ids.blocker,
    ]);
    const page = await listed({ sort: 'created', limit: 2, offset: 2 });
    expect([page.total, page.nextOffset, idsOf(page)]).toEqual([6, 4, [ids.blocked, ids.blocker]]);
    expect(await refusal(target, 'list_tasks', { project: project.id, sort: 'size' })).toBe(
      'invalid arguments: sort (one of priority, created, updated, closed, title)',
    );
  });

  it('reads every project when it names none, each task naming its project', async () => {
    const list = await read<Listed>(target, 'list_tasks', { query: 'guide', limit: 200 });
    const elsewhere = list.tasks.find((task) => task.id === ids.elsewhere);
    expect(elsewhere).toMatchObject({ project: other.key, projectId: other.id, projectName: other.name });
    expect(list.tasks.filter((task) => task.projectId === project.id)).toHaveLength(6);
  });

  it('reaches further back with closed_days', async () => {
    time.advance(8 * 24 * 60);
    try {
      expect(idsOf(await listed({ status: ['closed'] }))).toEqual([]);
      expect(idsOf(await listed({ status: ['closed'], closed_days: 9 }))).toEqual([ids.closed]);
    } finally {
      time.advance(-8 * 24 * 60);
    }
  });

  it('refuses arguments it does not take, in the words NoticeOS used', async () => {
    const refused = (args: Record<string, unknown>) =>
      refusal(target, 'list_tasks', { workspace: WORKSPACE.id, ...args });
    expect(await refused({ colour: 'red' })).toBe('invalid arguments: unknown argument colour');
    expect(await refused({ status: ['done'] })).toBe('invalid arguments: status');
    expect(await refused({ limit: 500 })).toBe('invalid arguments: limit (1–200)');
    expect(await refused({ closed_days: 57 })).toBe('invalid arguments: closed_days (1–56)');
    expect(await refused({ created_after: 'yesterday' })).toBe(
      'invalid arguments: created_after (YYYY-MM-DD or an ISO time)',
    );
    // A day the month does not have is refused, not read as a day of the next month.
    for (const [name, value] of [
      ['created_after', '2026-02-31'],
      ['updated_before', '2026-02-30T10:00:00Z'],
      ['created_before', '2027-02-29T23:00+02:00'],
    ]) {
      expect(await refused({ [name!]: value }), value).toBe(`invalid arguments: ${name} (YYYY-MM-DD or an ISO time)`);
    }
    expect(await refused({ project: '' })).toBe(
      'invalid arguments: project (a projectId, key or prefix from list_projects)',
    );
    expect(await refused({ project: 'missing' })).toBe(
      "refused: project missing names no project in this workspace; list_projects lists each one's projectId, key and prefix.",
    );
  });
});

describe('get_task', () => {
  it('reads one task in full, with its comments and the proposal an answer is checked against', async () => {
    const answer = await read<{
      project: string;
      task: Record<string, unknown>;
      comments: Record<string, unknown>[];
      proposal: string;
    }>(target, 'get_task', {
      project: project.id,
      task: ids.child,
    });
    expect(answer.project).toBe(project.key);
    expect(answer.task).toMatchObject({
      id: ids.child,
      parent: ids.epic,
      description: '',
      commentCount: 1,
      awaitingHuman: false,
      metadata: {},
    });
    expect(answer.comments).toEqual([
      {
        id: expect.any(String),
        author: OWNER.name,
        text: 'Half written.',
        createdAt: expect.any(String),
        pinned: false,
      },
    ]);
    expect(JSON.parse(answer.proposal)[0]).toBe(ids.child);
  });

  it("lists an epic's open children with who holds each, for which helper, and their last activity", async () => {
    const own = await newProject(engine);
    const epic = (await engine.createTask(own.id, { title: 'Rebuild the pages', type: 'epic' }, OWNER)).task;
    const child = async (title: string) => (await engine.createTask(own.id, { title, parentId: epic.id }, OWNER)).task;
    const held = await child('Rebuild the home page');
    const waiting = await child('Rebuild the pricing page');
    const done = await child('Rebuild the about page');
    time.advance(3);
    const claimedAt = time.now();
    await engine.writeTask(
      own.id,
      held.id,
      { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress', assigneeFor: 'page-rebuild-2' } },
      AGENT,
    );
    await engine.writeTask(
      own.id,
      done.id,
      { expectedVersion: 1, close: { reason: 'Merged.', resolution: 'done' } },
      OWNER,
    );

    const answer = await read<{ openChildren: unknown[] }>(target, 'get_task', { project: own.id, task: epic.id });
    expect(answer.openChildren).toEqual([
      {
        id: held.id,
        title: held.title,
        status: 'in_progress',
        assignee: AGENT.name,
        for: 'page-rebuild-2',
        lastActivityAt: claimedAt,
      },
      { id: waiting.id, title: waiting.title, status: 'open', assignee: null, for: null, lastActivityAt: null },
    ]);
    expect(await read(target, 'get_task', { project: own.id, task: held.id })).not.toHaveProperty('openChildren');
  });

  it("shows a task its epic's pinned comments and what its closed siblings left, newest first and capped", async () => {
    const own = await newProject(engine);
    const epic = (await engine.createTask(own.id, { title: 'Rebuild the pages', type: 'epic' }, OWNER)).task;
    const child = async (title: string) => (await engine.createTask(own.id, { title, parentId: epic.id }, OWNER)).task;
    const reading = await child('Rebuild the home page');
    await engine.addComment(own.id, epic.id, 'An ordinary comment, not pinned.', OWNER);
    const pinned: string[] = [];
    for (let fact = 1; fact <= PARENT_CONTEXT_LIMITS.pinned + 2; fact += 1) {
      time.advance(1);
      pinned.push(
        (await engine.addComment(own.id, epic.id, `Fact ${fact}.`, AGENT, undefined, { pin: true })).comment.id,
      );
    }
    time.advance(1);
    // The newest fact corrects fact 1, which it unpins: fact 1 stays among the epic's comments only.
    const correction = (
      await engine.addComment(own.id, epic.id, 'Fact 1 was wrong.', AGENT, undefined, {
        pin: true,
        unpin: [pinned[0]!],
      })
    ).comment;
    const closes = [
      { reason: 'Merged.', resolution: 'done', commit: 'a1b2c3d4' },
      { reason: 'Merged too.', resolution: 'done', pullRequest: 'https://example.com/pull/3' },
      { reason: 'Shown in the notes.', resolution: 'done', link: 'https://example.com/notes' },
      { reason: 'Nobody needs it.', resolution: 'wont-do' },
    ] as const;
    const closed = [];
    for (let index = 0; index < PARENT_CONTEXT_LIMITS.closedSiblings + 2; index += 1) {
      const sibling = await child(`Rebuild page ${index + 1}`);
      time.advance(1);
      await engine.writeTask(own.id, sibling.id, { expectedVersion: 1, close: closes[index % closes.length]! }, OWNER);
      closed.push({ ...sibling, close: closes[index % closes.length]!, closedAt: time.now() });
    }
    await child('Rebuild the pricing page');

    const answer = await read<{ parent: Record<string, unknown> }>(target, 'get_task', { task: reading.id });
    const newestFacts = [correction.id, ...pinned.slice(1).reverse()].slice(0, PARENT_CONTEXT_LIMITS.pinned);
    expect(answer.parent).toEqual({
      id: epic.id,
      title: epic.title,
      type: 'epic',
      status: 'open',
      pinned: newestFacts.map((id) => ({
        id,
        author: AGENT.name,
        text: id === correction.id ? 'Fact 1 was wrong.' : expect.stringMatching(/^Fact \d+\.$/u),
        createdAt: expect.any(String),
      })),
      pinnedTotal: PARENT_CONTEXT_LIMITS.pinned + 2,
      closedSiblings: closed
        .toReversed()
        .slice(0, PARENT_CONTEXT_LIMITS.closedSiblings)
        .map((sibling) => ({
          id: sibling.id,
          title: sibling.title,
          resolution: sibling.close.resolution,
          closedAt: sibling.closedAt,
          closedBy: OWNER.name,
          closeReason: sibling.close.reason,
          commit: 'commit' in sibling.close ? sibling.close.commit : null,
          pullRequest: 'pullRequest' in sibling.close ? sibling.close.pullRequest : null,
          closeLink: 'link' in sibling.close ? sibling.close.link : null,
        })),
      closedSiblingsTotal: PARENT_CONTEXT_LIMITS.closedSiblings + 2,
    });
    // On the epic itself, every comment shows, each saying whether it is pinned.
    const onEpic = await read<{ comments: { id: string; pinned: boolean }[] }>(target, 'get_task', { task: epic.id });
    expect(onEpic.comments.filter((comment) => comment.pinned).map((comment) => comment.id)).toEqual([
      ...pinned.slice(1),
      correction.id,
    ]);
    expect(onEpic.comments.find((comment) => comment.id === pinned[0])).toMatchObject({ pinned: false });
    // A read of several tasks leaves each one's parent out; a task with no parent has none.
    const many = await read<{ tasks: Record<string, unknown>[] }>(target, 'get_task', {
      tasks: [reading.id, closed[0]!.id],
    });
    for (const one of many.tasks) expect(one).not.toHaveProperty('parent');
    expect(onEpic).not.toHaveProperty('parent');
  });

  it('marks a ready task labelled human as waiting on a person', async () => {
    const answer = await read<{ task: Record<string, unknown> }>(target, 'get_task', {
      project: project.id,
      task: ids.blocker,
    });
    expect(answer.task.awaitingHuman).toBe(true);
  });

  it('names the project that holds a task from another one', async () => {
    expect(
      await refusal(target, 'get_task', { workspace: WORKSPACE.id, project: project.id, task: ids.elsewhere }),
    ).toBe(
      `refused: ${ids.elsewhere} is not in projectId ${project.id} (${project.name}), whose tasks start ${project.prefix}-; ` +
        `tasks with prefix ${other.prefix} are in projectId ${other.id} (${other.name}).`,
    );
    expect(
      await refusal(target, 'get_task', {
        workspace: WORKSPACE.id,
        project: project.id,
        task: `${project.prefix}-none`,
      }),
    ).toBe(
      `refused: ${project.prefix}-none is not a task in projectId ${project.id} (${project.name}); list_tasks lists its tasks.`,
    );
    expect(await refusal(target, 'get_task', { workspace: WORKSPACE.id, project: project.id, task: 'Not An Id' })).toBe(
      'invalid arguments: task (a task id such as abc-1x2)',
    );
  });

  it('reads several tasks in one call, answering a missing one alone', async () => {
    const missing = `${project.prefix}-none`;
    const answer = await read<{ tasks: Record<string, unknown>[] }>(target, 'get_task', {
      tasks: [ids.child, missing, ids.epic],
    });
    expect(answer.tasks).toEqual([
      expect.objectContaining({ project: project.key, task: expect.objectContaining({ id: ids.child }) }),
      { id: missing, error: expect.stringMatching(/^refused: /u) },
      expect.objectContaining({ task: expect.objectContaining({ id: ids.epic }), openChildren: expect.any(Array) }),
    ]);
    expect(await refusal(target, 'get_task', { workspace: WORKSPACE.id, task: ids.child, tasks: [ids.epic] })).toMatch(
      /^invalid arguments: task and tasks /u,
    );
  });

  it('answers each task of a batch on its own when one read fails', async () => {
    const failing = api({
      engine,
      now: time.now,
      wrap: (inner) => ({
        ...inner,
        getTask: async (projectId, taskId) =>
          taskId === ids.epic ? Promise.reject(new Error('storage fault')) : inner.getTask(projectId, taskId),
      }),
    });
    const answer = await read<{ tasks: Record<string, unknown>[] }>(failing, 'get_task', {
      tasks: [ids.child, ids.epic, ids.bug],
    });
    expect(answer.tasks).toEqual([
      expect.objectContaining({ task: expect.objectContaining({ id: ids.child }) }),
      { id: ids.epic, error: expect.stringMatching(/^unavailable: /u) },
      expect.objectContaining({ task: expect.objectContaining({ id: ids.bug }) }),
    ]);
  });

  it('reads a task by its id alone, or in a project named by its key or prefix', async () => {
    for (const named of [{}, { project: project.key }, { project: project.prefix }]) {
      const answer = await read<{ project: string; task: { id: string } }>(target, 'get_task', {
        task: ids.child,
        ...named,
      });
      expect(answer, JSON.stringify(named)).toMatchObject({ project: project.key, task: { id: ids.child } });
    }
  });

  it('names the argument a misnamed one most likely means', async () => {
    const refused = (args: Record<string, unknown>) =>
      refusal(target, 'get_task', { workspace: WORKSPACE.id, ...args });
    expect(await refused({ id: ids.child })).toBe('invalid arguments: unknown argument id; this tool takes task');
    expect(await refused({ task: ids.child, projectId: project.id })).toBe(
      'invalid arguments: unknown argument projectId; this tool takes project',
    );
    expect(await refusal(target, 'get_task', { workspace_id: WORKSPACE.id, task: ids.child })).toBe(
      'invalid arguments: unknown argument workspace_id; this tool takes workspace',
    );
  });
});

describe('get_task_history', () => {
  interface Change {
    revision: string;
    actor: string;
    actions?: string[];
    fields?: Record<string, { old: unknown; new: unknown }>;
    task?: Record<string, unknown>;
  }

  it('lists changes newest first, with each field old and new', async () => {
    const { changes } = await read<{ changes: Change[] }>(target, 'get_task_history', {
      project: project.id,
      task: ids.bug,
    });
    expect(changes.map((change) => change.actions)).toEqual([['claimed'], ['created']]);
    expect(changes[0]!.fields).toMatchObject({
      assignee: { old: null, new: READER.name },
      status: { old: 'open', new: 'in_progress' },
    });
    expect(Number(changes[0]!.revision)).toBeGreaterThan(Number(changes[1]!.revision));
  });

  it('returns whole versions with snapshots, leaving comments out', async () => {
    const { changes } = await read<{ changes: Change[] }>(target, 'get_task_history', {
      project: project.id,
      task: ids.child,
      snapshots: true,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.task).toMatchObject({ id: ids.child, parent: ids.epic, labels: ['docs'], status: 'open' });
  });

  it('keeps to its limit', async () => {
    const { changes } = await read<{ changes: Change[] }>(target, 'get_task_history', {
      project: project.id,
      task: ids.bug,
      limit: 1,
    });
    expect(changes.map((change) => change.actions)).toEqual([['claimed']]);
  });
});

describe('a sender granted some projects', () => {
  it('sees only those projects, and the others as if they did not exist', async () => {
    const granted = api({ principal: grantedOnly(project.id), now: time.now });

    const { projects } = await read<{ projects: { projectId: string }[] }>(granted, 'list_projects');
    expect(projects.map((entry) => entry.projectId)).toEqual([project.id]);
    const every = await read<Listed>(granted, 'list_tasks', { query: 'guide', limit: 200 });
    expect(every.tasks.map((task) => task.projectId)).not.toContain(other.id);
    expect(every.tasks.map((task) => task.id)).toContain(ids.child);
    expect(every.total).toBe(every.tasks.length);

    const missing = `refused: project ${other.id} names no project in this workspace; list_projects lists each one's projectId, key and prefix.`;
    expect(await refusal(granted, 'list_tasks', { workspace: WORKSPACE.id, project: other.id })).toBe(missing);
    expect(await refusal(granted, 'list_tasks', { workspace: WORKSPACE.id, project: other.prefix })).toBe(
      missing.replace(other.id, other.prefix),
    );
    expect(
      await refusal(granted, 'get_task', { workspace: WORKSPACE.id, project: other.id, task: ids.elsewhere }),
    ).toBe(missing);
    expect(
      await refusal(granted, 'get_task_history', { workspace: WORKSPACE.id, project: other.id, task: ids.elsewhere }),
    ).toBe(missing);
    // Named by its id alone, the task's prefix names a project the sender cannot reach: one that does not exist.
    const unreached = await refusal(granted, 'get_task', { workspace: WORKSPACE.id, task: ids.elsewhere });
    const nowhere = await refusal(granted, 'get_task', { workspace: WORKSPACE.id, task: 'nowhere-a1' });
    expect(unreached.replace(ids.elsewhere!, 'nowhere-a1').replace(other.prefix, 'nowhere')).toBe(nowhere);
    // A task from a project the sender cannot reach is not traced to that project.
    expect(
      await refusal(granted, 'get_task', { workspace: WORKSPACE.id, project: project.id, task: ids.elsewhere }),
    ).toBe(
      `refused: ${ids.elsewhere} is not a task in projectId ${project.id} (${project.name}); list_tasks lists its tasks.`,
    );
  });
});

describe('the instructions an agent reads when it connects', () => {
  const connect = async (sender: TestApi): Promise<string> => {
    const response = await sender.fetch(
      new Request(`${ORIGIN}/api/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {} },
        }),
      }),
    );
    return ((await response.json()) as { result: { instructions: string } }).result.instructions;
  };
  const holder = (name: string): Principal => ({
    id: `principal-${name}`,
    name,
    scopes: READER.scopes,
    projects: 'all',
  });
  /** Files a task held by `name`, with its helper and work details, then moves the clock on. */
  const held = async (where: Project, name: string, title: string, work: Record<string, string> = {}) => {
    const { task } = await engine.createTask(where.id, { title }, OWNER);
    await engine.writeTask(
      where.id,
      task.id,
      {
        expectedVersion: 1,
        set: { assignee: name, status: 'in_progress', ...(Object.keys(work).length ? { work } : {}) },
      },
      { name },
    );
    time.advance(1);
    return task.id;
  };

  it('add nothing for a sender who holds no task', async () => {
    const instructions = await connect(api({ principal: holder('holds-nothing'), engine, now: time.now }));
    expect(instructions).toBe(taskInstructions(MCP_TOOLS.map((tool) => tool.name)));
  });

  it('list each task the sender holds, most recently active first, with its helper, branch and next step, before the rules', async () => {
    const own = await newProject(engine);
    const first = await held(own, 'holds-two', 'Rebuild the home page', {
      branch: 'agent/home',
      next: 'Run the tests',
    });
    const second = await held(own, 'holds-two', 'Rebuild the pricing page');
    const closed = await held(own, 'holds-two', 'Rebuild the about page');
    await engine.writeTask(
      own.id,
      closed,
      { expectedVersion: 2, close: { reason: 'Done.', resolution: 'done' } },
      { name: 'holds-two' },
    );
    const instructions = await connect(api({ principal: holder('holds-two'), engine, now: time.now }));
    const lines = instructions.split('\n').filter((line) => line.startsWith(`- ${own.prefix}-`));
    expect(lines.map((line) => line.split(' ')[1])).toEqual([second, first]);
    expect(lines[1]).toContain('agent/home');
    expect(lines[1]).toContain('Run the tests');
    expect(instructions.indexOf(first)).toBeLessThan(instructions.indexOf(TASK_QUALITY[0]!));
  });

  it('answer by the deadline with the tasks of the stores that answered, leaving out one that fails or hangs', async () => {
    const reach = (id: string) => ({
      workspace: { id, name: id },
      role: null,
      scopes: READER.scopes,
      projects: 'all' as const,
    });
    const plain = taskInstructions(MCP_TOOLS.map((tool) => tool.name));
    const run = async () => ({ ok: true as const, value: {} });
    const hangs = () => new Promise<readonly HeldTask[]>(() => {});
    const failing = taskServer([reach('w-1')], run, () => Promise.reject(new Error('store down')), 20);
    expect(await failing.connecting!()).toBe(plain);
    expect(await taskServer([reach('w-1')], run, hangs, 20).connecting!()).toBe(plain);
    const answered: HeldTask = {
      id: 'abc-1x2',
      projectId: 'p-1',
      title: 'Answered in time',
      priority: 2,
      assigneeFor: null,
      work: {},
      lastActivityAt: null,
    };
    const mixed = taskServer(
      [reach('w-1'), reach('w-2')],
      run,
      (one) => (one.workspace.id === 'w-1' ? Promise.resolve([answered]) : hangs()),
      20,
    );
    expect(await mixed.connecting!()).toContain(`- ${answered.id} ${answered.title}`);
  });

  it('list ten of twelve, then how many more and the call that lists them, within the budget', async () => {
    const own = await newProject(engine);
    const long = (word: string) => Array.from({ length: 60 }, () => word).join(' ');
    for (let index = 0; index < 12; index += 1)
      await held(own, 'holds-twelve', `${long('title')} ${index}`, { branch: long('b'), next: long('next') });
    const instructions = await connect(api({ principal: holder('holds-twelve'), engine, now: time.now }));
    const lines = instructions.split('\n');
    const tasks = lines.filter((line) => line.startsWith(`- ${own.prefix}-`));
    expect(tasks).toHaveLength(10);
    const more = lines[lines.indexOf(tasks.at(-1)!) + 1]!;
    expect(more).toMatch(/^2 more: /u);
    expect(more).toContain('list_tasks');
    expect(instructions.indexOf(more) + more.length).toBeLessThanOrEqual(INSTRUCTIONS_BUDGET);
    // Where everything about a task goes follows them, and ends within the budget too.
    const rule = instructions.indexOf(ON_THE_TASK_BRIEF);
    expect(rule).toBeGreaterThan(instructions.indexOf(more));
    expect(rule + ON_THE_TASK_BRIEF.length).toBeLessThanOrEqual(INSTRUCTIONS_BUDGET);
  });
});
