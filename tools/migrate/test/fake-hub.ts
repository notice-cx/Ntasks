/**
 * A synthetic Beads hub for tests. Each commit changes its tables and records
 * the changes the way Dolt's `dolt_diff_<table>` and `dolt_log` would, and
 * every row comes out as the Dolt SQL client prints it: NULL columns left
 * out, times as `YYYY-MM-DD HH:MM:SS`. Every name and id in it is invented.
 */
import type { Json } from '@ntasks/domain';
import type { BeadsProject, BeadsRow } from '../src/beads.ts';
import type { Reader } from '../src/export.ts';
import { databaseQueries, VERSION_QUERY } from '../src/export.ts';

type Value = Json | undefined;
type MutableRow = Record<string, Value>;

/** An ISO time as Dolt prints a DATETIME. */
export function doltTime(iso: string): string {
  return iso.replace('T', ' ').replace(/(?:\.000)?Z$/u, '');
}

function render(row: MutableRow): BeadsRow {
  const out: Record<string, Json> = {};
  for (const [column, value] of Object.entries(row)) if (value !== undefined && value !== null) out[column] = value;
  return out;
}

/** The columns Beads gives a new issue, empty ones included. */
function newIssue(fields: MutableRow, at: string, by: string): MutableRow {
  return {
    id: undefined,
    content_hash: 'c0ffee',
    title: '',
    description: '',
    design: '',
    acceptance_criteria: '',
    notes: '',
    status: 'open',
    priority: 2,
    issue_type: 'task',
    assignee: null,
    estimated_minutes: null,
    created_at: doltTime(at),
    created_by: by,
    owner: '',
    updated_at: doltTime(at),
    closed_at: null,
    close_reason: '',
    external_ref: null,
    compaction_level: 0,
    ephemeral: 0,
    pinned: 0,
    is_template: 0,
    await_type: null,
    await_id: '',
    timeout_ns: 0,
    waiters: '',
    metadata: {},
    started_at: null,
    defer_until: null,
    due_at: null,
    is_blocked: 0,
    ...fields,
  };
}

export interface Change {
  create(fields: MutableRow & { readonly id: string; readonly title: string }): void;
  update(id: string, fields: MutableRow): void;
  remove(id: string): void;
  label(id: string, label: string): void;
  unlabel(id: string, label: string): void;
  link(id: string, target: string, type?: string, extra?: MutableRow): void;
  unlink(id: string, target: string, type?: string): void;
}

export class FakeHub {
  readonly database: string;
  readonly key: string;
  readonly name: string;
  readonly id: string;
  readonly prefix: string;
  readonly issues = new Map<string, MutableRow>();
  readonly labels = new Map<string, MutableRow>();
  readonly links = new Map<string, MutableRow>();
  readonly comments: MutableRow[] = [];
  readonly events: MutableRow[] = [];
  readonly otherTables: { name: string; rows: number }[] = [
    { name: 'config', rows: 3 },
    { name: 'metadata', rows: 2 },
    { name: 'schema_migrations', rows: 66 },
    { name: 'wisps', rows: 0 },
  ];
  branches: BeadsRow[] = [{ name: 'main', hash: 'h0' }];
  readonly log: MutableRow[] = [];
  readonly diffs: { issues: MutableRow[]; labels: MutableRow[]; dependencies: MutableRow[] } = {
    issues: [],
    labels: [],
    dependencies: [],
  };
  #working = 'w0';
  #now = '';
  #actor = '';

  constructor(options: { database: string; key: string; name: string; id: string; prefix: string }) {
    this.database = options.database;
    this.key = options.key;
    this.name = options.name;
    this.id = options.id;
    this.prefix = options.prefix;
  }

  #change(): Change {
    return {
      create: (fields) => {
        this.issues.set(fields.id, newIssue(fields, this.#now, this.#actor));
      },
      update: (id, fields) => {
        const issue = this.issues.get(id);
        if (issue === undefined) throw new Error(`No issue ${id}.`);
        this.issues.set(id, { ...issue, ...fields, updated_at: doltTime(this.#now) });
      },
      remove: (id) => {
        this.issues.delete(id);
      },
      label: (id, label) => {
        this.labels.set(`${id} ${label}`, { issue_id: id, label });
      },
      unlabel: (id, label) => {
        this.labels.delete(`${id} ${label}`);
      },
      link: (id, target, type = 'blocks', extra = {}) => {
        this.links.set(`${id} ${target} ${type}`, {
          issue_id: id,
          depends_on_issue_id: target,
          type,
          created_at: doltTime(this.#now),
          created_by: this.#actor,
          metadata: {},
          ...extra,
        });
      },
      unlink: (id, target, type = 'blocks') => {
        this.links.delete(`${id} ${target} ${type}`);
      },
    };
  }

  #record(commit: string, date: string | undefined, apply: (change: Change) => void) {
    const before = { issues: new Map(this.issues), labels: new Map(this.labels), dependencies: new Map(this.links) };
    apply(this.#change());
    const after = { issues: this.issues, labels: this.labels, dependencies: this.links };
    const previous = this.log.at(-1);
    for (const table of ['issues', 'labels', 'dependencies'] as const) {
      const keys = new Set([...before[table].keys(), ...after[table].keys()]);
      for (const key of keys) {
        const from = before[table].get(key);
        const to = after[table].get(key);
        if (from !== undefined && to !== undefined && JSON.stringify(from) === JSON.stringify(to)) continue;
        const row: MutableRow = {
          diff_type: from === undefined ? 'added' : to === undefined ? 'removed' : 'modified',
          from_commit: previous?.commit_hash,
          from_commit_date: previous?.date,
          to_commit: commit,
          to_commit_date: date,
        };
        for (const [column, value] of Object.entries(from ?? {})) row[`from_${column}`] = value;
        for (const [column, value] of Object.entries(to ?? {})) row[`to_${column}`] = value;
        this.diffs[table].push(row);
      }
    }
    this.#working = `w${this.log.length}-${this.diffs.issues.length}`;
  }

  /** One Beads write, committed at `at` by `actor`, with the audit event Beads logs for it, which may name another actor. */
  commit(
    at: string,
    actor: string,
    apply: (change: Change) => void,
    audit?: { readonly issue: string; readonly event: string; readonly actor?: string },
  ): string {
    this.#now = at;
    this.#actor = actor;
    const hash = `c${String(this.log.length + 1).padStart(4, '0')}${this.database.length}`;
    this.#record(hash, doltTime(at), apply);
    this.log.push({
      commit_hash: hash,
      committer: actor,
      email: `${actor}@example.com`,
      date: doltTime(at),
      message: `bd: ${audit?.event ?? 'change'}`,
    });
    if (audit !== undefined) this.audit(audit.issue, audit.event, audit.actor ?? actor, at);
    this.branches = [{ name: 'main', hash }];
    return hash;
  }

  /** A change Beads made but has not committed. */
  uncommitted(at: string, actor: string, apply: (change: Change) => void) {
    this.#now = at;
    this.#actor = actor;
    this.#record('WORKING', undefined, apply);
  }

  comment(issue: string, id: string, author: string, text: string, at: string) {
    this.comments.push({ id, issue_id: issue, author, text, created_at: doltTime(at) });
    this.audit(issue, 'commented', author, at);
  }

  audit(issue: string, event: string, actor: string, at: string) {
    this.events.push({
      id: String(this.events.length + 1),
      issue_id: issue,
      event_type: event,
      actor,
      created_at: doltTime(at),
    });
  }

  /** The project as `export` would write it. */
  project(): BeadsProject {
    const tables = [
      { name: 'issues', rows: this.issues.size },
      { name: 'labels', rows: this.labels.size },
      { name: 'dependencies', rows: this.links.size },
      { name: 'comments', rows: this.comments.length },
      { name: 'events', rows: this.events.length },
      ...this.otherTables,
    ].sort((a, b) => a.name.localeCompare(b.name));
    return {
      database: this.database,
      key: this.key,
      name: this.name,
      id: this.id,
      prefix: this.prefix,
      tables,
      branches: this.branches,
      commits: [...this.log].reverse().map(render),
      rows: {
        issues: [...this.issues.values()].map(render),
        labels: [...this.labels.values()].map(render),
        dependencies: [...this.links.values()].map(render),
        comments: this.comments.map(render),
        events: this.events.map(render),
      },
      diffs: {
        issues: this.diffs.issues.map(render),
        labels: this.diffs.labels.map(render),
        dependencies: this.diffs.dependencies.map(render),
      },
    };
  }

  /** The export's queries and this hub's answers to them, as a Dolt server would give them. */
  answers(): Map<string, readonly BeadsRow[]> {
    const project = this.project();
    const q = databaseQueries(this.database);
    const answers = new Map<string, readonly BeadsRow[]>([
      [q.state, [{ head: this.log.at(-1)?.commit_hash ?? 'h0', working: this.#working }]],
      [q.projectId, [{ value: this.id }]],
      [q.prefix, [{ value: this.prefix }]],
      [q.tables, project.tables.map((table) => ({ name: table.name }))],
      [q.branches, project.branches],
      [q.commits, project.commits],
    ]);
    for (const table of project.tables) answers.set(q.count(table.name), [{ count: table.rows }]);
    for (const table of ['issues', 'labels', 'dependencies', 'comments', 'events'] as const)
      answers.set(q.rows(table), project.rows[table]);
    for (const table of ['issues', 'labels', 'dependencies'] as const) answers.set(q.diff(table), project.diffs[table]);
    return answers;
  }
}

/** A reader over several hubs, as one Dolt server holding their databases. It records every step it is sent. */
export function fakeServer(hubs: readonly FakeHub[], version = '2.4.0'): Reader & { readonly steps: string[][] } {
  const steps: string[][] = [];
  const answers = serverAnswers(hubs, version);
  const read = async (queries: readonly string[]) => {
    steps.push([...queries]);
    return queries.map((sql) => {
      const rows = answers.get(sql);
      if (rows === undefined) throw new Error(`The fake server does not know the query: ${sql}`);
      return [...rows];
    });
  };
  return Object.assign(read, { steps });
}

/** Every query the export sends to these hubs, with the answer. */
export function serverAnswers(hubs: readonly FakeHub[], version = '2.4.0'): Map<string, readonly BeadsRow[]> {
  const answers = new Map<string, readonly BeadsRow[]>([[VERSION_QUERY, [{ version }]]]);
  for (const hub of hubs) for (const [sql, rows] of hub.answers()) answers.set(sql, rows);
  return answers;
}
