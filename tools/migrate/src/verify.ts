/**
 * The verifier: compares a D1 database with the export it was imported from.
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
import { isTaskId } from '@ntasks/domain';
import type { Json, JsonObject } from '@ntasks/domain';
import { isEmpty, textOf, timeOf, type BeadsExport } from './beads.ts';
import type { Database, Row } from './d1.ts';
import { isJsonObject, sameJson, stableJson } from './json.ts';
import type { ImportPlan } from './plan.ts';
import { COLUMN_METADATA_KEYS, linkTarget, sortLinks } from './task-state.ts';

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

interface D1Contents {
  readonly projects: Row[];
  readonly tasks: Row[];
  readonly labels: Row[];
  readonly edges: Row[];
  readonly comments: Row[];
  readonly events: Row[];
}

async function readD1(db: Database): Promise<D1Contents> {
  return {
    projects: await db.all('SELECT id, key, name, prefix, created_at FROM projects ORDER BY id'),
    tasks: await db.all('SELECT * FROM tasks ORDER BY id'),
    labels: await db.all('SELECT task_id, label FROM task_labels ORDER BY task_id, label'),
    edges: await db.all(
      'SELECT task_id, depends_on_id, type, created_at, created_by FROM task_edges ORDER BY task_id, depends_on_id',
    ),
    comments: await db.all('SELECT id, task_id, author, text, created_at FROM task_comments ORDER BY id'),
    events: await db.all(
      'SELECT seq, task_id, project_id, version, kind, actor, model, at, changes FROM task_events ORDER BY seq',
    ),
  };
}

function parse(text: unknown): Json {
  return typeof text === 'string' ? (JSON.parse(text) as Json) : null;
}

/** The task as D1 holds it, in the shape its history records. */
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
  d1: D1Contents,
  out: Difference[],
): { counts: StatusCount[]; approvals: number; decisions: number; frozenCards: number } {
  const counts: StatusCount[] = [];
  const tasksById = new Map(d1.tasks.map((task) => [String(task.id), task]));
  const labelsByTask = groupRows(d1.labels, 'task_id');
  const edgesByTask = groupRows(d1.edges, 'task_id');
  const commentsById = new Map(d1.comments.map((comment) => [String(comment.id), comment]));
  let approvals = 0;
  let decisions = 0;
  let frozenCards = 0;

  for (const task of d1.tasks)
    if (!isTaskId(task.id))
      out.push({ subject: String(task.id), difference: 'its id is not a task id Ntasks accepts' });

  for (const project of data.projects) {
    const subject = `project ${project.key}`;
    const stored = d1.projects.find((row) => row.id === project.id);
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
    for (const task of d1.tasks) {
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
        out.push({ subject, difference: `${count.expected} tasks are ${status} in the export, ${count.actual} in D1` });
    }
    compareSets(
      subject,
      'task',
      project.rows.issues.map((issue) => textOf(issue.id) ?? ''),
      d1.tasks.filter((task) => task.project_id === project.id).map((task) => String(task.id)),
      out,
    );

    const linksByIssue = new Map<string, string[]>();
    for (const row of project.rows.dependencies) {
      const issueId = textOf(row.issue_id) ?? '';
      const type = textOf(row.type) ?? 'blocks';
      if (!IN_SCOPE_LINKS.has(type)) continue;
      linksByIssue.set(issueId, [...(linksByIssue.get(issueId) ?? []), `${type} ${linkTarget(row) ?? ''}`]);
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

      if (task.type !== textOf(issue.issue_type))
        differ(`its type is ${String(task.type)}, not ${textOf(issue.issue_type) ?? ''}`);
      if (task.title !== issue.title) differ('its title differs');
      compareSets(
        id,
        'label',
        labelsByIssue.get(id) ?? [],
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
  for (const comment of d1.comments) {
    if (!exported.has(String(comment.id)))
      out.push({ subject: String(comment.task_id), difference: `comment ${String(comment.id)} is not in the export` });
  }
  return { counts, approvals, decisions, frozenCards };
}

/** Check 2: every table against the import plan, row by row. */
function againstPlan(plan: ImportPlan, d1: D1Contents, out: Difference[]) {
  const compare = (
    table: string,
    expected: readonly object[],
    actual: readonly Row[],
    keyOf: (row: Record<string, unknown>) => string,
    subjectOf: (row: Record<string, unknown>) => string,
  ) => {
    const want = new Map(
      expected.map((row) => [keyOf(row as Record<string, unknown>), row as Record<string, unknown>]),
    );
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
      if (!want.has(key)) out.push({ subject: subjectOf(row), difference: `${table} row ${key} is not in the plan` });
  };
  const task = (row: Record<string, unknown>) => String(row.task_id);
  compare(
    'projects',
    plan.projects,
    d1.projects,
    (row) => String(row.id),
    (row) => `project ${String(row.key)}`,
  );
  compare(
    'tasks',
    plan.tasks,
    d1.tasks,
    (row) => String(row.id),
    (row) => String(row.id),
  );
  compare('task_labels', plan.labels, d1.labels, (row) => `${String(row.task_id)} ${String(row.label)}`, task);
  compare('task_edges', plan.edges, d1.edges, (row) => `${String(row.task_id)} -> ${String(row.depends_on_id)}`, task);
  compare('task_comments', plan.comments, d1.comments, (row) => String(row.id), task);
  compare(
    'task_events',
    plan.events.map((event) => ({ ...event, changes: parse(event.changes) })),
    d1.events.map((event) => ({ ...event, changes: parse(event.changes) })),
    (row) => String(row.seq),
    task,
  );
}

/** Check 3: each task's history, replayed, rebuilds the task. */
function againstHistory(d1: D1Contents, out: Difference[]) {
  const eventsByTask = groupRows(d1.events, 'task_id');
  const labelsByTask = groupRows(d1.labels, 'task_id');
  const edgesByTask = groupRows(d1.edges, 'task_id');
  const commentsByTask = groupRows(d1.comments, 'task_id');
  for (const task of d1.tasks) {
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

export async function verify(data: BeadsExport, plan: ImportPlan, db: Database): Promise<VerifyReport> {
  const d1 = await readD1(db);
  const differences: Difference[] = [];
  const fromExport = againstExport(data, d1, differences);
  againstPlan(plan, d1, differences);
  againstHistory(d1, differences);
  const unique = new Map(differences.map((difference) => [stableJson(difference), difference]));
  return {
    differences: [...unique.values()],
    counts: fromExport.counts,
    totals: {
      projects: d1.projects.length,
      tasks: d1.tasks.length,
      labels: d1.labels.length,
      links: d1.edges.length,
      comments: d1.comments.length,
      events: d1.events.length,
    },
    approvals: fromExport.approvals,
    decisions: fromExport.decisions,
    frozenCards: fromExport.frozenCards,
  };
}
