/**
 * The verifier: compares the task store with the export it was imported
 * from, or with the backup it was restored from (verifyBackup, below).
 *
 * It checks three ways, so a mistake in one is caught by another:
 *
 * 1. Against the export's own rows, read directly: tasks per project and
 *    status, every id, label, link, comment and close, the choices of
 *    decisions, approvals and their state, and every metadata key, such as
 *    the cards NoticeOS froze when a task shipped.
 * 2. Against the import plan, row by row, for every table.
 * 3. Against itself: each task's history, replayed in order, must rebuild
 *    the task as it stands, with one version per change.
 */
import { BACKUP_TABLES, backupKey, isTaskId } from '@ntasks/domain';
import type { BackupFile, BackupTable, Json, JsonObject } from '@ntasks/domain';
import { isEmpty, textOf, timeOf, type BeadsExport } from './beads.ts';
import { isJsonObject, sameJson, stableJson } from './json.ts';
import type { ImportPlan } from './plan.ts';
import { COLUMN_METADATA_KEYS, linkTarget, sortLinks, TYPES_AS_LABELS } from './task-state.ts';

export interface Difference {
  readonly subject: string;
  readonly difference: string;
}

export interface StatusCount {
  readonly project: string;
  readonly status: string;
  readonly expected: number;
  readonly actual: number;
}

export interface VerifyReport {
  readonly differences: readonly Difference[];
  readonly counts: readonly StatusCount[];
  readonly totals: Readonly<Record<'projects' | 'tasks' | 'labels' | 'links' | 'comments' | 'events', number>>;
  readonly approvals: number;
  readonly decisions: number;
  readonly frozenCards: number;
}

const IN_SCOPE_LINKS = new Set(['blocks', 'related', 'discovered-from', 'parent-child']);

/** One row of the store, as it reads back. */
export type Row = Record<string, unknown>;

/** Reads one table of the store whose import is verified: a local copy of it (local-store.ts), or the store itself. */
export type StoreReader = (table: BackupTable) => Promise<readonly Row[]> | readonly Row[];

interface StoreContents {
  readonly projects: readonly Row[];
  readonly tasks: readonly Row[];
  readonly labels: readonly Row[];
  readonly edges: readonly Row[];
  readonly comments: readonly Row[];
  readonly events: readonly Row[];
}

async function readStore(read: StoreReader): Promise<StoreContents> {
  return {
    projects: await read('projects'),
    tasks: await read('tasks'),
    labels: await read('task_labels'),
    edges: await read('task_edges'),
    comments: await read('task_comments'),
    events: await read('task_events'),
  };
}

function parse(text: unknown): Json {
  return typeof text === 'string' ? (JSON.parse(text) as Json) : null;
}

/** The task as the store holds it, in the shape its history records. */
function storedState(task: Row, labels: readonly string[], edges: readonly Row[]): JsonObject {
  const closed = task.status === 'closed';
  return {
    id: task.id as string,
    projectId: task.project_id as string,
    parentId: (task.parent_id ?? null) as string | null,
    type: task.type as string,
    awaitType: (task.await_type ?? null) as string | null,
    status: task.status as string,
    priority: Number(task.priority),
    title: task.title as string,
    description: task.description as string,
    acceptance: task.acceptance as string,
    assignee: (task.assignee ?? null) as string | null,
    assigneeModel: (task.assignee_model ?? null) as string | null,
    startedAt: (task.started_at ?? null) as string | null,
    deferUntil: (task.defer_until ?? null) as string | null,
    dueAt: (task.due_at ?? null) as string | null,
    choices: parse(task.choices),
    choice: parse(task.choice),
    metadata: parse(task.metadata),
    labels: [...labels].sort(),
    dependencies: sortLinks(
      edges.map((edge) => ({ taskId: edge.depends_on_id as string, type: edge.type as 'blocks' })),
    ) as unknown as Json,
    close: closed
      ? {
          at: task.closed_at as string,
          reason: (task.close_reason ?? null) as string | null,
          resolution: task.resolution as string,
          duplicateOf: (task.duplicate_of ?? null) as string | null,
          by: (task.closed_by ?? null) as string | null,
          model: (task.closed_model ?? null) as string | null,
        }
      : null,
    filedBy: (task.filed_by ?? null) as string | null,
    filedModel: (task.filed_model ?? null) as string | null,
  };
}

function compareSets(
  subject: string,
  what: string,
  expected: Iterable<string>,
  actual: Iterable<string>,
  out: Difference[],
) {
  const want = new Set(expected);
  const have = new Set(actual);
  for (const item of want) if (!have.has(item)) out.push({ subject, difference: `${what} ${item} is missing` });
  for (const item of have)
    if (!want.has(item)) out.push({ subject, difference: `${what} ${item} is not in the export` });
}

function groupRows(rows: readonly Row[], column: string): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = String(row[column]);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return groups;
}

/** Check 1: the database against the export's rows. */
function againstExport(
  data: BeadsExport,
  held: StoreContents,
  out: Difference[],
): { counts: StatusCount[]; approvals: number; decisions: number; frozenCards: number } {
  const counts: StatusCount[] = [];
  const tasksById = new Map(held.tasks.map((task) => [String(task.id), task]));
  const labelsByTask = groupRows(held.labels, 'task_id');
  const edgesByTask = groupRows(held.edges, 'task_id');
  const commentsById = new Map(held.comments.map((comment) => [String(comment.id), comment]));
  let approvals = 0;
  let decisions = 0;
  let frozenCards = 0;

  for (const task of held.tasks)
    if (!isTaskId(task.id))
      out.push({ subject: String(task.id), difference: 'its id is not a task id Ntasks accepts' });

  // Every project's parents, as the import reads them: a parent may be in another project.
  const parentOf = new Map<string, string>();
  for (const row of data.projects.flatMap((project) => project.rows.dependencies)) {
    if (textOf(row.type) === 'parent-child') parentOf.set(textOf(row.issue_id) ?? '', linkTarget(row) ?? '');
  }

  for (const project of data.projects) {
    const subject = `project ${project.key}`;
    const stored = held.projects.find((row) => row.id === project.id);
    if (stored === undefined) out.push({ subject, difference: `project ${project.id} is missing` });
    else if (stored.key !== project.key || stored.name !== project.name || stored.prefix !== project.prefix) {
      out.push({ subject, difference: 'its key, name or prefix differs' });
    }

    const expected = new Map<string, number>();
    for (const issue of project.rows.issues) {
      const status = textOf(issue.status) ?? '';
      expected.set(status, (expected.get(status) ?? 0) + 1);
    }
    const actual = new Map<string, number>();
    for (const task of held.tasks) {
      if (task.project_id === project.id) actual.set(String(task.status), (actual.get(String(task.status)) ?? 0) + 1);
    }
    for (const status of [...new Set([...expected.keys(), ...actual.keys()])].sort()) {
      const count = {
        project: project.key,
        status,
        expected: expected.get(status) ?? 0,
        actual: actual.get(status) ?? 0,
      };
      counts.push(count);
      if (count.expected !== count.actual)
        out.push({
          subject,
          difference: `${count.expected} tasks are ${status} in the export, ${count.actual} in the store`,
        });
    }
    compareSets(
      subject,
      'task',
      project.rows.issues.map((issue) => textOf(issue.id) ?? ''),
      held.tasks.filter((task) => task.project_id === project.id).map((task) => String(task.id)),
      out,
    );

    const linksByIssue = new Map<string, string[]>();
    for (const row of project.rows.dependencies) {
      const issueId = textOf(row.issue_id) ?? '';
      const type = textOf(row.type) ?? 'blocks';
      const target = linkTarget(row) ?? '';
      if (!IN_SCOPE_LINKS.has(type)) continue;
      // The import leaves out a parent's blocks link onto its own child.
      if (type === 'blocks' && parentOf.get(target) === issueId) continue;
      linksByIssue.set(issueId, [...(linksByIssue.get(issueId) ?? []), `${type} ${target}`]);
    }
    const labelsByIssue = new Map<string, string[]>();
    for (const row of project.rows.labels) {
      const issueId = textOf(row.issue_id) ?? '';
      labelsByIssue.set(issueId, [...(labelsByIssue.get(issueId) ?? []), textOf(row.label) ?? '']);
    }

    for (const issue of project.rows.issues) {
      const id = textOf(issue.id) ?? '';
      const task = tasksById.get(id);
      if (task === undefined) continue;
      const differ = (difference: string) => out.push({ subject: id, difference });
      const metadataValue = issue.metadata;
      const metadata: JsonObject = isJsonObject(metadataValue)
        ? metadataValue
        : typeof metadataValue === 'string' && metadataValue !== ''
          ? (JSON.parse(metadataValue) as JsonObject)
          : {};
      const storedMetadata = parse(task.metadata);

      // A Beads type Ntasks lacks arrives as another type, labelled with its own name.
      const beadsType = textOf(issue.issue_type) ?? '';
      const typeLabel = Object.hasOwn(TYPES_AS_LABELS, beadsType) ? beadsType : null;
      const expectedType = typeLabel === null ? beadsType : TYPES_AS_LABELS[typeLabel];
      if (task.type !== expectedType) differ(`its type is ${String(task.type)}, not ${expectedType ?? ''}`);
      if (task.title !== issue.title) differ('its title differs');
      compareSets(
        id,
        'label',
        [...(labelsByIssue.get(id) ?? []), ...(typeLabel === null ? [] : [typeLabel])],
        (labelsByTask.get(id) ?? []).map((row) => String(row.label)),
        out,
      );

      const links = linksByIssue.get(id) ?? [];
      const related = Array.isArray(metadata.noticeos_related_tasks) ? metadata.noticeos_related_tasks : [];
      for (const ref of related)
        if (isJsonObject(ref) && typeof ref.taskId === 'string') links.push(`related ${ref.taskId}`);
      const storedLinks = (edgesByTask.get(id) ?? []).map(
        (edge) => `${String(edge.type)} ${String(edge.depends_on_id)}`,
      );
      if (task.parent_id !== null && task.parent_id !== undefined)
        storedLinks.push(`parent-child ${String(task.parent_id)}`);
      compareSets(id, 'link', new Set(links), storedLinks, out);
      for (const edge of edgesByTask.get(id) ?? []) {
        if (!tasksById.has(String(edge.depends_on_id)))
          differ(`its link to ${String(edge.depends_on_id)} names no task`);
        if (edge.depends_on_id === id) differ('it links to itself');
      }

      if (textOf(issue.status) === 'closed') {
        if (task.closed_at !== timeOf(issue.closed_at))
          differ(`it closed at ${String(task.closed_at)}, not ${String(timeOf(issue.closed_at))}`);
        if ((task.close_reason ?? null) !== textOf(issue.close_reason)) differ('its close reason differs');
        if (typeof task.resolution !== 'string') differ('its close records no resolution');
      } else if (task.closed_at !== null && task.closed_at !== undefined) {
        differ('it is not closed but records a close');
      }

      if (task.type === 'gate') {
        approvals += 1;
        if ((task.await_type ?? null) !== textOf(issue.await_type))
          differ('its approval does not wait on the same answerer');
      }
      if (task.type === 'decision') decisions += 1;
      if (!sameJson(parse(task.choices), metadata.noticeos_choices ?? null)) differ('its choices differ');
      if (!sameJson(parse(task.choice), metadata.noticeos_choice ?? null)) differ('its recorded choice differs');
      if (!isEmpty(metadata.noticeos_card_shipped)) frozenCards += 1;
      for (const [key, value] of Object.entries(metadata)) {
        if ((COLUMN_METADATA_KEYS as readonly string[]).includes(key)) continue;
        const kept = isJsonObject(storedMetadata) ? storedMetadata[key] : undefined;
        if (!sameJson(kept, value)) differ(`its metadata key ${key} differs`);
      }
    }

    for (const row of project.rows.comments) {
      const id = textOf(row.id) ?? '';
      const comment = commentsById.get(id);
      const subject_ = textOf(row.issue_id) ?? '';
      if (comment === undefined) out.push({ subject: subject_, difference: `comment ${id} is missing` });
      else if (
        comment.task_id !== subject_ ||
        comment.author !== textOf(row.author) ||
        comment.text !== row.text ||
        comment.created_at !== timeOf(row.created_at)
      ) {
        out.push({ subject: subject_, difference: `comment ${id} differs` });
      }
    }
  }
  const exported = new Set(
    data.projects.flatMap((project) => project.rows.comments.map((row) => textOf(row.id) ?? '')),
  );
  for (const comment of held.comments) {
    if (!exported.has(String(comment.id)))
      out.push({ subject: String(comment.task_id), difference: `comment ${String(comment.id)} is not in the export` });
  }
  return { counts, approvals, decisions, frozenCards };
}

/** Compares one table's rows, matched by key: each row expected must be held with the same values, and no other. */
function compareRows(
  source: string,
  table: string,
  expected: readonly object[],
  actual: readonly Row[],
  keyOf: (row: Record<string, unknown>) => string,
  subjectOf: (row: Record<string, unknown>) => string,
  out: Difference[],
) {
  const want = new Map(expected.map((row) => [keyOf(row as Record<string, unknown>), row as Record<string, unknown>]));
  const have = new Map(actual.map((row) => [keyOf(row), row]));
  for (const [key, row] of want) {
    const stored = have.get(key);
    if (stored === undefined) {
      out.push({ subject: subjectOf(row), difference: `its ${table} row ${key} is missing` });
      continue;
    }
    const fields = Object.keys(row).filter((field) => !sameJson(row[field] ?? null, stored[field] ?? null));
    if (fields.length > 0)
      out.push({ subject: subjectOf(row), difference: `its ${table} row ${key} differs in ${fields.join(', ')}` });
  }
  for (const [key, row] of have)
    if (!want.has(key)) out.push({ subject: subjectOf(row), difference: `${table} row ${key} is not in ${source}` });
}

/** Check 2: every table against the import plan, row by row. */
function againstPlan(plan: ImportPlan, held: StoreContents, out: Difference[]) {
  const compare = (
    table: string,
    expected: readonly object[],
    actual: readonly Row[],
    keyOf: (row: Record<string, unknown>) => string,
    subjectOf: (row: Record<string, unknown>) => string,
  ) => compareRows('the plan', table, expected, actual, keyOf, subjectOf, out);
  const task = (row: Record<string, unknown>) => String(row.task_id);
  compare(
    'projects',
    plan.projects,
    held.projects,
    (row) => String(row.id),
    (row) => `project ${String(row.key)}`,
  );
  compare(
    'tasks',
    plan.tasks,
    held.tasks,
    (row) => String(row.id),
    (row) => String(row.id),
  );
  compare('task_labels', plan.task_labels, held.labels, (row) => `${String(row.task_id)} ${String(row.label)}`, task);
  compare(
    'task_edges',
    plan.task_edges,
    held.edges,
    (row) => `${String(row.task_id)} -> ${String(row.depends_on_id)}`,
    task,
  );
  compare('task_comments', plan.task_comments, held.comments, (row) => String(row.id), task);
  compare(
    'task_events',
    plan.task_events.map((event) => ({ ...event, changes: parse(event.changes) })),
    held.events.map((event) => ({ ...event, changes: parse(event.changes) })),
    (row) => String(row.seq),
    task,
  );
}

/** Check 3: each task's history, replayed, rebuilds the task. */
function againstHistory(held: StoreContents, out: Difference[]) {
  const eventsByTask = groupRows(held.events, 'task_id');
  const labelsByTask = groupRows(held.labels, 'task_id');
  const edgesByTask = groupRows(held.edges, 'task_id');
  const commentsByTask = groupRows(held.comments, 'task_id');
  for (const task of held.tasks) {
    const id = String(task.id);
    const differ = (difference: string) => out.push({ subject: id, difference });
    const events = eventsByTask.get(id) ?? [];
    const first = events[0];
    if (first === undefined || first.kind !== 'created' || Number(first.version) !== 1) {
      differ('its history does not start with its creation');
      continue;
    }
    let state: Record<string, Json> = { ...(parse(first.changes) as JsonObject) };
    let version = 1;
    const commented: Row[] = [];
    for (const event of events.slice(1)) {
      const changes = parse(event.changes) as JsonObject;
      if (event.kind === 'commented') {
        if (Number(event.version) !== version)
          differ(
            `its comment event at seq ${String(event.seq)} names version ${String(event.version)}, not ${version}`,
          );
        commented.push(event);
        continue;
      }
      version += 1;
      if (Number(event.version) !== version)
        differ(`its history skips from version ${version - 1} to ${String(event.version)}`);
      state = { ...state, ...changes };
    }
    if (Number(task.version) !== version)
      differ(`it is at version ${String(task.version)}, but its history has ${version} versions`);
    const stored = storedState(
      task,
      (labelsByTask.get(id) ?? []).map((row) => String(row.label)),
      edgesByTask.get(id) ?? [],
    );
    if (!sameJson(state, stored)) {
      const fields = Object.keys(stored).filter((field) => !sameJson(state[field] ?? null, stored[field] ?? null));
      differ(`its history does not rebuild it (${fields.join(', ')} differ)`);
    }
    const comments = new Map((commentsByTask.get(id) ?? []).map((row) => [String(row.id), row]));
    const named = new Set<string>();
    for (const event of commented) {
      const changes = parse(event.changes) as JsonObject;
      const comment = comments.get(String(changes.commentId));
      named.add(String(changes.commentId));
      if (comment === undefined || comment.text !== changes.text || comment.author !== event.actor) {
        differ(`its comment event at seq ${String(event.seq)} does not match comment ${String(changes.commentId)}`);
      }
    }
    for (const commentId of comments.keys())
      if (!named.has(commentId)) differ(`comment ${commentId} has no history event`);
  }
}

export async function verify(data: BeadsExport, plan: ImportPlan, read: StoreReader): Promise<VerifyReport> {
  const held = await readStore(read);
  const differences: Difference[] = [];
  const fromExport = againstExport(data, held, differences);
  againstPlan(plan, held, differences);
  againstHistory(held, differences);
  const unique = new Map(differences.map((difference) => [stableJson(difference), difference]));
  return {
    differences: [...unique.values()],
    counts: fromExport.counts,
    totals: {
      projects: held.projects.length,
      tasks: held.tasks.length,
      labels: held.labels.length,
      links: held.edges.length,
      comments: held.comments.length,
      events: held.events.length,
    },
    approvals: fromExport.approvals,
    decisions: fromExport.decisions,
    frozenCards: fromExport.frozenCards,
  };
}

export interface BackupReport {
  readonly differences: readonly Difference[];
  /** The rows the store holds, per table. */
  readonly rows: Readonly<Record<BackupTable, number>>;
  /** Tasks per project and status: in the backup, and in the store. */
  readonly counts: readonly StatusCount[];
}

/**
 * Compares a store with the backup it was restored from, row by row: every
 * table must hold exactly the backup's rows, with the same values. A backup
 * holds rows as the store keeps them, so nothing is mapped on the way.
 */
export async function verifyBackup(file: BackupFile, read: StoreReader): Promise<BackupReport> {
  const differences: Difference[] = [];
  const rows = {} as Record<BackupTable, number>;
  const held = {} as Record<BackupTable, readonly Row[]>;
  for (const table of BACKUP_TABLES) {
    held[table] = await read(table);
    rows[table] = held[table].length;
    const key = backupKey(table);
    compareRows(
      'the backup',
      table,
      file.tables[table],
      held[table],
      // JSON keeps the columns apart: joined with a separator, two keys could read the same.
      (row) => JSON.stringify(key.map((column) => row[column] ?? null)),
      (row) =>
        typeof row.task_id === 'string'
          ? row.task_id
          : table === 'tasks'
            ? String(row.id)
            : table === 'projects'
              ? `project ${String(row.key)}`
              : `retry record of ${String(row.principal)}`,
      differences,
    );
  }
  const keyOf = new Map(file.tables.projects.map((project) => [String(project.id), String(project.key)]));
  const tally = (tasks: readonly Row[]) => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      const at = `${keyOf.get(String(task.project_id)) ?? String(task.project_id)}\u0000${String(task.status)}`;
      counts.set(at, (counts.get(at) ?? 0) + 1);
    }
    return counts;
  };
  const expected = tally(file.tables.tasks);
  const actual = tally(held.tasks);
  const counts = [...new Set([...expected.keys(), ...actual.keys()])].sort().map((at) => {
    const [project = '', status = ''] = at.split('\u0000');
    return { project, status, expected: expected.get(at) ?? 0, actual: actual.get(at) ?? 0 };
  });
  return { differences, rows, counts };
}
