// The MCP tools for custom fields, as an agent calls them: list_fields,
// define_field and retire_field, the fields argument of create_task,
// create_tasks, update_task and list_tasks, who may define and retire, and
// retries.
import type { Project, TaskEngine } from '@ntasks/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { clock, newProject } from '../engine/helpers.ts';
import { api, granted, READER, read, refusal, write, WORKSPACE, WRITER, type TestApi } from './helpers.ts';

const time = clock('2026-11-06T12:00:00.000Z');
let target: TestApi;
let engine: TaskEngine;

beforeAll(() => {
  target = api({ principal: WRITER, now: time.now });
  engine = target.engine;
});

const key = () => `key-${crypto.randomUUID()}`;

interface FieldView {
  key: string;
  name: string;
  type: string;
  options: string[] | null;
  createdAt: string;
  retiredAt: string | null;
}

async function define(project: Project, field: Record<string, unknown>) {
  return write<{ field: FieldView; replayed: boolean }>(target, 'define_field', {
    project: project.id,
    ...field,
    idempotency_key: key(),
  });
}

describe('define_field and list_fields', () => {
  it("define fields and list the project's fields, retired ones included", async () => {
    const project = await newProject(engine);
    const severity = await define(project, {
      key: 'severity',
      name: 'Severity',
      type: 'single-choice',
      options: ['low', 'high'],
    });
    expect(severity).toEqual({
      field: {
        key: 'severity',
        name: 'Severity',
        type: 'single-choice',
        options: ['low', 'high'],
        createdAt: time.now(),
        retiredAt: null,
      },
      replayed: false,
    });
    time.advance(1);
    await define(project, { key: 'points', name: 'Points', type: 'number' });
    const listed = await read<{ project: string; fields: FieldView[] }>(target, 'list_fields', { project: project.id });
    expect(listed.project).toBe(project.key);
    expect(listed.fields.map((field) => [field.key, field.type, field.options])).toEqual([
      ['severity', 'single-choice', ['low', 'high']],
      ['points', 'number', null],
    ]);
  });

  it('refuse a definition that breaks a rule, naming the argument', async () => {
    const project = await newProject(engine);
    const base = { workspace: WORKSPACE.id, project: project.id, idempotency_key: key() };
    expect(await refusal(target, 'define_field', { ...base, key: 'Size', name: 'Size', type: 'number' })).toBe(
      'invalid arguments: key must be a lowercase letter, then up to 63 lowercase letters, digits, underscores or hyphens',
    );
    expect(await refusal(target, 'define_field', { ...base, key: 'size', name: 'Size', type: 'single-choice' })).toBe(
      'invalid arguments: options must be 1 to 64 options, each one line of 1 to 128 characters, none twice',
    );
    expect(
      await refusal(target, 'define_field', { ...base, key: 'size', name: 'Size', type: 'number', colour: 1 }),
    ).toBe('invalid arguments: unknown colour');
    await define(project, { key: 'size', name: 'Size', type: 'number' });
    expect(
      await refusal(target, 'define_field', { ...base, idempotency_key: key(), key: 'size', name: 'S', type: 'text' }),
    ).toBe('invalid arguments: the project already has a field size; a key names one field, retired or not');
  });
});

describe('values through the task tools', () => {
  it('are filed, changed, taken off, listed, filtered on and kept in history', async () => {
    const project = await newProject(engine);
    await define(project, { key: 'severity', name: 'Severity', type: 'single-choice', options: ['low', 'high'] });
    await define(project, { key: 'areas', name: 'Areas', type: 'multiple-choice', options: ['web', 'api'] });
    await define(project, { key: 'points', name: 'Points', type: 'number' });
    const filed = await write<{ id: string }>(target, 'create_task', {
      project: project.id,
      title: 'Fix the login',
      fields: { severity: 'high', areas: ['api', 'web'], points: 3 },
      idempotency_key: key(),
    });
    const batch = await write<{ created: { id: string }[] }>(target, 'create_tasks', {
      project: project.id,
      tasks: [{ title: 'Write the docs', fields: { severity: 'low', areas: ['web'] } }],
      idempotency_key: key(),
    });
    const docs = batch.created[0]!.id;
    const read1 = await read<{ task: { fields: unknown } }>(target, 'get_task', {
      project: project.id,
      task: filed.id,
    });
    expect(read1.task.fields).toEqual({ severity: 'high', areas: ['web', 'api'], points: 3 });

    const changed = await write<{ task: { fields: unknown } }>(target, 'update_task', {
      project: project.id,
      task: filed.id,
      fields: { points: 5, severity: null },
      idempotency_key: key(),
    });
    expect(changed.task.fields).toEqual({ areas: ['web', 'api'], points: 5 });

    const ids = async (fields: Record<string, unknown>) =>
      (
        await read<{ tasks: { id: string; fields?: unknown }[] }>(target, 'list_tasks', { project: project.id, fields })
      ).tasks.map((task) => task.id);
    expect(await ids({ areas: 'web' })).toEqual(expect.arrayContaining([filed.id, docs]));
    expect(await ids({ areas: 'api' })).toEqual([filed.id]);
    expect(await ids({ severity: 'low' })).toEqual([docs]);
    expect(await ids({ points: 5 })).toEqual([filed.id]);
    const listed = await read<{ tasks: { id: string; fields?: unknown }[] }>(target, 'list_tasks', {
      project: project.id,
    });
    expect(listed.tasks.find((task) => task.id === docs)!.fields).toEqual({ severity: 'low', areas: ['web'] });

    const { changes } = await read<{ changes: { task: { fields: unknown } }[] }>(target, 'get_task_history', {
      project: project.id,
      task: filed.id,
      snapshots: true,
    });
    expect(changes.map((change) => change.task.fields)).toEqual([
      { areas: ['web', 'api'], points: 5 },
      { areas: ['web', 'api'], points: 3, severity: 'high' },
    ]);
  });

  it('refuse a value of the wrong type with a sentence naming the field and its type, and a filter with no project', async () => {
    const project = await newProject(engine);
    await define(project, { key: 'points', name: 'Points', type: 'number' });
    await define(project, { key: 'public', name: 'Public', type: 'yes-no' });
    const { id } = await write<{ id: string }>(target, 'create_task', {
      project: project.id,
      title: 'T',
      idempotency_key: key(),
    });
    const base = { workspace: WORKSPACE.id, project: project.id, idempotency_key: key() };
    expect(await refusal(target, 'create_task', { ...base, title: 'T', fields: { points: 'three' } })).toBe(
      'invalid arguments: fields.points must be a number: Points is a number field',
    );
    expect(await refusal(target, 'update_task', { ...base, task: id, fields: { public: 'yes' } })).toBe(
      'invalid arguments: fields.public must be true or false: Public is a yes-no field',
    );
    expect(await refusal(target, 'update_task', { ...base, task: id, fields: { colour: 'red' } })).toBe(
      'invalid arguments: fields.colour: the project has no field colour',
    );
    expect(
      await refusal(target, 'list_tasks', { workspace: WORKSPACE.id, project: project.id, fields: { points: 'x' } }),
    ).toBe('invalid arguments: fields.points must be a number: Points is a number field');
    expect(await refusal(target, 'list_tasks', { workspace: WORKSPACE.id, fields: { points: 3 } })).toBe(
      'invalid arguments: fields (name a project: each project defines its own fields)',
    );
    expect(await refusal(target, 'update_task', { ...base, task: id, fields: { points: { n: 3 } } })).toBe(
      'invalid arguments: fields (an object of at most 64 values by field key: text, a number, true or false, or a list of options, or null to take one off)',
    );
    expect((await engine.getTask(project.id, id))!.fields).toEqual({});
  });

  it('change nothing for a value the task already has, and keep the retry rules', async () => {
    const project = await newProject(engine);
    await define(project, { key: 'areas', name: 'Areas', type: 'multiple-choice', options: ['web', 'api'] });
    const { id } = await write<{ id: string }>(target, 'create_task', {
      project: project.id,
      title: 'T',
      fields: { areas: ['web', 'api'] },
      idempotency_key: key(),
    });
    // The same options in another order are the same value.
    const same = await write<{ replayed: boolean }>(target, 'update_task', {
      project: project.id,
      task: id,
      fields: { areas: ['api', 'web'] },
      idempotency_key: key(),
    });
    expect(same.replayed).toBe(false);
    expect((await engine.getTask(project.id, id))!.version).toBe(1);
    const once = { project: project.id, task: id, fields: { areas: ['api'] }, idempotency_key: key() };
    await write(target, 'update_task', once);
    expect(await write<{ replayed: boolean }>(target, 'update_task', once)).toMatchObject({ replayed: true });
    expect(
      await refusal(target, 'update_task', { workspace: WORKSPACE.id, ...once, fields: { areas: ['web'] } }),
    ).toMatch(/^conflict: /u);
    expect((await engine.getTask(project.id, id))!).toMatchObject({ version: 2, fields: { areas: ['api'] } });
  });
});

describe('retire_field', () => {
  it('stops new values, keeps the values tasks carry, and lets one be taken off', async () => {
    const project = await newProject(engine);
    await define(project, { key: 'points', name: 'Points', type: 'number' });
    const { id } = await write<{ id: string }>(target, 'create_task', {
      project: project.id,
      title: 'Sized',
      fields: { points: 8 },
      idempotency_key: key(),
    });
    const args = { project: project.id, field: 'points', idempotency_key: key() };
    const retired = await write<{ field: FieldView; replayed: boolean }>(target, 'retire_field', args);
    expect(retired).toMatchObject({ field: { key: 'points', retiredAt: time.now() }, replayed: false });
    expect(await write(target, 'retire_field', args)).toEqual({ ...retired, replayed: true });
    expect(await refusal(target, 'retire_field', { workspace: WORKSPACE.id, ...args, field: 'other' })).toMatch(
      /^conflict: /u,
    );
    expect(
      (await read<{ fields: FieldView[] }>(target, 'list_fields', { project: project.id })).fields[0]!.retiredAt,
    ).toBe(time.now());

    const base = { workspace: WORKSPACE.id, project: project.id, task: id, idempotency_key: key() };
    expect(await refusal(target, 'update_task', { ...base, fields: { points: 9 } })).toBe(
      'invalid arguments: fields.points: Points is retired and takes no new values',
    );
    expect(
      (await read<{ task: { fields: unknown } }>(target, 'get_task', { project: project.id, task: id })).task.fields,
    ).toEqual({ points: 8 });
    const filtered = await read<{ tasks: { id: string }[] }>(target, 'list_tasks', {
      project: project.id,
      fields: { points: 8 },
    });
    expect(filtered.tasks.map((task) => task.id)).toEqual([id]);
    await write(target, 'update_task', { ...base, fields: { points: null } });
    expect((await engine.getTask(project.id, id))!.fields).toEqual({});
    expect(
      await refusal(target, 'retire_field', {
        workspace: WORKSPACE.id,
        project: project.id,
        field: 'nothing',
        idempotency_key: key(),
      }),
    ).toBe(`refused: projectId ${project.id} (${project.name}) has no field nothing; list_fields lists its fields.`);
  });
});

describe('who may define and retire', () => {
  it('needs tasks:write in the project, and reads with tasks:read', async () => {
    const project = await newProject(engine);
    await define(project, { key: 'size', name: 'Size', type: 'number' });
    const readOnly = api({ principal: granted({ [project.id]: 'read' }), engine });
    const forbidden = `refused: this call needs tasks:write in projectId ${project.id} (${project.name}), where you have tasks:read.`;
    expect(
      await refusal(readOnly, 'define_field', {
        workspace: WORKSPACE.id,
        project: project.id,
        key: 'other',
        name: 'Other',
        type: 'text',
        idempotency_key: key(),
      }),
    ).toBe(forbidden);
    expect(
      await refusal(readOnly, 'retire_field', {
        workspace: WORKSPACE.id,
        project: project.id,
        field: 'size',
        idempotency_key: key(),
      }),
    ).toBe(forbidden);
    const reader = api({ principal: READER, engine });
    expect(
      (await read<{ fields: FieldView[] }>(reader, 'list_fields', { project: project.id })).fields.map(
        (field) => field.key,
      ),
    ).toEqual(['size']);
    expect(
      await refusal(reader, 'define_field', {
        workspace: WORKSPACE.id,
        project: project.id,
        key: 'other',
        name: 'Other',
        type: 'text',
        idempotency_key: key(),
      }),
    ).toMatch(/^refused: this call needs tasks:write in workspace /u);
    expect((await engine.listFields(project.id)).map((field) => [field.key, field.retiredAt])).toEqual([
      ['size', null],
    ]);
  });
});
