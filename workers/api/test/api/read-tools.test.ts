// The MCP read tools, as an agent calls them: their results, the workspace
// and scope every call is checked against, and the sentences a refused call
// returns. Names, arguments and result fields are NoticeOS's task tools'.
import type { Project, TaskEngine } from '@ntasks/domain';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { SCOPES } from '../../src/auth.ts';
import {
  GUIDE_TOOLS,
  TASK_QUALITY,
  TASK_START,
  TASK_WORKFLOW,
  unofferedTools,
  WHATS_CHANGED,
} from '../../src/mcp/guide.ts';
import { AGENT, clock, newProject, OWNER } from '../engine/helpers.ts';
import { api, callTool, NOBODY, ORIGIN, read, READER, refusal, worker, WORKSPACE, type TestApi } from './helpers.ts';

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
  it('lists the read tools, each but list_workspaces and get_task_guide naming its workspace', async () => {
    const response = await target.fetch(
      new Request(`${ORIGIN}/api/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    const { result } = (await response.json()) as {
      result: { tools: { name: string; inputSchema: { required: string[] }; annotations: object }[] };
    };
    expect(result.tools.map((tool) => tool.name)).toEqual([
      'list_workspaces',
      'get_task_guide',
      'list_projects',
      'list_tasks',
      'get_task',
      'get_task_history',
    ]);
    for (const tool of result.tools.slice(2)) expect(tool.inputSchema.required[0], tool.name).toBe('workspace');
    for (const tool of result.tools) expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true });
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
      principal: { id: 'p-w', name: 'agent-w', scopes: [SCOPES.write, SCOPES.read, 'other:scope'] },
    });
    const listed = (await callTool<{ workspaces: { role: string; access: string[] }[] }>(writer, 'list_workspaces'))
      .value!;
    expect(listed.workspaces[0]).toMatchObject({ role: 'operator', access: [SCOPES.read, SCOPES.write] });
  });

  it('name the tools of the guide this endpoint does not offer yet', async () => {
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
    const note = unofferedTools([
      'list_workspaces',
      'get_task_guide',
      'list_projects',
      'list_tasks',
      'get_task',
      'get_task_history',
    ]);
    expect(note).toMatch(
      /^This endpoint does not offer create_task, create_tasks, update_task, claim_task, comment_on_task, close_task, /u,
    );
    expect(result.instructions.startsWith(`${note}\n`)).toBe(true);
    const guide = (await callTool<{ guide: string }>(target, 'get_task_guide')).value!;
    expect(guide.guide).toContain(`## This endpoint\n\n${note}`);
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
  it('refuses a call that names no workspace, or another one', async () => {
    expect(await refusal(target, 'list_projects', {})).toBe(
      'invalid arguments: workspace (a workspaceId from list_workspaces)',
    );
    expect(await refusal(target, 'list_projects', { workspace: 'elsewhere' })).toBe(
      'refused: workspace elsewhere is not one of yours; list_workspaces lists yours.',
    );
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
  it('lists each project with its id, key, name and prefix', async () => {
    const { projects } = await read<{ projects: Record<string, string>[] }>(target, 'list_projects');
    expect(projects).toContainEqual({
      projectId: project.id,
      key: project.key,
      name: project.name,
      prefix: project.prefix,
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
    expect(await refused({ colour: 'red' })).toBe('invalid arguments: unknown colour');
    expect(await refused({ status: ['done'] })).toBe('invalid arguments: status');
    expect(await refused({ limit: 500 })).toBe('invalid arguments: limit (1–200)');
    expect(await refused({ closed_days: 57 })).toBe('invalid arguments: closed_days (1–56)');
    expect(await refused({ created_after: 'yesterday' })).toBe(
      'invalid arguments: created_after (YYYY-MM-DD or an ISO time)',
    );
    expect(await refused({ project: 'no such project' })).toBe(
      'invalid arguments: project (a projectId from list_projects)',
    );
    expect(await refused({ project: 'missing' })).toBe(
      'refused: projectId missing names no project in this workspace; list_projects lists the current projectIds.',
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
      { id: expect.any(String), author: OWNER.name, text: 'Half written.', createdAt: expect.any(String) },
    ]);
    expect(JSON.parse(answer.proposal)[0]).toBe(ids.child);
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
