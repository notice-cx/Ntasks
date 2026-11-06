/** The import plan as SQL statements for `wrangler d1 execute --file`. */
import type { ImportPlan } from './plan.ts';

/** D1's longest SQL statement, in bytes (developers.cloudflare.com/d1/platform/limits). */
export const D1_STATEMENT_LIMIT = 100_000;
/** Rows go into one INSERT until it reaches this size, well under D1's limit. */
const STATEMENT_TARGET = 50_000;

type Value = string | number | null;

export function sqlValue(value: Value): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Cannot write the number ${value} as SQL.`);
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function inserts<T extends { readonly [K in keyof T]: Value }>(table: string, columns: readonly (keyof T & string)[], rows: readonly T[]): string[] {
  const statements: string[] = [];
  const head = `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n`;
  let values: string[] = [];
  let size = head.length;
  const flush = () => {
    if (values.length > 0) statements.push(`${head}${values.join(',\n')};`);
    values = [];
    size = head.length;
  };
  for (const row of rows) {
    const tuple = `(${columns.map((column) => sqlValue(row[column])).join(', ')})`;
    if (values.length > 0 && size + tuple.length > STATEMENT_TARGET) flush();
    values.push(tuple);
    size += tuple.length + 2;
  }
  flush();
  return statements;
}

/**
 * Every statement of the import, in an order the schema's foreign keys
 * accept. Events are inserted in plan order, so `task_events.seq` takes the
 * plan's numbers in an empty database.
 */
export function importStatements(plan: ImportPlan): string[] {
  const events = plan.events.map(({ seq: _seq, ...event }) => event);
  return [
    ...inserts('projects', ['id', 'key', 'name', 'prefix', 'created_at'], plan.projects),
    ...inserts(
      'tasks',
      [
        'id', 'project_id', 'parent_id', 'type', 'await_type', 'status', 'priority', 'title', 'description', 'acceptance',
        'assignee', 'assignee_model', 'defer_until', 'due_at', 'choices', 'choice', 'metadata', 'filed_by', 'filed_model',
        'close_reason', 'resolution', 'duplicate_of', 'closed_by', 'closed_model', 'version', 'created_at', 'updated_at',
        'started_at', 'closed_at',
      ],
      plan.tasks,
    ),
    ...inserts('task_labels', ['task_id', 'label'], plan.labels),
    ...inserts('task_edges', ['task_id', 'depends_on_id', 'type', 'created_at', 'created_by'], plan.edges),
    ...inserts('task_comments', ['id', 'task_id', 'author', 'text', 'created_at'], plan.comments),
    ...inserts('task_events', ['task_id', 'project_id', 'version', 'kind', 'actor', 'model', 'at', 'changes'], events),
  ];
}

/** How many statements are longer than D1 accepts from a remote client. */
export function oversizedStatements(statements: readonly string[]): number {
  const encoder = new TextEncoder();
  return statements.filter((statement) => encoder.encode(statement).length > D1_STATEMENT_LIMIT).length;
}
