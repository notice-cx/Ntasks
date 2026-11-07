// Custom fields over HTTP: the field routes, values on a filed or changed
// task, and a board narrowed by a field.
import type { Project, TaskEngine } from '@ntasks/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { clock, newProject, OWNER } from '../engine/helpers.ts';
import { api, get, granted, send, WRITER, type TestApi } from './helpers.ts';

const time = clock('2026-11-06T12:00:00.000Z');
let target: TestApi;
let engine: TaskEngine;
let project: Project;

beforeAll(async () => {
  target = api({ principal: WRITER, now: time.now });
  engine = target.engine;
  project = await newProject(engine);
  await engine.defineField(
    project.id,
    { key: 'severity', name: 'Severity', type: 'single-choice', options: ['low', 'high'] },
    OWNER,
  );
  await engine.defineField(project.id, { key: 'points', name: 'Points', type: 'number' }, OWNER);
  await engine.defineField(project.id, { key: 'public', name: 'Public', type: 'yes-no' }, OWNER);
});

const invalid = (detail: string) => ({ status: 400, body: { error: 'invalid_request', detail } });

describe('the field routes', () => {
  it('list, define and retire fields, once per retry key', async () => {
    const own = await newProject(engine);
    const headers = { 'idempotency-key': `key-${crypto.randomUUID()}` };
    const body = { projectId: own.id, key: 'areas', name: 'Areas', type: 'multiple-choice', options: ['web', 'api'] };
    const defined = await send(target, 'POST', '/api/fields', body, headers);
    expect(defined).toEqual({
      status: 200,
      body: {
        field: {
          key: 'areas',
          name: 'Areas',
          type: 'multiple-choice',
          options: ['web', 'api'],
          createdAt: time.now(),
          retiredAt: null,
        },
      },
    });
    expect(await send(target, 'POST', '/api/fields', body, headers)).toEqual(defined);
    expect(await send(target, 'POST', '/api/fields', { ...body, key: 'other' }, headers)).toMatchObject({
      status: 409,
      body: { error: 'idempotency_conflict' },
    });
    expect(await get(target, `/api/fields?project=${own.id}`)).toEqual({
      status: 200,
      body: { project: own.key, fields: [defined.body.field] },
    });
    const retired = await send(target, 'POST', '/api/fields/areas/retire', { projectId: own.id });
    expect(retired).toMatchObject({ status: 200, body: { field: { key: 'areas', retiredAt: time.now() } } });
    expect(await send(target, 'POST', '/api/fields/nothing/retire', { projectId: own.id })).toEqual({
      status: 404,
      body: { error: 'not_found', detail: `${own.name} has no field nothing.` },
    });
    expect(await send(target, 'POST', '/api/fields', { ...body, key: 'Bad Key' })).toEqual(
      invalid('key must be a lowercase letter, then up to 63 lowercase letters, digits, underscores or hyphens'),
    );
    const response = await target.fetch(new Request('https://ntasks.test/api/fields', { method: 'DELETE' }));
    expect([response.status, response.headers.get('allow')]).toEqual([405, 'GET, HEAD, POST']);
  });

  it('refuse a sender who may only read the project', async () => {
    const reader = api({ principal: granted({ [project.id]: 'read' }), engine });
    expect((await get(reader, `/api/fields?project=${project.id}`)).status).toBe(200);
    const forbidden = {
      status: 403,
      body: { error: 'forbidden', detail: `This sign-in may read ${project.name} but not change its tasks.` },
    };
    expect(
      await send(reader, 'POST', '/api/fields', { projectId: project.id, key: 'x', name: 'X', type: 'text' }),
    ).toEqual(forbidden);
    expect(await send(reader, 'POST', '/api/fields/points/retire', { projectId: project.id })).toEqual(forbidden);
  });
});

describe("a task's values over HTTP", () => {
  it('are filed and changed, and a value of the wrong type is refused naming the field and its type', async () => {
    const filed = await send(target, 'POST', '/api/tasks', {
      projectId: project.id,
      title: 'Fix the form',
      fields: { severity: 'high', points: 2 },
    });
    const id = filed.body.id as string;
    expect((await get(target, `/api/tasks/${id}?project=${project.id}`)).body.task).toMatchObject({
      fields: { severity: 'high', points: 2 },
    });
    const patched = await send(target, 'PATCH', `/api/tasks/${id}`, {
      projectId: project.id,
      fields: { points: null, public: true },
    });
    expect((patched.body.task as { fields: unknown }).fields).toEqual({ severity: 'high', public: true });
    expect(
      await send(target, 'PATCH', `/api/tasks/${id}`, { projectId: project.id, fields: { severity: 'urgent' } }),
    ).toEqual(invalid('fields.severity must be one of low or high: Severity is a single-choice field'));
    expect(
      await send(target, 'POST', '/api/tasks', { projectId: project.id, title: 'T', fields: { points: 'two' } }),
    ).toEqual(invalid('fields.points must be a number: Points is a number field'));
  });

  it('narrow a board, each parameter read as its field takes it', async () => {
    const own = await newProject(engine);
    await engine.defineField(own.id, { key: 'points', name: 'Points', type: 'number' }, OWNER);
    await engine.defineField(own.id, { key: 'public', name: 'Public', type: 'yes-no' }, OWNER);
    const make = async (title: string, fields: Record<string, unknown>) =>
      (await send(target, 'POST', '/api/tasks', { projectId: own.id, title, fields })).body.id as string;
    const a = await make('A', { points: 3, public: true });
    const b = await make('B', { points: 3, public: false });
    await make('C', { points: 4 });
    const board = async (query: string) =>
      ((await get(target, `/api/tasks?project=${own.id}&${query}`)).body.tasks as { id: string }[])
        .map((task) => task.id)
        .sort();
    expect(await board('field.points=3')).toEqual([a, b].sort());
    expect(await board('field.points=3&field.public=true')).toEqual([a]);
    expect(await get(target, `/api/tasks?project=${own.id}&field.points=three`)).toEqual(
      invalid('field.points must be a number: Points is a number field'),
    );
    expect(await get(target, `/api/tasks?project=${own.id}&field.colour=red`)).toEqual(
      invalid('field.colour: the project has no field colour'),
    );
    expect(await get(target, `/api/tasks?project=${own.id}&label=x&field.points=3`)).toEqual(
      invalid('a label read reads every task carrying the label: leave out field.'),
    );
  });
});
