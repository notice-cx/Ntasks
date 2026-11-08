// Where a closed task's change is: a close with a commit or a pull request
// starts it at built, and a repository's signal moves it to merged and live,
// over MCP (close_task, report_delivery, list_tasks) and HTTP (POST
// /api/delivery, PATCH /api/tasks/projects).
import type { Project, Task, TaskDelivery, TaskEngine } from '@ntasks/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { SCOPES, type Principal } from '../../src/auth.ts';
import { clock, newProject, OWNER } from '../engine/helpers.ts';
import { api, get, granted, read, send, write, WRITER, type TestApi } from './helpers.ts';

const time = clock('2026-11-07T12:00:00.000Z');
const OWNER_SENDER: Principal = Object.freeze({
  id: 'principal-owner',
  name: 'owner',
  scopes: [SCOPES.read, SCOPES.write, SCOPES.manage],
  projects: 'all',
});

let target: TestApi;
let engine: TaskEngine;

beforeAll(() => {
  target = api({ principal: WRITER, now: time.now });
  engine = target.engine;
});

const key = () => `key-${crypto.randomUUID()}`;

async function closedWith(project: Project, shipped: Record<string, string>): Promise<string> {
  const { task } = await engine.createTask(project.id, { title: 'Ship it' }, OWNER);
  await write(target, 'close_task', {
    project: project.id,
    task: task.id,
    reason: 'Shipped.',
    ...shipped,
    idempotency_key: key(),
  });
  return task.id;
}

async function deliveryOf(project: Project, id: string): Promise<TaskDelivery | undefined> {
  const { task } = await read<{ task: { delivery?: TaskDelivery } }>(target, 'get_task', {
    project: project.id,
    task: id,
  });
  return task.delivery;
}

async function signal(sender: TestApi, body: Record<string, unknown>) {
  return send(sender, 'POST', '/api/delivery', body);
}

async function deployingProject(): Promise<Project> {
  const project = await newProject(engine);
  return engine.setProjectDeploys(project.id, true);
}

describe('a closed task’s delivery', () => {
  it('goes from built to merged with its merge commit, then live, and a repeated signal moves nothing', async () => {
    const project = await deployingProject();
    const id = await closedWith(project, {
      commit: 'ABC1234DEF',
      pr: 'https://github.com/Example/App/pull/12/files#diff',
    });
    expect(await deliveryOf(project, id)).toEqual({
      stage: 'built',
      commit: 'abc1234def',
      pullRequest: 'https://github.com/example/app/pull/12',
      mergeCommit: null,
      builtAt: time.now(),
      mergedAt: null,
      liveAt: null,
    });

    time.advance(5);
    const merge = 'feedbeef0123456789abcdef0123456789abcdef';
    const merged = { repository: 'example/app', stage: 'merged', pullRequests: ['12'], commits: [merge] };
    expect(await signal(target, merged)).toEqual({ status: 200, body: { moved: [{ id, stage: 'merged' }] } });
    expect(await deliveryOf(project, id)).toMatchObject({ stage: 'merged', mergeCommit: merge, mergedAt: time.now() });
    const version = (await engine.getTask(project.id, id))!.version;
    expect(await signal(target, merged)).toEqual({ status: 200, body: { moved: [] } });
    expect((await engine.getTask(project.id, id))!.version).toBe(version);

    time.advance(5);
    // A deploy names the merge commit, here by a prefix of it.
    const live = await write(target, 'report_delivery', {
      repository: 'example/app',
      stage: 'live',
      commits: [merge.slice(0, 9)],
    });
    expect(live).toEqual({ moved: [{ id, stage: 'live' }] });
    expect(await deliveryOf(project, id)).toMatchObject({ stage: 'live', liveAt: time.now(), mergeCommit: merge });
    // A merge signal after it goes live never moves it back.
    expect(await signal(target, merged)).toEqual({ status: 200, body: { moved: [] } });
    expect((await deliveryOf(project, id))?.stage).toBe('live');

    const { changes } = await read<{ changes: { fields: { delivery?: { new: { stage: string } } } }[] }>(
      target,
      'get_task_history',
      { project: project.id, task: id },
    );
    expect(changes.flatMap((change) => change.fields.delivery?.new.stage ?? [])).toEqual(['live', 'merged', 'built']);
  });

  it('matches a commit the task closed with when the signal names a longer one', async () => {
    const project = await deployingProject();
    const id = await closedWith(project, { commit: '0badc0de' });
    const reply = await signal(target, {
      repository: 'example/app',
      stage: 'live',
      commits: ['0badc0de99887766554433221100ffeeddccbbaa'],
    });
    expect(reply.body).toEqual({ moved: [{ id, stage: 'live' }] });
    // It went live with no merge reported.
    expect(await deliveryOf(project, id)).toMatchObject({ stage: 'live', mergedAt: null, mergeCommit: null });
  });

  it('starts from the commit and pull request its holder recorded when the close names none', async () => {
    const project = await newProject(engine);
    const { task } = await engine.createTask(project.id, { title: 'Ship it' }, OWNER);
    const pr = 'https://github.com/example/app/pull/9';
    await write(target, 'claim_task', {
      project: project.id,
      task: task.id,
      pr,
      commit: 'ABCDEF1',
      idempotency_key: key(),
    });
    const closed = await write(target, 'close_task', {
      project: project.id,
      task: task.id,
      reason: 'Shipped.',
      idempotency_key: key(),
    });
    // The close's answer shows where the change is.
    expect(closed).toMatchObject({ status: 'closed', delivery: { stage: 'built' } });
    expect(await deliveryOf(project, task.id)).toMatchObject({ stage: 'built', commit: 'abcdef1', pullRequest: pr });
  });

  it('stops a task of a project that does not deploy at merged', async () => {
    const project = await newProject(engine);
    const id = await closedWith(project, { pr: 'https://git.example.com/app/merge_requests/3' });
    const live = {
      repository: 'example/app',
      stage: 'live',
      pullRequests: ['https://git.example.com/app/merge_requests/3'],
    };
    expect((await signal(target, live)).body).toEqual({ moved: [{ id, stage: 'merged' }] });
    expect((await signal(target, live)).body).toEqual({ moved: [] });
    expect(await deliveryOf(project, id)).toMatchObject({ stage: 'merged', liveAt: null });
  });

  it('moves nothing in a project the sender may only read', async () => {
    const project = await newProject(engine);
    const id = await closedWith(project, { commit: '1234567' });
    const merged = { repository: 'example/app', stage: 'merged', commits: ['1234567'] };
    const reader = api({ principal: granted({ [project.id]: 'read' }), engine, now: time.now });
    expect(await signal(reader, merged)).toEqual({ status: 200, body: { moved: [] } });
    expect((await deliveryOf(project, id))?.stage).toBe('built');
    const writer = api({ principal: granted({ [project.id]: 'write' }), engine, now: time.now });
    expect((await signal(writer, merged)).body).toEqual({ moved: [{ id, stage: 'merged' }] });
  });

  it('is cleared by a reopen and kept in history, and a close without a commit or pull request has none', async () => {
    const project = await newProject(engine);
    const id = await closedWith(project, { commit: 'aaaaaaa' });
    await write(target, 'update_task', { project: project.id, task: id, status: 'open', idempotency_key: key() });
    expect(await deliveryOf(project, id)).toBeUndefined();
    const closed = await write(target, 'close_task', {
      project: project.id,
      task: id,
      reason: 'Again.',
      idempotency_key: key(),
    });
    expect(closed).not.toHaveProperty('delivery');
    expect(await deliveryOf(project, id)).toBeUndefined();
    const events = await engine.listHistory(project.id, id, { limit: 10 });
    expect(events.map((event) => event.changes.delivery).filter((delivery) => delivery !== undefined)).toEqual([
      null,
      expect.objectContaining({ stage: 'built', commit: 'aaaaaaa' }),
    ]);
  });
});

describe('list_tasks by stage', () => {
  it('counts the closed tasks at each stage as the tasks it lists', async () => {
    const project = await newProject(engine);
    const built = [await closedWith(project, { commit: 'b000001' }), await closedWith(project, { commit: 'b000002' })];
    const merged = await closedWith(project, { commit: 'c000003' });
    await closedWith(project, {});
    await engine.createTask(project.id, { title: 'Still open' }, OWNER);
    await signal(target, { repository: 'example/app', stage: 'merged', commits: ['c000003'] });

    type Listed = {
      total: number;
      stages: Record<string, number>;
      tasks: { id: string; delivery?: { stage: string } }[];
    };
    const closed = await read<Listed>(target, 'list_tasks', { project: project.id, status: ['closed'] });
    const counted = (stage: string) => closed.tasks.filter((task) => task.delivery?.stage === stage).length;
    expect(closed.stages).toEqual({ built: counted('built'), merged: counted('merged'), live: counted('live') });
    expect(closed.stages).toEqual({ built: 2, merged: 1, live: 0 });

    const waiting = await read<Listed>(target, 'list_tasks', { project: project.id, stage: 'built' });
    expect(waiting.tasks.map((task) => task.id).sort()).toEqual([...built].sort());
    expect(waiting.stages).toEqual({ built: 2, merged: 0, live: 0 });
    expect((await read<Listed>(target, 'list_tasks', { stage: 'merged' })).tasks.map((task) => task.id)).toContain(
      merged,
    );
    // The board reads the same tasks over HTTP.
    const board = await get(target, `/api/tasks?project=${project.id}&stage=built`);
    expect((board.body.tasks as Task[]).map((task) => task.id).sort()).toEqual([...built].sort());
  });
});

describe('a project’s deploy setting', () => {
  it('is set by a workspace owner and refused to anyone else', async () => {
    const project = await newProject(engine);
    const body = { projectId: project.id, deploys: true };
    expect((await send(target, 'PATCH', '/api/tasks/projects', body)).status).toBe(403);
    const owner = api({ principal: OWNER_SENDER, engine, now: time.now });
    expect(await send(owner, 'PATCH', '/api/tasks/projects', body)).toMatchObject({
      status: 200,
      body: { project: { projectId: project.id, deploys: true } },
    });
    const { projects } = (await get(target, '/api/tasks/projects')).body as { projects: Record<string, unknown>[] };
    expect(projects.find((listed) => listed.projectId === project.id)).toMatchObject({ deploys: true });
  });
});
