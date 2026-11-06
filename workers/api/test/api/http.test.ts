// The HTTP reads the web app uses: their shapes, their parameters, and who
// may call them.
import type { Project, TaskEngine } from '@ntasks/domain';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { AGENT, clock, newProject, OWNER } from '../engine/helpers.ts';
import { api, get, NOBODY, ORIGIN, worker, type TestApi } from './helpers.ts';

const time = clock('2026-11-06T12:00:00.000Z');
let target: TestApi;
let engine: TaskEngine;
let project: Project;
const ids: Record<string, string> = {};

beforeAll(async () => {
  target = api({ now: time.now });
  engine = target.engine;
  project = await newProject(engine);
  ids.epic = (await engine.createTask(project.id, { title: 'Launch', type: 'epic' }, AGENT)).task.id;
  time.advance(1);
  ids.child = (
    await engine.createTask(project.id, { title: 'Write the launch post', parentId: ids.epic, labels: ['copy'] }, AGENT)
  ).task.id;
  time.advance(1);
  ids.done = (await engine.createTask(project.id, { title: 'Pick the date', parentId: ids.epic }, AGENT)).task.id;
  await engine.writeTask(
    project.id,
    ids.done,
    { expectedVersion: 1, close: { reason: 'Chosen.', resolution: 'done' } },
    OWNER,
  );
  await engine.addComment(project.id, ids.child, 'Draft ready.', OWNER);
});

describe('who may read', () => {
  it('answers the sign-in challenge when nobody is signed in', async () => {
    const response = await worker(null).fetch(new Request(`${ORIGIN}/api/tasks/projects`), env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'sign_in_required' });
  });

  it('refuses a sender without the read scope', async () => {
    expect(await get(api({ principal: NOBODY }), '/api/tasks/projects')).toEqual({
      status: 403,
      body: { error: 'insufficient_scope', detail: 'this route needs tasks:read' },
    });
  });

  it('refuses every API request in the deployed Worker until sign-in exists', async () => {
    for (const path of ['/api/tasks/projects', '/api/mcp']) {
      const response = await exports.default.fetch(`${ORIGIN}${path}`, {
        method: path === '/api/mcp' ? 'POST' : 'GET',
      });
      expect(response.status, path).toBe(401);
      expect(response.headers.get('cache-control'), path).toBe('no-store');
    }
  });

  it('answers 404 for a path it does not serve, before anyone signs in', async () => {
    for (const path of ['/api/tasks/Not-An-Id', '/api/elsewhere']) {
      const response = await worker(null).fetch(new Request(`${ORIGIN}${path}`), env);
      expect(response.status, path).toBe(404);
    }
  });

  it('serves reads only', async () => {
    const response = await target.fetch(new Request(`${ORIGIN}/api/tasks/projects`, { method: 'POST' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('GET /api/tasks/projects and /api/tasks/capabilities', () => {
  it('lists the projects as the web app reads them', async () => {
    const { body } = await get(target, '/api/tasks/projects');
    expect(body.projects).toContainEqual({
      projectId: project.id,
      logicalKey: project.key,
      displayName: project.name,
      prefix: project.prefix,
    });
  });

  it('offers no writes yet', async () => {
    expect((await get(target, '/api/tasks/capabilities')).body).toEqual({
      live: true,
      writable: false,
      projectSelection: true,
      operations: [],
      editableFields: [],
    });
  });
});

describe('GET /api/tasks', () => {
  it('reads a board: open tasks, those closed this week, and epic progress', async () => {
    const { status, body } = await get(target, `/api/tasks?project=${project.id}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      project: project.key,
      prefix: project.prefix,
      repo: '',
      closedSince: '2026-10-30',
      actors: [],
    });
    const tasks = body.tasks as Record<string, unknown>[];
    expect(tasks.map((task) => task.id)).toEqual([ids.epic, ids.child, ids.done]);
    expect(tasks[1]).toMatchObject({
      issueType: 'task',
      parent: ids.epic,
      labels: ['copy'],
      comments: 1,
      ready: true,
      closedAt: null,
    });
    expect(tasks[2]).toMatchObject({ status: 'closed', closeReason: 'Chosen.', resolution: 'done' });
    expect(body.epics).toEqual([
      { id: ids.epic, title: 'Launch', status: 'open', priority: 2, total: 2, closed: 1, eligibleForClose: false },
    ]);
  });

  it('narrows by status, and reads further back only for closed tasks alone', async () => {
    const closed = await get(target, `/api/tasks?project=${project.id}&status=closed&closedDays=30`);
    expect((closed.body.tasks as { id: string }[]).map((task) => task.id)).toEqual([ids.done]);
    expect(closed.body.epics).toBeNull();
    expect(await get(target, `/api/tasks?project=${project.id}&status=open&closedDays=30`)).toEqual({
      status: 400,
      body: { error: 'invalid_request', detail: 'closedDays is for a read of closed tasks alone: status=closed' },
    });
  });

  it('refuses a parameter it does not take, a repeated one, and a missing or unknown project', async () => {
    expect((await get(target, `/api/tasks?project=${project.id}&colour=red`)).body).toEqual({
      error: 'invalid_request',
      detail: 'unknown parameter colour; this route takes project, status, closedDays',
    });
    expect((await get(target, `/api/tasks?project=${project.id}&project=${project.id}`)).body.detail).toBe(
      'project is given twice',
    );
    expect((await get(target, '/api/tasks?status=open')).status).toBe(400);
    expect((await get(target, `/api/tasks?project=${project.id}&status=done`)).status).toBe(400);
    expect(await get(target, '/api/tasks?project=missing')).toEqual({
      status: 404,
      body: { error: 'not_found', detail: 'no project missing; /api/tasks/projects lists them' },
    });
  });
});

describe('GET /api/tasks/:id and its history', () => {
  it('reads one task with its comments and proposal', async () => {
    const { status, body } = await get(target, `/api/tasks/${ids.child}?project=${project.id}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ project: project.key, prefix: project.prefix, repo: '', actors: [] });
    expect(body.task).toMatchObject({ id: ids.child, title: 'Write the launch post' });
    expect(body.comments).toEqual([expect.objectContaining({ author: OWNER.name, text: 'Draft ready.' })]);
    expect(JSON.parse(body.proposal as string)[0]).toBe(ids.child);
  });

  it('reads its changes, newest first', async () => {
    const { body } = await get(target, `/api/tasks/${ids.done}/history?project=${project.id}&limit=1`);
    expect(body.changes).toEqual([expect.objectContaining({ actor: OWNER.name, actions: ['closed'] })]);
  });

  it('answers 404 for a task the project does not hold', async () => {
    expect(await get(target, `/api/tasks/${project.prefix}-none?project=${project.id}`)).toEqual({
      status: 404,
      body: { error: 'not_found', detail: `no task ${project.prefix}-none in project ${project.id}` },
    });
  });
});

describe('GET /api/changes', () => {
  it('returns every change after a sequence number, and where to ask next', async () => {
    const all = await get(target, `/api/changes?after=0&limit=200&project=${project.id}`);
    const events = all.body.events as { seq: number; taskId: string; kind: string }[];
    expect(events.map((event) => event.kind)).toEqual(['created', 'created', 'created', 'closed', 'commented']);
    expect(all.body.lastSeq).toBe(events.at(-1)!.seq);
    const after = await get(target, `/api/changes?after=${events[2]!.seq}&project=${project.id}`);
    expect((after.body.events as { kind: string }[]).map((event) => event.kind)).toEqual(['closed', 'commented']);
    const none = await get(target, `/api/changes?after=${all.body.lastSeq as number}&project=${project.id}`);
    expect(none.body).toEqual({ events: [], lastSeq: all.body.lastSeq });
  });

  it('keeps its limit within 1 to 200', async () => {
    expect((await get(target, '/api/changes?limit=0')).body.detail).toBe('limit must be a whole number from 1 to 200');
    expect((await get(target, '/api/changes?after=-1')).status).toBe(400);
  });
});
