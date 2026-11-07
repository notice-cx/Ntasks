/**
 * The task store's rows, table by table, as an import writes them and a
 * verifier reads them back. The column lists are the tables' columns in
 * workers/api/src/store/migrations; an import from Beads (tools/migrate)
 * builds these rows, and the store loads them with these statements.
 */

/** The tables that hold tasks, in an order their foreign keys accept. */
export const STORE_TABLES = [
  'projects',
  'custom_fields',
  'tasks',
  'task_labels',
  'task_edges',
  'task_external_links',
  'task_comments',
  'task_events',
] as const;
export type StoreTable = (typeof STORE_TABLES)[number];

export interface ProjectRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly prefix: string;
  readonly created_at: string;
  /** 1 when the project's changes go live by a deploy. Left out, 0. */
  readonly deploys?: number;
}

export interface TaskRow {
  readonly id: string;
  readonly project_id: string;
  readonly parent_id: string | null;
  readonly type: string;
  readonly await_type: string | null;
  readonly status: string;
  readonly priority: number;
  readonly title: string;
  readonly description: string;
  readonly acceptance: string;
  readonly assignee: string | null;
  readonly assignee_model: string | null;
  readonly defer_until: string | null;
  readonly due_at: string | null;
  readonly choices: string | null;
  readonly choice: string | null;
  readonly metadata: string;
  readonly filed_by: string | null;
  readonly filed_model: string | null;
  readonly close_reason: string | null;
  readonly resolution: string | null;
  readonly duplicate_of: string | null;
  readonly closed_by: string | null;
  readonly closed_model: string | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at: string | null;
  readonly closed_at: string | null;
  /** Left out, these take the column's default: '' for text, null for the estimate. */
  readonly notes?: string;
  readonly design?: string;
  readonly estimate_minutes?: number | null;
  /** JSON text: the task's custom field values by key. Left out, '{}'. */
  readonly field_values?: string;
  /** The task's delivery. Left out, null: no delivery. */
  readonly delivery_commit?: string | null;
  readonly delivery_pull_request?: string | null;
  readonly delivery_merge_commit?: string | null;
  readonly built_at?: string | null;
  readonly merged_at?: string | null;
  readonly live_at?: string | null;
  readonly delivery_stage?: string | null;
  /** The helper its holder works through, and JSON text of its work details. Left out, null and '{}'. */
  readonly assignee_for?: string | null;
  readonly work?: string;
}

export interface LabelRow {
  readonly task_id: string;
  readonly label: string;
}

export interface EdgeRow {
  readonly task_id: string;
  readonly depends_on_id: string;
  readonly type: string;
  readonly created_at: string;
  readonly created_by: string | null;
}

export interface CustomFieldRow {
  readonly project_id: string;
  readonly key: string;
  readonly name: string;
  readonly type: string;
  /** JSON text: a choice field's options; null for any other type. */
  readonly options: string | null;
  readonly created_at: string;
  readonly created_by: string | null;
  readonly retired_at: string | null;
  readonly retired_by: string | null;
}

export interface ExternalLinkRow {
  readonly task_id: string;
  readonly url: string;
  readonly title: string;
  readonly kind: string | null;
  readonly created_at: string;
  readonly created_by: string | null;
}

export interface CommentRow {
  readonly id: string;
  readonly task_id: string;
  readonly author: string;
  readonly text: string;
  readonly created_at: string;
}

export interface EventRow {
  /** Kept as given, so an imported history keeps its order. */
  readonly seq: number;
  readonly task_id: string;
  readonly project_id: string;
  readonly version: number;
  readonly kind: string;
  readonly actor: string;
  readonly model: string | null;
  readonly at: string;
  /** JSON text. */
  readonly changes: string;
}

/** Every row of the tables that hold tasks. A task's parent and the task it duplicates come before it. */
export interface StoreRows {
  readonly projects: readonly ProjectRow[];
  readonly tasks: readonly TaskRow[];
  readonly task_labels: readonly LabelRow[];
  readonly task_edges: readonly EdgeRow[];
  /** Left out, an import writes none. */
  readonly task_external_links?: readonly ExternalLinkRow[];
  /** Left out, an import writes none. */
  readonly custom_fields?: readonly CustomFieldRow[];
  readonly task_comments: readonly CommentRow[];
  readonly task_events: readonly EventRow[];
}

type RowOf<T extends StoreTable> = NonNullable<StoreRows[T]>[number];

/** Each table's columns, in the order the statements below name them. */
export const STORE_COLUMNS: { readonly [T in StoreTable]: readonly (keyof RowOf<T> & string)[] } = Object.freeze({
  projects: ['id', 'key', 'name', 'prefix', 'created_at', 'deploys'],
  tasks: [
    'id',
    'project_id',
    'parent_id',
    'type',
    'await_type',
    'status',
    'priority',
    'title',
    'description',
    'acceptance',
    'assignee',
    'assignee_model',
    'defer_until',
    'due_at',
    'choices',
    'choice',
    'metadata',
    'filed_by',
    'filed_model',
    'close_reason',
    'resolution',
    'duplicate_of',
    'closed_by',
    'closed_model',
    'version',
    'created_at',
    'updated_at',
    'started_at',
    'closed_at',
    'notes',
    'design',
    'estimate_minutes',
    'field_values',
    'delivery_commit',
    'delivery_pull_request',
    'delivery_merge_commit',
    'built_at',
    'merged_at',
    'live_at',
    'delivery_stage',
    'assignee_for',
    'work',
  ],
  task_labels: ['task_id', 'label'],
  task_edges: ['task_id', 'depends_on_id', 'type', 'created_at', 'created_by'],
  task_external_links: ['task_id', 'url', 'title', 'kind', 'created_at', 'created_by'],
  custom_fields: [
    'project_id',
    'key',
    'name',
    'type',
    'options',
    'created_at',
    'created_by',
    'retired_at',
    'retired_by',
  ],
  task_comments: ['id', 'task_id', 'author', 'text', 'created_at'],
  task_events: ['seq', 'task_id', 'project_id', 'version', 'kind', 'actor', 'model', 'at', 'changes'],
});

/** The order a table's rows are read back in: its primary key, which storeKey gives as columns. */
const STORE_ORDER: { readonly [T in StoreTable]: string } = Object.freeze({
  projects: 'id',
  tasks: 'id',
  task_labels: 'task_id, label',
  task_edges: 'task_id, depends_on_id',
  task_external_links: 'task_id, url',
  custom_fields: 'project_id, key',
  task_comments: 'id',
  task_events: 'seq',
});

export type StoreValue = string | number | null;

/** One parameterized INSERT: the column names are fixed here, and every value is bound. */
export interface StoreStatement {
  readonly sql: string;
  readonly values: readonly StoreValue[];
}

export function isStoreTable(value: unknown): value is StoreTable {
  return typeof value === 'string' && (STORE_TABLES as readonly string[]).includes(value);
}

/** One INSERT per row, table by table in STORE_TABLES' order. A column the
 * row leaves out is left out of its INSERT, so it takes the column's default. */
export function insertStatements(rows: StoreRows): StoreStatement[] {
  const statements: StoreStatement[] = [];
  for (const table of STORE_TABLES) {
    for (const row of (rows[table] ?? []) as readonly object[] as readonly Readonly<
      Record<string, StoreValue | undefined>
    >[]) {
      const columns = (STORE_COLUMNS[table] as readonly string[]).filter((column) => row[column] !== undefined);
      statements.push({
        sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        values: columns.map((column) => row[column] ?? null),
      });
    }
  }
  return statements;
}

/** The query that reads every row of a table, in a fixed order. */
export function selectAllSql(table: StoreTable): string {
  return `SELECT ${(STORE_COLUMNS[table] as readonly string[]).join(', ')} FROM ${table} ORDER BY ${STORE_ORDER[table]}`;
}

/** A table's primary key columns: no two rows share their values. */
export function storeKey(table: StoreTable): readonly string[] {
  return STORE_ORDER[table].split(', ');
}
