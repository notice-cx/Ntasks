import { describe, expect, it } from 'vitest';
import { insertStatements, isStoreTable, selectAllSql, type StoreRows, type TaskRow } from '../src/index.ts';

const EMPTY: StoreRows = {
  projects: [],
  tasks: [],
  task_labels: [],
  task_edges: [],
  task_comments: [],
  task_events: [],
};

describe('store rows', () => {
  it('writes each row as one INSERT with every value bound, tables in foreign-key order', () => {
    const statements = insertStatements({
      ...EMPTY,
      task_labels: [{ task_id: 'web-a1', label: "it's" }],
      projects: [
        { id: 'p1', key: 'web.example.com', name: 'Web', prefix: 'web', created_at: '2026-01-01T00:00:00.000Z' },
      ],
    });
    expect(statements).toEqual([
      {
        sql: 'INSERT INTO projects (id, key, name, prefix, created_at) VALUES (?, ?, ?, ?, ?)',
        values: ['p1', 'web.example.com', 'Web', 'web', '2026-01-01T00:00:00.000Z'],
      },
      { sql: 'INSERT INTO task_labels (task_id, label) VALUES (?, ?)', values: ['web-a1', "it's"] },
    ]);
  });

  it("leaves a column the row leaves out out of its INSERT, so it takes the column's default", () => {
    const task: TaskRow = {
      id: 'web-a1',
      project_id: 'p1',
      parent_id: null,
      type: 'task',
      await_type: null,
      status: 'open',
      priority: 2,
      title: 'Imported',
      description: '',
      acceptance: '',
      assignee: null,
      assignee_model: null,
      defer_until: null,
      due_at: null,
      choices: null,
      choice: null,
      metadata: '{}',
      filed_by: null,
      filed_model: null,
      close_reason: null,
      resolution: null,
      duplicate_of: null,
      closed_by: null,
      closed_model: null,
      version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      started_at: null,
      closed_at: null,
    };
    const [without, withNotes] = insertStatements({ ...EMPTY, tasks: [task, { ...task, notes: 'Kept.' }] });
    expect(without!.sql).not.toMatch(/notes|design|estimate_minutes/u);
    expect(without!.values).toHaveLength(29);
    expect(withNotes!.sql).toMatch(/, notes\) VALUES/u);
    expect(withNotes!.values.at(-1)).toBe('Kept.');
  });

  it('reads a table back in a fixed order, naming only its known tables', () => {
    expect(selectAllSql('task_events')).toBe(
      'SELECT seq, task_id, project_id, version, kind, actor, model, at, changes, actor_for, session FROM task_events ORDER BY seq',
    );
    expect(isStoreTable('task_edges')).toBe(true);
    expect(isStoreTable('write_receipts')).toBe(false);
    expect(isStoreTable('tasks; DROP TABLE tasks')).toBe(false);
  });
});
