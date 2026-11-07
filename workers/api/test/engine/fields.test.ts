// A project's custom fields in the engine: defining and listing them, the
// values tasks carry and their history, filters, retiring, retries, and a
// field retired while a write was being made.
import type { Json, TaskEngine } from '@ntasks/domain';
import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine/index.ts';
import type { Database, Statement } from '../../src/engine/database.ts';
import { storeDatabase } from '../store.ts';
import { AGENT, clock, engine, expectRefusal, newProject, OWNER, retryFor } from './helpers.ts';

/** One field of each type, a minute apart when given a clock. */
async function defineEach(tasks: TaskEngine, projectId: string, time?: ReturnType<typeof clock>) {
  const define = (key: string, name: string, type: string, options?: string[]) =>
    tasks.defineField(projectId, { key, name, type, ...(options ? { options } : {}) } as never, OWNER);
  await define('notes-short', 'Short note', 'text');
  time?.advance(1);
  await define('points', 'Points', 'number');
  time?.advance(1);
  await define('launch', 'Launch date', 'date');
  time?.advance(1);
  await define('severity', 'Severity', 'single-choice', ['low', 'medium', 'high']);
  time?.advance(1);
  await define('areas', 'Areas', 'multiple-choice', ['web', 'api', 'docs']);
  time?.advance(1);
  await define('spec', 'Spec', 'url');
  time?.advance(1);
  await define('public', 'Public', 'yes-no');
  time?.advance(1);
}

describe('defining fields', () => {
  it('defines a field of each type and lists them in the order they were defined', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    await defineEach(tasks, project.id, time);
    const fields = await tasks.listFields(project.id);
    expect(fields.map((field) => [field.key, field.type, field.options])).toEqual([
      ['notes-short', 'text', null],
      ['points', 'number', null],
      ['launch', 'date', null],
      ['severity', 'single-choice', ['low', 'medium', 'high']],
      ['areas', 'multiple-choice', ['web', 'api', 'docs']],
      ['spec', 'url', null],
      ['public', 'yes-no', null],
    ]);
    expect(fields[0]).toMatchObject({ projectId: project.id, name: 'Short note', createdBy: 'owner', retiredAt: null });
    expect(await tasks.listFields((await newProject(tasks)).id)).toEqual([]);
  });

  it('refuses a key the project has used, retired or not, and a definition that breaks a rule', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    await tasks.defineField(project.id, { key: 'size', name: 'Size', type: 'number' }, OWNER);
    const again = await expectRefusal(
      tasks.defineField(project.id, { key: 'size', name: 'Other', type: 'text' }, OWNER),
      'invalid',
    );
    expect(again.message).toBe('the project already has a field size; a key names one field, retired or not');
    await tasks.retireField(project.id, 'size', OWNER);
    await expectRefusal(tasks.defineField(project.id, { key: 'size', name: 'Size', type: 'number' }, OWNER), 'invalid');
    const rules: [object, string][] = [
      [{ key: 'Size', name: 'S', type: 'text' }, 'key must be a lowercase letter'],
      [{ key: 'a', name: ' A', type: 'text' }, 'name must be one line'],
      [{ key: 'a', name: 'A', type: 'colour' }, 'type must be text, number, date'],
      [{ key: 'a', name: 'A', type: 'single-choice' }, 'options must be 1 to 64 options'],
      [{ key: 'a', name: 'A', type: 'single-choice', options: ['x', 'x'] }, 'none twice'],
      [{ key: 'a', name: 'A', type: 'number', options: ['x'] }, 'options are for a single-choice or multiple-choice'],
    ];
    for (const [input, message] of rules) {
      const refused = await expectRefusal(tasks.defineField(project.id, input as never, OWNER), 'invalid');
      expect(refused.message).toContain(message);
    }
    await expectRefusal(
      tasks.defineField(crypto.randomUUID(), { key: 'a', name: 'A', type: 'text' }, OWNER),
      'not_found',
    );
  });
});

describe('values', () => {
  it('files and changes values of each type, as the store keeps them, and records each in history', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    await defineEach(tasks, project.id);
    const { task } = await tasks.createTask(
      project.id,
      {
        title: 'Launch the page',
        fields: {
          'notes-short': 'Two lines\nof text',
          points: 2.5,
          launch: '2027-02-28',
          severity: 'high',
          areas: ['docs', 'web'],
          spec: 'HTTPS://Docs.Example.com/spec',
          public: false,
        },
      },
      AGENT,
    );
    expect(task.fields).toEqual({
      'notes-short': 'Two lines\nof text',
      points: 2.5,
      launch: '2027-02-28',
      severity: 'high',
      // In the field's order, and the URL as the URL standard writes it.
      areas: ['web', 'docs'],
      spec: 'https://docs.example.com/spec',
      public: false,
    });
    time.advance(1);
    const { task: changed } = await tasks.writeTask(
      project.id,
      task.id,
      { expectedVersion: 1, setFields: { points: 3, severity: null, public: true, areas: ['api'] } },
      AGENT,
    );
    expect(changed.fields).toMatchObject({ points: 3, public: true, areas: ['api'] });
    expect(changed.fields).not.toHaveProperty('severity');
    expect(await tasks.getTask(project.id, task.id)).toEqual(changed);

    const history = await tasks.listHistory(project.id, task.id, { limit: 10 });
    const rebuilt: Record<string, Json> = {};
    for (const event of [...history].reverse()) Object.assign(rebuilt, event.changes);
    expect(rebuilt.fields).toEqual(changed.fields);
    expect(history[0]!.changes).toEqual({ fields: changed.fields });
  });

  it('refuses a value of the wrong type with a sentence naming the field and its type', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    await defineEach(tasks, project.id);
    const wrong: [string, unknown, string][] = [
      ['notes-short', 3, 'fields.notes-short must be text of 1 to 1024 characters: Short note is a text field'],
      ['points', '3', 'fields.points must be a number: Points is a number field'],
      ['launch', '2027-02-30', 'fields.launch must be a date as YYYY-MM-DD: Launch date is a date field'],
      ['severity', 'urgent', 'fields.severity must be one of low, medium or high: Severity is a single-choice field'],
      [
        'areas',
        ['web', 'web'],
        'fields.areas must be a list of its options, each one of web, api or docs, none twice: Areas is a multiple-choice field',
      ],
      [
        'spec',
        'ftp://example.com/spec',
        'fields.spec must be an http or https URL of at most 2048 characters: Spec is a url field',
      ],
      ['public', 'yes', 'fields.public must be true or false: Public is a yes-no field'],
      ['colour', 'red', 'fields.colour: the project has no field colour'],
    ];
    for (const [key, value, message] of wrong) {
      const refused = await expectRefusal(
        tasks.createTask(project.id, { title: 'T', fields: { [key]: value } as never }, AGENT),
        'invalid',
      );
      expect(refused.message, key).toBe(message);
    }
    expect((await tasks.listTasks(project.id, { limit: 10 })).tasks).toEqual([]);
    await expectRefusal(
      tasks.createTask(project.id, { title: 'T', fields: { points: null } as never }, AGENT),
      'invalid',
    );
  });
});

describe('filters', () => {
  it('narrow a list and a board to the tasks holding a value, and to a multiple-choice field holding an option', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    await defineEach(tasks, project.id);
    const make = async (title: string, fields: Record<string, unknown>) =>
      (await tasks.createTask(project.id, { title, fields: fields as never }, AGENT)).task.id;
    const a = await make('A', { severity: 'high', areas: ['web', 'api'], points: 3, public: true });
    const b = await make('B', { severity: 'low', areas: ['api'], points: 3.5, public: false });
    const c = await make('C', { severity: 'high' });
    const listed = async (fields: Record<string, string | number | boolean>) => {
      const list = (await tasks.listTasks(project.id, { limit: 50, fields })).tasks.map((task) => task.id);
      const board = (await tasks.listBoard(project.id, { statuses: ['open'], fields })).map((task) => task.id);
      expect(board.sort(), JSON.stringify(fields)).toEqual([...list].sort());
      return list.sort();
    };
    expect(await listed({ severity: 'high' })).toEqual([a, c].sort());
    expect(await listed({ areas: 'api' })).toEqual([a, b].sort());
    expect(await listed({ areas: 'web', severity: 'high' })).toEqual([a]);
    expect(await listed({ points: 3 })).toEqual([a]);
    expect(await listed({ public: false })).toEqual([b]);
    expect(await listed({ severity: 'medium' })).toEqual([]);
  });
});

describe('retiring a field', () => {
  it('takes no new values, keeps the values tasks carry and their history, and lets a value be taken off', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    await defineEach(tasks, project.id);
    const { task } = await tasks.createTask(
      project.id,
      { title: 'Sized', fields: { points: 5, severity: 'low' } },
      AGENT,
    );
    time.advance(1);
    const retired = await tasks.retireField(project.id, 'points', OWNER);
    expect(retired).toMatchObject({ replayed: false, field: { key: 'points', retiredBy: 'owner' } });
    expect(retired.field.retiredAt).toBe(time.now());
    expect(await tasks.retireField(project.id, 'points', AGENT)).toEqual({ ...retired, replayed: false });

    expect((await tasks.getTask(project.id, task.id))!.fields).toEqual({ points: 5, severity: 'low' });
    expect((await tasks.listTasks(project.id, { limit: 10, fields: { points: 5 } })).tasks).toHaveLength(1);
    const refused = await expectRefusal(
      tasks.writeTask(project.id, task.id, { expectedVersion: 1, setFields: { points: 6 } }, AGENT),
      'invalid',
    );
    expect(refused.message).toBe('fields.points: Points is retired and takes no new values');
    await expectRefusal(tasks.createTask(project.id, { title: 'New', fields: { points: 1 } }, AGENT), 'invalid');
    const { task: cleared } = await tasks.writeTask(
      project.id,
      task.id,
      { expectedVersion: 1, setFields: { points: null } },
      AGENT,
    );
    expect(cleared.fields).toEqual({ severity: 'low' });
    const history = await tasks.listHistory(project.id, task.id, { limit: 10 });
    expect(history.map((event) => event.changes.fields)).toEqual([{ severity: 'low' }, { points: 5, severity: 'low' }]);
    await expectRefusal(tasks.retireField(project.id, 'nothing', OWNER), 'not_found');
  });
});

describe('retries', () => {
  it('answer a define or retire retried with its key, and refuse the key for another request', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const input = { key: 'size', name: 'Size', type: 'number' } as const;
    const retry = await retryFor('define-key-1', input, 'define_field');
    const first = await tasks.defineField(project.id, input, OWNER, retry);
    expect(await tasks.defineField(project.id, input, OWNER, retry)).toEqual({ ...first, replayed: true });
    await expectRefusal(
      tasks.defineField(project.id, { ...input, key: 'other' }, OWNER, { ...retry, requestHash: 'f'.repeat(64) }),
      'retry_conflict',
    );
    const retire = await retryFor('retire-key-1', { field: 'size' }, 'retire_field');
    const retired = await tasks.retireField(project.id, 'size', OWNER, retire);
    expect(await tasks.retireField(project.id, 'size', OWNER, retire)).toEqual({ ...retired, replayed: true });
    expect((await tasks.listFields(project.id)).map((field) => field.key)).toEqual(['size']);
  });
});

/** A database that retires `key` in `projectId` just before its next batch
 * runs: a field retired after a write checked its values. */
function retiringBeforeBatch(projectId: string, key: string): Database {
  const db = storeDatabase();
  let armed = true;
  return {
    prepare: (sql: string) => db.prepare(sql),
    async batch<T>(statements: readonly Statement[]) {
      if (armed) {
        armed = false;
        await db
          .prepare(
            "UPDATE custom_fields SET retired_at = '2026-11-06T12:00:00.000Z' WHERE project_id = ?1 AND key = ?2",
          )
          .bind(projectId, key)
          .run();
      }
      return db.batch<T>(statements);
    },
  };
}

describe('a field retired while a write is made', () => {
  it('stores no new value: a new task is checked again and refused, and a change is refused as changed', async () => {
    const setUp = engine();
    const project = await newProject(setUp);
    await setUp.defineField(project.id, { key: 'size', name: 'Size', type: 'number' }, OWNER);
    await setUp.defineField(project.id, { key: 'tier', name: 'Tier', type: 'number' }, OWNER);
    const { task } = await setUp.createTask(project.id, { title: 'Existing' }, AGENT);

    const creating = createEngine(retiringBeforeBatch(project.id, 'size'));
    const refused = await expectRefusal(
      creating.createTask(project.id, { title: 'New', fields: { size: 1 } }, AGENT),
      'invalid',
    );
    expect(refused.message).toBe('fields.size: Size is retired and takes no new values');
    expect((await setUp.listTasks(project.id, { limit: 10 })).tasks.map((row) => row.id)).toEqual([task.id]);

    const changing = createEngine(retiringBeforeBatch(project.id, 'tier'));
    await expectRefusal(
      changing.writeTask(project.id, task.id, { expectedVersion: 1, setFields: { tier: 2 } }, AGENT),
      'version_conflict',
    );
    expect(await setUp.getTask(project.id, task.id)).toMatchObject({ version: 1, fields: {} });
  });
});
