// Loading an import from Beads into the task store: whole or not at all, into
// an empty store only, read back table by table, and visible to the next read
// though the store had answered that read from memory before.
import { STORE_COLUMNS, STORE_TABLES, type StoreRows } from '@ntasks/domain';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { TaskStore } from '../src/store/index.ts';
import { AGENT } from './engine/helpers.ts';

/** A store no other test touches. */
function freshStore(): DurableObjectStub<TaskStore> {
  return env.TASK_STORE.getByName(`import-${crypto.randomUUID()}`);
}

/** Why the store refuses `work`, caught inside the object: a refusal sent back
 * through a stub would also count as an error the object left unhandled. */
function refusal(stub: DurableObjectStub<TaskStore>, work: (instance: TaskStore) => Promise<unknown>) {
  return runInDurableObject(stub, (instance: TaskStore) =>
    work(instance).then(
      () => null,
      (error: unknown) => (error as Error).message,
    ),
  );
}

const PROJECT = 'a1111111-0000-4000-8000-00000000000a';
const AT = '2026-03-02T09:00:00.000Z';
const CLOSED = '2026-03-02T10:00:00.000Z';

function created(id: string, fields: Record<string, unknown>): string {
  return JSON.stringify({
    id,
    projectId: PROJECT,
    parentId: null,
    type: 'task',
    awaitType: null,
    status: 'open',
    priority: 2,
    title: 'Imported',
    description: '',
    acceptance: '',
    assignee: null,
    assigneeModel: null,
    startedAt: null,
    deferUntil: null,
    dueAt: null,
    choices: null,
    choice: null,
    metadata: {},
    labels: [],
    dependencies: [],
    close: null,
    filedBy: 'agent-a',
    filedModel: null,
    ...fields,
  });
}

const task = {
  project_id: PROJECT,
  parent_id: null,
  type: 'task',
  await_type: null,
  status: 'open',
  priority: 2,
  description: '',
  acceptance: '',
  assignee: null,
  assignee_model: null,
  defer_until: null,
  due_at: null,
  choices: null,
  choice: null,
  metadata: '{}',
  filed_by: 'agent-a',
  filed_model: null,
  close_reason: null,
  resolution: null,
  duplicate_of: null,
  closed_by: null,
  closed_model: null,
  version: 1,
  created_at: AT,
  updated_at: AT,
  started_at: null,
  closed_at: null,
} as const;

const ROWS: StoreRows = {
  projects: [{ id: PROJECT, key: 'acme.example.com', name: 'Acme', prefix: 'acme', created_at: AT }],
  tasks: [
    { ...task, id: 'acme-e1', type: 'epic', title: 'Launch' },
    {
      ...task,
      id: 'acme-e1.1',
      parent_id: 'acme-e1',
      title: 'Write the pages',
      status: 'closed',
      version: 2,
      updated_at: CLOSED,
      closed_at: CLOSED,
      close_reason: 'Done.',
      resolution: 'done',
      closed_by: 'agent-a',
      notes: 'Two pages left for later.',
      design: 'One page per product.',
      estimate_minutes: 240,
      field_values: '{"audience":["buyers"]}',
    },
  ],
  task_labels: [{ task_id: 'acme-e1.1', label: 'content' }],
  task_edges: [{ task_id: 'acme-e1.1', depends_on_id: 'acme-e1', type: 'related', created_at: AT, created_by: null }],
  // A retired field with the value it had: an import loads both.
  custom_fields: [
    {
      project_id: PROJECT,
      key: 'audience',
      name: 'Audience',
      type: 'multiple-choice',
      options: '["buyers","sellers"]',
      created_at: AT,
      created_by: 'agent-a',
      retired_at: CLOSED,
      retired_by: 'owner',
    },
  ],
  task_external_links: [
    {
      task_id: 'acme-e1.1',
      url: 'https://example.com/acme/pages/pull/3',
      title: 'Write the pages',
      kind: 'pull-request',
      created_at: AT,
      created_by: 'agent-a',
    },
  ],
  task_comments: [{ id: 'k-0001', task_id: 'acme-e1.1', author: 'owner', text: 'Thanks!', created_at: CLOSED }],
  task_events: [
    {
      seq: 1,
      task_id: 'acme-e1',
      project_id: PROJECT,
      version: 1,
      kind: 'created',
      actor: 'agent-a',
      model: null,
      at: AT,
      changes: created('acme-e1', { type: 'epic', title: 'Launch' }),
    },
    {
      seq: 2,
      task_id: 'acme-e1.1',
      project_id: PROJECT,
      version: 1,
      kind: 'created',
      actor: 'agent-a',
      model: null,
      at: AT,
      changes: created('acme-e1.1', {
        parentId: 'acme-e1',
        title: 'Write the pages',
        labels: ['content'],
        dependencies: [{ taskId: 'acme-e1', type: 'related' }],
      }),
    },
    {
      seq: 3,
      task_id: 'acme-e1.1',
      project_id: PROJECT,
      version: 2,
      kind: 'closed',
      actor: 'agent-a',
      model: null,
      at: CLOSED,
      changes: JSON.stringify({
        status: 'closed',
        close: { at: CLOSED, reason: 'Done.', resolution: 'done', duplicateOf: null, by: 'agent-a', model: null },
      }),
    },
    {
      seq: 4,
      task_id: 'acme-e1.1',
      project_id: PROJECT,
      version: 2,
      kind: 'commented',
      actor: 'owner',
      model: null,
      at: CLOSED,
      changes: JSON.stringify({ commentId: 'k-0001', text: 'Thanks!' }),
    },
  ],
};

describe('an import into the task store', () => {
  it('writes every row, and reads each table back as it was given, with the defaults of columns it left out', async () => {
    const stub = freshStore();
    const result = await stub.importRows(ROWS);
    expect(result.rows).toBe(12);
    expect(result.rowsWritten).toBeGreaterThanOrEqual(12);
    const stored: StoreRows = {
      ...ROWS,
      projects: ROWS.projects.map((row) => ({ deploys: 0, disabled_at: null, website_url: null, ...row })),
      tasks: ROWS.tasks.map((row) => ({
        notes: '',
        design: '',
        estimate_minutes: null,
        field_values: '{}',
        delivery_commit: null,
        delivery_pull_request: null,
        delivery_merge_commit: null,
        built_at: null,
        merged_at: null,
        live_at: null,
        delivery_stage: null,
        assignee_for: null,
        work: '{}',
        close_link: null,
        steps: null,
        close_acceptance: null,
        close_test: null,
        ...row,
      })),
      task_comments: ROWS.task_comments.map((row) => ({ pinned: 0, test: null, ...row })),
      task_events: ROWS.task_events.map((row) => ({ actor_for: null, session: null, ...row })),
    };
    for (const table of STORE_TABLES) expect(await stub.tableRows(table)).toEqual(stored[table]);
  });

  it('names every column of each table it writes', async () => {
    const columns = await runInDurableObject(freshStore(), (_instance: TaskStore, state) =>
      Object.fromEntries(
        STORE_TABLES.map((table) => [
          table,
          state.storage.sql
            .exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
            .toArray()
            .map((row) => row.name)
            .sort(),
        ]),
      ),
    );
    for (const table of STORE_TABLES) expect(columns[table]).toEqual([...STORE_COLUMNS[table]].sort());
  });

  it('serves the imported tasks to the next read, though it had answered that read from memory', async () => {
    const stub = freshStore();
    expect(await runInDurableObject(stub, (instance: TaskStore) => instance.tasks.listProjects())).toEqual([]);
    await stub.importRows(ROWS);
    const projects = await runInDurableObject(stub, (instance: TaskStore) => instance.tasks.listProjects());
    expect(projects.map((project) => project.id)).toEqual([PROJECT]);
  });

  it('leaves tasks the engine reads, and writes on top of, as it does its own', async () => {
    const stub = freshStore();
    await stub.importRows(ROWS);
    const {
      task: closed,
      history,
      written,
    } = await runInDurableObject(stub, async (instance: TaskStore) => ({
      task: await instance.tasks.getTask(PROJECT, 'acme-e1.1'),
      history: await instance.tasks.listHistory(PROJECT, 'acme-e1.1', { limit: 10 }),
      written: await instance.tasks.writeTask(PROJECT, 'acme-e1.1', { expectedVersion: 2, reopen: true }, AGENT),
    }));
    expect(closed).toMatchObject({
      version: 2,
      parentId: 'acme-e1',
      labels: ['content'],
      externalLinks: [{ url: 'https://example.com/acme/pages/pull/3', title: 'Write the pages', kind: 'pull-request' }],
      fields: { audience: ['buyers'] },
      close: { resolution: 'done', by: 'agent-a' },
    });
    expect(history.map((event) => [event.seq, event.kind])).toEqual([
      [4, 'commented'],
      [3, 'closed'],
      [2, 'created'],
    ]);
    expect(written.task).toMatchObject({ version: 3, status: 'open', close: null });
  });

  it('refuses a store that already holds tasks, and changes nothing', async () => {
    const stub = freshStore();
    await stub.importRows(ROWS);
    expect(await refusal(stub, (instance) => instance.importRows(ROWS))).toBe(
      'The store already holds projects or tasks. An import writes only into an empty store.',
    );
    expect(await stub.tableRows('task_events')).toHaveLength(4);
  });

  it('writes nothing when one row breaks a rule of the schema', async () => {
    const stub = freshStore();
    const broken: StoreRows = { ...ROWS, task_labels: [...ROWS.task_labels, { task_id: 'acme-e1', label: '' }] };
    expect(await refusal(stub, (instance) => instance.importRows(broken))).toMatch(
      /CHECK constraint failed: length\(label\)/u,
    );
    for (const table of STORE_TABLES) expect(await stub.tableRows(table)).toEqual([]);
  });

  it('reads only the tables that hold tasks', async () => {
    expect(await refusal(freshStore(), (instance) => instance.tableRows('store_migrations' as 'tasks'))).toBe(
      'store_migrations is not a table of the task store.',
    );
  });
});
