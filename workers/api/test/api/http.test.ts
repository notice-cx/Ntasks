// The HTTP reads the web app uses: their shapes, their parameters, and who
// may call them.
import type { Project, TaskEngine } from '@ntasks/domain';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { AGENT, clock, newProject, OWNER } from '../engine/helpers.ts';
import { api, get, grantedOnly, NOBODY, ORIGIN, worker, type TestApi } from './helpers.ts';

const time = clock('2026-11-06T12:00:00.000Z');
let target: TestApi;
let engine: TaskEngine;
let project: Project;
let other: Project;
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
  other = await newProject(engine);
  ids.other = (await engine.createTask(other.id, { title: 'Elsewhere' }, AGENT)).task.id;
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
    const response = await target.fetch(new Request(`${ORIGIN}/api/tasks/capabilities`, { method: 'POST' }));
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
      deploys: false,
      disabled: false,
      websiteUrl: null,
      icon: null,
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
      detail:
        'unknown parameter colour; this route takes project, status, closedDays, label, limit, after, stage, activity',
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

describe('GET /api/tasks/search', () => {
  const idsOf = (body: Record<string, unknown>) => (body.tasks as { id: string }[]).map((task) => task.id);

  it('finds the tasks of every project the sender reaches that hold every word, each naming its project', async () => {
    const first = await newProject(engine);
    const second = await newProject(engine);
    const titled = (await engine.createTask(first.id, { title: 'Rotate the quokka keys' }, AGENT)).task;
    const described = (
      await engine.createTask(second.id, { title: 'Expiry', description: 'The Quokka keys expire monthly.' }, AGENT)
    ).task;
    await engine.createTask(second.id, { title: 'Rotate the quokka logs' }, AGENT);

    const { status, body } = await get(target, '/api/tasks/search?q=quokka%20KEYS');
    expect(status).toBe(200);
    expect(idsOf(body).sort()).toEqual([titled.id, described.id].sort());
    expect(body).toMatchObject({ total: 2, closedSince: '2026-10-30' });
    expect(body.tasks).toContainEqual(
      expect.objectContaining({ id: described.id, project: second.key, title: 'Expiry', status: 'open' }),
    );

    const granted = api({ principal: grantedOnly(first.id), now: time.now });
    expect(idsOf((await get(granted, '/api/tasks/search?q=quokka%20keys')).body)).toEqual([titled.id]);
  });

  it('puts first the task a task id names, closed at any time, in a project the sender reaches', async () => {
    const past = clock('2026-09-01T12:00:00.000Z');
    const old = api({ now: past.now }).engine;
    const own = await newProject(old);
    const { task } = await old.createTask(own.id, { title: 'Archived long ago' }, AGENT);
    await old.writeTask(own.id, task.id, { expectedVersion: 1, close: { reason: 'Done.', resolution: 'done' } }, OWNER);
    // An open task whose text holds the id is a match of its own, after it.
    const { task: mention } = await engine.createTask(own.id, { title: `Follow up on ${task.id}` }, AGENT);

    const { body } = await get(target, `/api/tasks/search?q=${task.id}`);
    expect(idsOf(body)).toEqual([task.id, mention.id]);
    expect(body.tasks).toContainEqual(expect.objectContaining({ id: task.id, project: own.key, status: 'closed' }));
    expect(body.total).toBe(2);

    const granted = api({ principal: grantedOnly(project.id), now: time.now });
    expect(idsOf((await get(granted, `/api/tasks/search?q=${task.id}`)).body)).toEqual([]);
  });

  it('answers at most limit tasks with the total, and refuses an empty q or a limit outside 1 to 200', async () => {
    const own = await newProject(engine);
    for (const title of ['Wombat one', 'Wombat two', 'Wombat three']) await engine.createTask(own.id, { title }, AGENT);

    const { body } = await get(target, '/api/tasks/search?q=wombat&limit=2');
    expect(idsOf(body)).toHaveLength(2);
    expect(body.total).toBe(3);
    for (const query of ['', '?q=%20%20', '?q=wombat&limit=0', '?q=wombat&limit=201', '?q=wombat&project=x'])
      expect((await get(target, `/api/tasks/search${query}`)).status, query).toBe(400);
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

describe('a sender granted some projects', () => {
  it('reads only those, and answers the others as missing', async () => {
    const granted = api({ principal: grantedOnly(project.id), now: time.now });

    const listed = await get(granted, '/api/tasks/projects');
    expect((listed.body.projects as { projectId: string }[]).map((entry) => entry.projectId)).toEqual([project.id]);
    for (const path of [
      `/api/tasks?project=${other.id}`,
      `/api/tasks/${ids.other}?project=${other.id}`,
      `/api/tasks/${ids.other}/history?project=${other.id}`,
      `/api/changes?project=${other.id}`,
    ]) {
      expect(await get(granted, path), path).toEqual({
        status: 404,
        body: { error: 'not_found', detail: `no project ${other.id}; /api/tasks/projects lists them` },
      });
    }
    expect((await get(granted, `/api/tasks?project=${project.id}`)).status).toBe(200);
  });

  it('sees only their changes, and is told where to ask next past the others', async () => {
    const everything = await get(target, '/api/changes?after=0&limit=200');
    const granted = await get(
      api({ principal: grantedOnly(project.id), now: time.now }),
      '/api/changes?after=0&limit=200',
    );

    const projectsOf = (body: Record<string, unknown>) =>
      new Set((body.events as { projectId: string }[]).map((event) => event.projectId));
    expect(projectsOf(everything.body)).toContain(other.id);
    expect([...projectsOf(granted.body)]).toEqual([project.id]);
    expect(granted.body.lastSeq).toBe(everything.body.lastSeq);
  });
});

describe('where a board starts reading changes', () => {
  it('names the latest change it reflects, after which the feed has only newer changes', async () => {
    const own = await newProject(engine);
    const { task } = await engine.createTask(own.id, { title: 'Watched' }, AGENT);
    const before = await get(target, `/api/tasks?project=${own.id}`);
    const lastSeq = before.body.lastSeq as number;
    expect(lastSeq).toBeGreaterThan(0);
    expect((await get(target, `/api/changes?after=${lastSeq}&project=${own.id}`)).body.events).toEqual([]);

    await engine.addComment(own.id, task.id, 'A note.', OWNER);

    const after = await get(target, `/api/tasks?project=${own.id}`);
    expect(after.body.lastSeq).toBeGreaterThan(lastSeq);
    const newer = await get(target, `/api/changes?after=${lastSeq}&project=${own.id}`);
    expect((newer.body.events as { kind: string }[]).map((event) => event.kind)).toEqual(['commented']);
  });
});

describe('who filed, closed or claimed a task', () => {
  it('names the filer with the model they named, and a person with none', async () => {
    const own = await newProject(engine);
    const { task: byAgent } = await engine.createTask(own.id, { title: 'Filed by an agent' }, AGENT);
    const { task: byPerson } = await engine.createTask(own.id, { title: 'Filed by a person' }, OWNER);
    const { body } = await get(target, `/api/tasks?project=${own.id}`);
    const tasks = body.tasks as Record<string, unknown>[];
    expect(tasks.find((entry) => entry.id === byAgent.id)).toMatchObject({
      filedBy: AGENT.name,
      filedModel: AGENT.model,
    });
    expect(tasks.find((entry) => entry.id === byPerson.id)).toMatchObject({ filedBy: OWNER.name, filedModel: null });
  });

  it('names the closer and the claimer with the models they named', async () => {
    const own = await newProject(engine);
    const { task: open } = await engine.createTask(own.id, { title: 'Still open' }, AGENT);
    const { task: claimed } = await engine.createTask(own.id, { title: 'Claim me' }, AGENT);
    await engine.writeTask(
      own.id,
      claimed.id,
      { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress' } },
      AGENT,
    );
    await engine.writeTask(
      own.id,
      claimed.id,
      { expectedVersion: 2, close: { reason: 'Done.', resolution: 'done' } },
      AGENT,
    );

    const { body } = await get(target, `/api/tasks?project=${own.id}`);
    const tasks = body.tasks as Record<string, unknown>[];
    expect(tasks.find((entry) => entry.id === open.id)).toMatchObject({
      closedBy: null,
      closedModel: null,
      assigneeModel: null,
    });
    expect(tasks.find((entry) => entry.id === claimed.id)).toMatchObject({
      assignee: AGENT.name,
      assigneeModel: AGENT.model,
      closedBy: AGENT.name,
      closedModel: AGENT.model,
    });
  });
});
