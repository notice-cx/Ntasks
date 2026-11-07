import {
  DEPENDENCY_TYPES,
  EXTERNAL_LINK_KINDS,
  FIELD_TYPES,
  GUARD_REFUSALS,
  guardRefusalOf,
  TASK_EVENT_KINDS,
  TASK_RESOLUTIONS,
  TASK_STATUSES,
  TASK_TYPES,
} from '@ntasks/domain';
import { describe, expect, it } from 'vitest';
import type { Statement } from '../src/engine/database.ts';
import { storeDatabase } from './store.ts';

// These tests write rows straight into the schema that the task store's
// migrations create (src/store/migrations), with no engine in between, so they
// show what the database itself enforces.

const db = storeDatabase();

const NOW = '2026-11-06T18:00:00.000Z';
const LATER = '2026-11-06T18:05:00.000Z';

type Row = Record<string, string | number | null>;

function insert(table: string, row: Row): Statement {
  const columns = Object.keys(row);
  return db
    .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .bind(...Object.values(row));
}

/** A new project with a prefix no other test uses. */
async function newProject(): Promise<{ id: string; prefix: string }> {
  const id = crypto.randomUUID();
  const prefix = `t${id.slice(0, 8)}`;
  await insert('projects', { id, key: `${prefix}.example.com`, name: 'Test project', prefix, created_at: NOW }).run();
  return { id, prefix };
}

function taskRow(projectId: string, id: string, fields: Row = {}): Row {
  return {
    id,
    project_id: projectId,
    type: 'task',
    status: 'open',
    priority: 2,
    title: 'Write the guide',
    filed_by: 'tester',
    created_at: NOW,
    updated_at: NOW,
    ...fields,
  };
}

const CLOSED: Row = {
  status: 'closed',
  closed_at: LATER,
  resolution: 'done',
  close_reason: 'Shipped',
  closed_by: 'tester',
};

async function newTask(fields: Row = {}): Promise<{ projectId: string; taskId: string }> {
  const project = await newProject();
  const taskId = `${project.prefix}-a1b2`;
  await insert('tasks', taskRow(project.id, taskId, fields)).run();
  return { projectId: project.id, taskId };
}

function eventRow(projectId: string, taskId: string, fields: Row = {}): Row {
  return {
    task_id: taskId,
    project_id: projectId,
    version: 1,
    kind: 'updated',
    actor: 'tester',
    at: LATER,
    changes: '{}',
    ...fields,
  };
}

/** The values a table's CHECK allows for one column, read from the schema itself. */
async function checkList(table: string, column: string): Promise<string[]> {
  const row = await db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(table)
    .first<{ sql: string }>();
  const list = new RegExp(`\\b${column} IN \\(([^)]*)\\)`, 'u').exec(row?.sql ?? '')?.[1];
  if (list === undefined) throw new Error(`${table} has no CHECK list for ${column}`);
  return [...list.matchAll(/'([^']*)'/gu)].map((match) => match[1]!);
}

describe('the schema accepts exactly the task model vocabulary', () => {
  it.each([
    ['tasks', 'status', TASK_STATUSES],
    ['tasks', 'type', TASK_TYPES],
    ['tasks', 'resolution', TASK_RESOLUTIONS],
    ['task_edges', 'type', DEPENDENCY_TYPES],
    ['task_external_links', 'kind', EXTERNAL_LINK_KINDS],
    ['custom_fields', 'type', FIELD_TYPES],
    ['task_events', 'kind', TASK_EVENT_KINDS],
  ] as const)('%s.%s allows the domain list and nothing else', async (table, column, domainList) => {
    expect((await checkList(table, column)).sort()).toEqual([...domainList].sort());
  });

  it.each(TASK_STATUSES)('accepts the status %s', async (status) => {
    await expect(newTask(status === 'closed' ? CLOSED : { status })).resolves.toBeDefined();
  });

  it('refuses a status the model does not have', async () => {
    await expect(newTask({ status: 'pinned' })).rejects.toThrow(/CHECK constraint failed/u);
  });

  it.each(TASK_TYPES)('accepts the type %s', async (type) => {
    await expect(newTask(type === 'gate' ? { type, await_type: 'human' } : { type })).resolves.toBeDefined();
  });

  it('refuses a type the model does not have', async () => {
    await expect(newTask({ type: 'molecule' })).rejects.toThrow(/CHECK constraint failed/u);
  });

  it.each(TASK_RESOLUTIONS)('accepts the resolution %s', async (resolution) => {
    const other = resolution === 'duplicate' ? await newTask() : null;
    await expect(newTask({ ...CLOSED, resolution, duplicate_of: other?.taskId ?? null })).resolves.toBeDefined();
  });

  it('refuses a resolution the model does not have', async () => {
    await expect(newTask({ ...CLOSED, resolution: 'fixed' })).rejects.toThrow(/CHECK constraint failed/u);
  });

  it.each(DEPENDENCY_TYPES)('accepts the dependency type %s', async (type) => {
    const project = await newProject();
    await db.batch([
      insert('tasks', taskRow(project.id, `${project.prefix}-a1`)),
      insert('tasks', taskRow(project.id, `${project.prefix}-b2`)),
    ]);
    const edge = { task_id: `${project.prefix}-a1`, depends_on_id: `${project.prefix}-b2`, type, created_at: NOW };
    await expect(insert('task_edges', edge).run()).resolves.toBeUndefined();
  });

  it('refuses parent-child as a dependency type, because a parent is a column', async () => {
    const project = await newProject();
    await db.batch([
      insert('tasks', taskRow(project.id, `${project.prefix}-a1`)),
      insert('tasks', taskRow(project.id, `${project.prefix}-b2`)),
    ]);
    const edge = {
      task_id: `${project.prefix}-a1`,
      depends_on_id: `${project.prefix}-b2`,
      type: 'parent-child',
      created_at: NOW,
    };
    await expect(insert('task_edges', edge).run()).rejects.toThrow(/CHECK constraint failed/u);
  });

  it.each(TASK_EVENT_KINDS)('accepts the history event kind %s', async (kind) => {
    const { projectId, taskId } = await newTask();
    await expect(insert('task_events', eventRow(projectId, taskId, { kind })).run()).resolves.toBeUndefined();
  });

  it('refuses a history event kind the model does not have', async () => {
    const { projectId, taskId } = await newTask();
    await expect(insert('task_events', eventRow(projectId, taskId, { kind: 'deleted' })).run()).rejects.toThrow(
      /CHECK constraint failed/u,
    );
  });

  it.each(GUARD_REFUSALS)('reports the guard refusal %s by name', async (refusal) => {
    const error = await db
      .prepare('INSERT INTO write_guard (ok, refusal) VALUES (0, ?)')
      .bind(refusal)
      .run()
      .then(
        () => null,
        (failure: unknown) => failure,
      );
    expect(error).toBeInstanceOf(Error);
    expect(guardRefusalOf((error as Error).message)).toBe(refusal);
  });
});

describe('the write guard', () => {
  /** A versioned update of the title, guarded, followed by its history event. */
  function guardedTitleChange(projectId: string, taskId: string, readVersion: number, title: string): Statement[] {
    return [
      db
        .prepare('UPDATE tasks SET title = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
        .bind(title, LATER, taskId, readVersion),
      db.prepare("INSERT INTO write_guard (ok, refusal) VALUES (changes() = 1, 'version_conflict')"),
      insert(
        'task_events',
        eventRow(projectId, taskId, { version: readVersion + 1, changes: JSON.stringify({ title }) }),
      ),
    ];
  }

  async function stateOf(taskId: string): Promise<{ title: string; version: number; events: number }> {
    const task = await db
      .prepare('SELECT title, version FROM tasks WHERE id = ?')
      .bind(taskId)
      .first<{ title: string; version: number }>();
    const events = await db
      .prepare('SELECT count(*) AS n FROM task_events WHERE task_id = ?')
      .bind(taskId)
      .first<{ n: number }>();
    return { title: task!.title, version: task!.version, events: events!.n };
  }

  it('writes the change and its history together when the version matches', async () => {
    const { projectId, taskId } = await newTask();

    await db.batch(guardedTitleChange(projectId, taskId, 1, 'Write the setup guide'));

    expect(await stateOf(taskId)).toEqual({ title: 'Write the setup guide', version: 2, events: 1 });
  });

  it('writes nothing, history included, when the version has moved on', async () => {
    const { projectId, taskId } = await newTask();

    const error = await db.batch(guardedTitleChange(projectId, taskId, 7, 'Stale title')).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(guardRefusalOf((error as Error).message)).toBe('version_conflict');
    expect(await stateOf(taskId)).toEqual({ title: 'Write the guide', version: 1, events: 0 });
  });

  it('lets exactly one of two writers that read the same version succeed', async () => {
    const { projectId, taskId } = await newTask();

    const outcomes = await Promise.allSettled([
      db.batch(guardedTitleChange(projectId, taskId, 1, 'First writer')),
      db.batch(guardedTitleChange(projectId, taskId, 1, 'Second writer')),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
    expect(guardRefusalOf((refused.reason as Error).message)).toBe('version_conflict');
    const state = await stateOf(taskId);
    expect(state.version).toBe(2);
    expect(state.events).toBe(1);
    expect(['First writer', 'Second writer']).toContain(state.title);
  });
});

describe('rules the database keeps whatever code writes to it', () => {
  it('refuses an update that does not raise the version by one', async () => {
    const { taskId } = await newTask();

    await expect(
      db.prepare('UPDATE tasks SET title = ? WHERE id = ?').bind('Quiet edit', taskId).run(),
    ).rejects.toThrow(/must raise its version by one/u);
  });

  it('keeps a task in its project', async () => {
    const { taskId } = await newTask();
    const other = await newProject();

    const move = db
      .prepare('UPDATE tasks SET project_id = ?, version = version + 1 WHERE id = ?')
      .bind(other.id, taskId);
    await expect(move.run()).rejects.toThrow(/keeps its id, project and creation time/u);
  });

  it('never deletes a task', async () => {
    const { taskId } = await newTask();

    await expect(db.prepare('DELETE FROM tasks WHERE id = ?').bind(taskId).run()).rejects.toThrow(/never deleted/u);
  });

  it('never edits or deletes history', async () => {
    const { projectId, taskId } = await newTask();
    await insert('task_events', eventRow(projectId, taskId)).run();

    await expect(
      db.prepare("UPDATE task_events SET actor = 'someone else' WHERE task_id = ?").bind(taskId).run(),
    ).rejects.toThrow(/history is never edited/u);
    await expect(db.prepare('DELETE FROM task_events WHERE task_id = ?').bind(taskId).run()).rejects.toThrow(
      /history is never deleted/u,
    );
  });

  it('never edits or deletes a comment', async () => {
    const { taskId } = await newTask();
    const id = crypto.randomUUID();
    await insert('task_comments', {
      id,
      task_id: taskId,
      author: 'tester',
      text: 'Looks right.',
      created_at: NOW,
    }).run();

    await expect(db.prepare("UPDATE task_comments SET text = 'Changed.' WHERE id = ?").bind(id).run()).rejects.toThrow(
      /comments are never edited/u,
    );
    await expect(db.prepare('DELETE FROM task_comments WHERE id = ?').bind(id).run()).rejects.toThrow(
      /comments are never deleted/u,
    );
  });

  it('refuses a closed task that does not record its close', async () => {
    await expect(newTask({ status: 'closed' })).rejects.toThrow(/CHECK constraint failed/u);
  });

  it.each([
    ['a close time', { closed_at: LATER }],
    ['a resolution', { resolution: 'done' }],
    ['a close reason', { close_reason: 'Shipped' }],
    ['a closer', { closed_by: 'tester' }],
    ['a closer model', { closed_model: 'claude-opus-5-5' }],
  ] as const)('refuses %s on a task that is not closed', async (_case, fields) => {
    await expect(newTask(fields)).rejects.toThrow(/CHECK constraint failed/u);
  });

  it('refuses a duplicate close left on a task that is not closed', async () => {
    const other = await newTask();
    await expect(newTask({ resolution: 'duplicate', duplicate_of: other.taskId })).rejects.toThrow(
      /CHECK constraint failed/u,
    );
  });

  it('accepts a task as large as Beads stores one', async () => {
    const name = 'n'.repeat(255);
    const { taskId } = await newTask({
      assignee: name,
      title: 't'.repeat(500),
      description: 'd'.repeat(200_000),
      notes: 'n'.repeat(200_000),
      design: 'g'.repeat(200_000),
      estimate_minutes: 1_000_000,
    });

    await expect(insert('task_labels', { task_id: taskId, label: name }).run()).resolves.toBeUndefined();
  });

  it('refuses an estimate below zero minutes, and a task with no notes or design text', async () => {
    await expect(newTask({ estimate_minutes: -1 })).rejects.toThrow(/CHECK constraint failed/u);
    await expect(newTask({ notes: null })).rejects.toThrow(/NOT NULL constraint failed: tasks.notes/u);
    await expect(newTask({ design: null })).rejects.toThrow(/NOT NULL constraint failed: tasks.design/u);
  });

  it('keeps an external link to an http or https URL, once per task', async () => {
    const { taskId } = await newTask();
    const link = (url: string, kind: string | null = 'document') =>
      insert('task_external_links', { task_id: taskId, url, title: 'A page', kind, created_at: NOW });
    await expect(link('https://example.com/a').run()).resolves.toBeUndefined();
    await expect(link('http://example.com/b', null).run()).resolves.toBeUndefined();
    await expect(link('https://example.com/a', 'other').run()).rejects.toThrow(/UNIQUE constraint failed/u);
    await expect(link('ftp://example.com/c').run()).rejects.toThrow(/CHECK constraint failed/u);
    await expect(link(`https://example.com/${'a'.repeat(2030)}`).run()).rejects.toThrow(/CHECK constraint failed/u);
    await expect(link('https://example.com/d', 'issue').run()).rejects.toThrow(/CHECK constraint failed/u);
    await expect(
      insert('task_external_links', {
        task_id: 'tnone-a1',
        url: 'https://example.com/e',
        title: 'A',
        created_at: NOW,
      }).run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/u);
  });

  it("keeps a field's key, type and options, and a retired field retired, and never deletes one", async () => {
    const project = await newProject();
    const field = (row: Row) =>
      insert('custom_fields', { project_id: project.id, name: 'Field', created_at: NOW, ...row });
    await expect(field({ key: 'size', type: 'number' }).run()).resolves.toBeUndefined();
    await expect(field({ key: 'tier', type: 'single-choice', options: '["a","b"]' }).run()).resolves.toBeUndefined();
    await expect(field({ key: 'Size', type: 'number' }).run()).rejects.toThrow(/CHECK constraint failed/u);
    await expect(field({ key: 'pick', type: 'single-choice' }).run()).rejects.toThrow(/CHECK constraint failed/u);
    await expect(field({ key: 'note', type: 'text', options: '["a"]' }).run()).rejects.toThrow(
      /CHECK constraint failed/u,
    );
    const update = (set: string) =>
      db.prepare(`UPDATE custom_fields SET ${set} WHERE project_id = ?1 AND key = 'tier'`).bind(project.id).run();
    await expect(update("type = 'multiple-choice'")).rejects.toThrow(/a field keeps its key, type and options/u);
    await expect(update(`options = '["a"]'`)).rejects.toThrow(/a field keeps its key, type and options/u);
    await expect(update(`name = 'Tier', retired_at = '${LATER}'`)).resolves.toBeUndefined();
    await expect(update('retired_at = NULL')).rejects.toThrow(/stays retired/u);
    await expect(db.prepare('DELETE FROM custom_fields WHERE project_id = ?1').bind(project.id).run()).rejects.toThrow(
      /fields are never deleted/u,
    );
  });

  it("keeps a task's field values as one JSON object", async () => {
    await expect(newTask({ field_values: '{"size":3}' })).resolves.toBeDefined();
    await expect(newTask({ field_values: '[3]' })).rejects.toThrow(/CHECK constraint failed/u);
    await expect(newTask({ field_values: 'size' })).rejects.toThrow(/CHECK constraint failed/u);
  });

  it('keeps a helper and work details only on a task someone holds that is not closed', async () => {
    const held = { assignee: 'agent-a', status: 'in_progress' };
    await expect(newTask({ ...held, assignee_for: 'helper-1', work: '{"branch":"b"}' })).resolves.toBeDefined();
    await expect(newTask({ assignee_for: 'helper-1' })).rejects.toThrow(/CHECK constraint failed/u);
    await expect(newTask({ work: '{"branch":"b"}' })).rejects.toThrow(/CHECK constraint failed/u);
    await expect(newTask({ ...CLOSED, assignee: 'agent-a', work: '{"next":"n"}' })).rejects.toThrow(
      /CHECK constraint failed/u,
    );
    await expect(newTask({ ...held, work: '["b"]' })).rejects.toThrow(/CHECK constraint failed/u);
    const { taskId } = await newTask({ ...held, assignee_for: 'helper-1', work: '{"branch":"b"}' });
    // A release that leaves them behind is refused.
    await expect(
      db.prepare('UPDATE tasks SET assignee = NULL, version = version + 1 WHERE id = ?1').bind(taskId).run(),
    ).rejects.toThrow(/CHECK constraint failed/u);
  });

  it('refuses a name longer than 255 characters', async () => {
    await expect(newTask({ assignee: 'n'.repeat(256) })).rejects.toThrow(/CHECK constraint failed/u);
  });

  it('refuses a project prefix with a hyphen', async () => {
    const row = {
      id: crypto.randomUUID(),
      key: 'web-app.example.com',
      name: 'Web app',
      prefix: 'web-app',
      created_at: NOW,
    };
    await expect(insert('projects', row).run()).rejects.toThrow(/CHECK constraint failed/u);
  });

  it('refuses a task that depends on itself', async () => {
    const { taskId } = await newTask();
    const edge = { task_id: taskId, depends_on_id: taskId, type: 'blocks', created_at: NOW };

    await expect(insert('task_edges', edge).run()).rejects.toThrow(/CHECK constraint failed/u);
  });

  it('refuses a link to a task that does not exist', async () => {
    const { taskId } = await newTask();
    const edge = { task_id: taskId, depends_on_id: 'nowhere-zz99', type: 'blocks', created_at: NOW };

    await expect(insert('task_edges', edge).run()).rejects.toThrow(/FOREIGN KEY constraint failed/u);
  });
});
