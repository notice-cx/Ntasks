// The HTTP writes the web app uses: filing, changing, commenting on and
// closing a task, in the shapes NoticeOS's Tasks API took, with who may make
// them, how a retry is answered and what each refusal answers.
import type { Project, Task, TaskEngine } from '@ntasks/domain';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { AGENT, clock, newProject, OWNER } from '../engine/helpers.ts';
import { api, get, granted, ORIGIN, READER, send, worker, WRITER, type TestApi } from './helpers.ts';

const time = clock('2026-11-06T12:00:00.000Z');
let target: TestApi;
let engine: TaskEngine;
let project: Project;

beforeAll(async () => {
  target = api({ principal: WRITER, now: time.now });
  engine = target.engine;
  project = await newProject(engine);
});

const key = () => `key-${crypto.randomUUID()}`;

async function task(input: Parameters<TaskEngine['createTask']>[1] = { title: 'A task' }): Promise<Task> {
  return (await engine.createTask(project.id, input, OWNER)).task;
}

async function current(id: string): Promise<Task> {
  return (await engine.getTask(project.id, id))!;
}

describe('GET /api/tasks/capabilities', () => {
  it('offers the writes to a sender who may change some project', async () => {
    const writes = {
      live: true,
      writable: true,
      projectSelection: true,
      operations: ['create', 'update', 'comment', 'close'],
      editableFields: [
        'status',
        'priority',
        'title',
        'description',
        'claim',
        'assignee',
        'parent',
        'defer',
        'acceptance',
        'notes',
        'design',
        'estimateMinutes',
        'addLabels',
        'removeLabels',
        'card',
        'changeClass',
      ],
    };
    expect((await get(target, '/api/tasks/capabilities')).body).toEqual(writes);
    expect(
      (await get(api({ principal: granted({ [project.id]: 'write' }), engine }), '/api/tasks/capabilities')).body,
    ).toEqual(writes);
    const none = { live: true, writable: false, projectSelection: true, operations: [], editableFields: [] };
    expect(
      (await get(api({ principal: granted({ [project.id]: 'read' }), engine }), '/api/tasks/capabilities')).body,
    ).toEqual(none);
    expect((await get(api({ principal: READER, engine }), '/api/tasks/capabilities')).body).toEqual(none);
  });
});

describe('routes and methods', () => {
  it('serves each write at its path and method, naming the methods a path takes', async () => {
    const { id } = await task();
    const cases: [string, string, string][] = [
      ['DELETE', `/api/tasks/${id}`, 'GET, HEAD, PATCH'],
      ['GET', `/api/tasks/${id}/close`, 'POST'],
      ['GET', `/api/tasks/${id}/comments`, 'POST'],
      ['PATCH', '/api/tasks', 'GET, HEAD, POST'],
      ['POST', `/api/tasks/${id}/history`, 'GET, HEAD'],
    ];
    for (const [method, path, allow] of cases) {
      const response = await target.fetch(new Request(`${ORIGIN}${path}`, { method }));
      expect(response.status, `${method} ${path}`).toBe(405);
      expect(response.headers.get('allow'), `${method} ${path}`).toBe(allow);
    }
  });

  it('answers the sign-in challenge on a write path, not 404, when nobody is signed in', async () => {
    for (const path of ['/api/tasks/p-a1/close', '/api/tasks/p-a1/comments']) {
      const response = await worker(null).fetch(new Request(`${ORIGIN}${path}`, { method: 'POST' }), env);
      expect(response.status, path).toBe(401);
    }
  });

  it('refuses a sender without the write scope', async () => {
    expect(
      await send(api({ principal: READER, engine }), 'POST', '/api/tasks', { projectId: project.id, title: 'T' }),
    ).toEqual({
      status: 403,
      body: { error: 'insufficient_scope', detail: 'this route needs tasks:write' },
    });
  });

  it("refuses a write from another site's page", async () => {
    const response = await send(
      target,
      'POST',
      '/api/tasks',
      { projectId: project.id, title: 'T' },
      { origin: 'https://other.test' },
    );
    expect(response).toEqual({ status: 403, body: { error: 'forbidden', detail: 'origin refused' } });
  });

  it('refuses a body that is not one JSON object, a query, and a malformed retry key', async () => {
    const invalid = (detail: string) => ({ status: 400, body: { error: 'invalid_request', detail } });
    const body = 'the body must be one JSON object of at most 32 KB, sent as application/json';
    expect(await send(target, 'POST', '/api/tasks', '{"title":"a","title":"b"}')).toEqual(invalid(body));
    expect(
      await send(target, 'POST', '/api/tasks', { projectId: project.id }, { 'content-type': 'text/plain' }),
    ).toEqual(invalid(body));
    expect(await send(target, 'POST', '/api/tasks', [1])).toEqual(invalid('the body must be one JSON object'));
    const large = { projectId: project.id, title: 'T', description: 'd'.repeat(33 * 1024) };
    expect(await send(target, 'POST', '/api/tasks', large)).toEqual(invalid(body));
    expect(
      await send(target, 'POST', `/api/tasks?project=${project.id}`, { projectId: project.id, title: 'T' }),
    ).toEqual(invalid('unknown parameter project; this route takes none'));
    expect(
      await send(target, 'POST', '/api/tasks', { projectId: project.id, title: 'T' }, { 'idempotency-key': 'short' }),
    ).toEqual(
      invalid('the idempotency-key header must be 8 to 128 letters, digits, dots, underscores, colons or hyphens'),
    );
  });
});

describe('POST /api/tasks', () => {
  it('files a task and answers its id and project, once per retry key', async () => {
    const body = {
      projectId: project.id,
      title: 'Write the about page',
      description: 'WHAT: the page.',
      type: 'feature',
      priority: 1,
      labels: ['copy'],
      acceptance: 'It is live.',
      metadata: { noticeos_panel_asset: 'example.com' },
      changeClass: 'copy',
    };
    const headers = { 'idempotency-key': key() };
    const first = await send(target, 'POST', '/api/tasks', body, headers);
    expect(first).toEqual({ status: 200, body: { id: expect.any(String), project: project.key } });
    const filed = await current(first.body.id as string);
    expect(filed).toMatchObject({
      title: 'Write the about page',
      type: 'feature',
      filedBy: WRITER.name,
      metadata: { noticeos_panel_asset: 'example.com', noticeos_change_class: 'copy' },
    });

    expect(await send(target, 'POST', '/api/tasks', body, headers)).toEqual(first);
    expect(await send(target, 'POST', '/api/tasks', { ...body, title: 'Another' }, headers)).toEqual({
      status: 409,
      body: {
        error: 'idempotency_conflict',
        detail:
          'This Idempotency-Key was first used for a different change. Send that change again unchanged, or use a new key.',
      },
    });
  });

  it('refuses fields that break their rules, a project it cannot reach and one it may only read', async () => {
    const other = await newProject(engine);
    const invalid = (detail: string) => ({ status: 400, body: { error: 'invalid_request', detail } });
    expect(await send(target, 'POST', '/api/tasks', { projectId: project.id })).toEqual(invalid('title (required)'));
    expect(await send(target, 'POST', '/api/tasks', { projectId: project.id, title: 'T', colour: 'red' })).toEqual(
      invalid('unknown colour'),
    );
    // The advice names the HTTP route that lists projects, and says only MCP asks for an approval.
    const { id } = await task();
    for (const [method, path, body] of [
      ['POST', '/api/tasks', { title: 'T' }],
      ['PATCH', `/api/tasks/${id}`, { projectId: 'not a project', title: 'T' }],
      ['POST', `/api/tasks/${id}/comments`, { text: 'Hi.' }],
      ['POST', `/api/tasks/${id}/close`, { projectId: '', reason: 'Done.' }],
    ] as const) {
      expect(await send(target, method, path, body), `${method} ${path}`).toEqual(
        invalid('projectId (a projectId from /api/tasks/projects)'),
      );
    }
    expect(await send(target, 'POST', '/api/tasks', { projectId: project.id, title: 'T', type: 'gate' })).toEqual(
      invalid(
        'type (a gate holds another task until a person approves it, and only the MCP endpoint asks for an approval: request_human_approval, or create_task with approval)',
      ),
    );
    expect(
      await send(target, 'POST', '/api/tasks', { projectId: project.id, title: 'T', metadata: { noticeos_card: 'x' } }),
    ).toEqual(
      invalid(
        'metadata (only noticeos_source, noticeos_asset, noticeos_kind, noticeos_rule, noticeos_key, noticeos_panel_asset, noticeos_panel_date, noticeos_panel_version, noticeos_task_map_asset, each text of at most 2048 characters)',
      ),
    );
    expect(await send(target, 'POST', '/api/tasks', { projectId: 'missing', title: 'T' })).toEqual({
      status: 404,
      body: { error: 'not_found', detail: 'no project missing; /api/tasks/projects lists them' },
    });
    const sender = api({ principal: granted({ [project.id]: 'read' }), engine });
    expect(await send(sender, 'POST', '/api/tasks', { projectId: other.id, title: 'T' })).toEqual({
      status: 404,
      body: { error: 'not_found', detail: `no project ${other.id}; /api/tasks/projects lists them` },
    });
    expect(await send(sender, 'POST', '/api/tasks', { projectId: project.id, title: 'T' })).toEqual({
      status: 403,
      body: { error: 'forbidden', detail: `This sign-in may read ${project.name} but not change its tasks.` },
    });
  });
});

describe('PATCH /api/tasks/:id', () => {
  it('changes the fields the body names, and answers the task', async () => {
    const { id } = await task({ title: 'Old', labels: ['old'] });
    const response = await send(target, 'PATCH', `/api/tasks/${id}`, {
      projectId: project.id,
      title: 'New',
      priority: 0,
      addLabels: ['new'],
      removeLabels: ['old'],
      defer: '2027-03-01',
      card: { valuePerMonth: 3, likelihood: 0.5, reviewMinutes: 2, daysToSignal: 10, measurability: 'cohort' },
      changeClass: 'template',
    });
    expect(response.status).toBe(200);
    expect(response.body.task).toMatchObject({
      id,
      title: 'New',
      priority: 0,
      labels: ['new'],
      deferUntil: '2027-03-01T00:00:00.000Z',
      changeClass: 'template',
      card: { measurability: 'cohort', by: WRITER.name },
    });
  });

  it("files, changes and takes off a task's notes, design and estimate, and records each in its history", async () => {
    const filed = await send(target, 'POST', '/api/tasks', {
      projectId: project.id,
      title: 'Move the blog',
      notes: 'Old posts keep their dates.',
      design: 'Copy, then redirect.',
      estimateMinutes: 45,
    });
    expect(filed.status).toBe(200);
    const id = filed.body.id as string;
    const page = await get(target, `/api/tasks/${id}?project=${project.id}`);
    expect(page.body.task).toMatchObject({
      notes: 'Old posts keep their dates.',
      design: 'Copy, then redirect.',
      estimateMinutes: 45,
    });
    const patched = await send(target, 'PATCH', `/api/tasks/${id}`, {
      projectId: project.id,
      notes: 'Redirects in place.',
      estimateMinutes: null,
    });
    expect(patched.body.task).toMatchObject({
      notes: 'Redirects in place.',
      design: 'Copy, then redirect.',
      estimateMinutes: null,
    });
    const history = await get(target, `/api/tasks/${id}/history?project=${project.id}`);
    expect((history.body.changes as { fields: unknown }[])[0]!.fields).toEqual({
      notes: { old: 'Old posts keep their dates.', new: 'Redirects in place.' },
      estimateMinutes: { old: 45, new: null },
    });
    expect(
      await send(target, 'POST', '/api/tasks', { projectId: project.id, title: 'T', estimateMinutes: 2.5 }),
    ).toEqual({ status: 400, body: { error: 'invalid_request', detail: 'estimateMinutes (whole minutes, 0–525600)' } });
  });

  it('takes a task with claim, and refuses one someone else holds', async () => {
    const { id } = await task();
    expect(
      (await send(target, 'PATCH', `/api/tasks/${id}`, { projectId: project.id, claim: true })).body.task,
    ).toMatchObject({
      assignee: WRITER.name,
      status: 'in_progress',
    });
    const held = await task();
    await engine.writeTask(
      project.id,
      held.id,
      { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress' } },
      AGENT,
    );
    expect(await send(target, 'PATCH', `/api/tasks/${held.id}`, { projectId: project.id, claim: true })).toEqual({
      status: 409,
      body: { error: 'task_refused', detail: `${held.id} is held by ${AGENT.name}.` },
    });
  });

  it('refuses a claim with other changes, a close by status, an assignee with spaces around it, and a human label taken off', async () => {
    const { id } = await task({ title: 'Human', labels: ['human'] });
    const patch = (body: Record<string, unknown>) =>
      send(target, 'PATCH', `/api/tasks/${id}`, { projectId: project.id, ...body });
    expect(await patch({ claim: true, status: 'open' })).toEqual({
      status: 400,
      body: { error: 'invalid_request', detail: 'claim (on its own, without status)' },
    });
    expect(await patch({ status: 'closed' })).toEqual({
      status: 400,
      body: { error: 'invalid_request', detail: 'status (one of open, in_progress, blocked, deferred)' },
    });
    expect(await patch({})).toEqual({
      status: 400,
      body: { error: 'invalid_request', detail: 'name at least one field to change' },
    });
    expect(await patch({ assignee: 'agent-c ' })).toEqual({
      status: 400,
      body: { error: 'invalid_request', detail: 'assignee (a name on one line, or "" to release the task)' },
    });
    expect(await patch({ removeLabels: ['human'] })).toEqual({
      status: 409,
      body: { error: 'task_refused', detail: `${id} is a person's decision.` },
    });
    expect(
      await send(target, 'PATCH', `/api/tasks/${project.prefix}-none`, { projectId: project.id, title: 'X' }),
    ).toEqual({
      status: 404,
      body: { error: 'not_found', detail: `${project.prefix}-none is not a task in ${project.name}.` },
    });
  });

  it('answers a retried change once, and refuses its key for the same change to another task', async () => {
    const [first, second] = [await task(), await task()];
    const headers = { 'idempotency-key': key() };
    const body = { projectId: project.id, priority: 0 };
    const changed = await send(target, 'PATCH', `/api/tasks/${first.id}`, body, headers);
    expect(changed.status).toBe(200);
    expect(await send(target, 'PATCH', `/api/tasks/${first.id}`, body, headers)).toEqual(changed);
    expect((await current(first.id)).version).toBe(2);
    expect(await send(target, 'PATCH', `/api/tasks/${second.id}`, body, headers)).toMatchObject({
      status: 409,
      body: { error: 'idempotency_conflict' },
    });
    expect((await current(second.id)).priority).toBe(2);
  });
});

describe('POST /api/tasks/:id/comments', () => {
  it('adds a comment once per retry key', async () => {
    const { id } = await task();
    const headers = { 'idempotency-key': key() };
    const first = await send(
      target,
      'POST',
      `/api/tasks/${id}/comments`,
      { projectId: project.id, text: 'Noted.' },
      headers,
    );
    expect(first).toEqual({
      status: 200,
      body: { comment: { id: expect.any(String), author: WRITER.name, text: 'Noted.', createdAt: time.now() } },
    });
    expect(
      await send(target, 'POST', `/api/tasks/${id}/comments`, { projectId: project.id, text: 'Noted.' }, headers),
    ).toEqual(first);
    expect(await engine.listComments(project.id, id)).toHaveLength(1);
  });
});

describe('POST /api/tasks/:id/close', () => {
  it('closes a task once per retry key, and refuses a second close', async () => {
    const { id } = await task();
    const headers = { 'idempotency-key': key() };
    const body = { projectId: project.id, reason: 'Done in a1b2c3d.' };
    const first = await send(target, 'POST', `/api/tasks/${id}/close`, body, headers);
    expect(first.status).toBe(200);
    expect(first.body.task).toMatchObject({
      id,
      status: 'closed',
      closeReason: 'Done in a1b2c3d.',
      resolution: 'done',
    });
    expect(await send(target, 'POST', `/api/tasks/${id}/close`, body, headers)).toEqual(first);
    expect(await send(target, 'POST', `/api/tasks/${id}/close`, body)).toEqual({
      status: 409,
      body: { error: 'task_refused', detail: `${id} is already closed.` },
    });
  });

  it('closes a duplicate, and refuses a close the task state forbids', async () => {
    const original = await task({ title: 'Original' });
    const { id } = await task({ title: 'Copy' });
    const close = (taskId: string, body: Record<string, unknown>) =>
      send(target, 'POST', `/api/tasks/${taskId}/close`, { projectId: project.id, reason: 'Same.', ...body });
    expect(await close(id, { resolution: 'duplicate' })).toEqual({
      status: 400,
      body: {
        error: 'invalid_request',
        detail: 'duplicateOf (required with resolution duplicate: the task this one duplicates)',
      },
    });
    expect((await close(id, { resolution: 'duplicate', duplicateOf: original.id })).body.task).toMatchObject({
      resolution: 'duplicate',
      duplicateOf: original.id,
    });

    const held = await task();
    await engine.writeTask(
      project.id,
      held.id,
      { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress' } },
      AGENT,
    );
    expect(await close(held.id, {})).toEqual({
      status: 409,
      body: { error: 'task_refused', detail: `${held.id} is held by ${AGENT.name}, and only its holder closes it.` },
    });
    const gated = await task();
    const { created } = await engine.writeTask(
      project.id,
      gated.id,
      { expectedVersion: 1, requestApproval: { reason: 'Approve.' } },
      OWNER,
    );
    expect(await close(gated.id, {})).toEqual({
      status: 409,
      body: { error: 'task_refused', detail: `${gated.id} waits on approval ${created[0]!.id}. Approve it first.` },
    });
  });
});
