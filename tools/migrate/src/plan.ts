/**
 * The import plan: every row the import writes, worked out from an export
 * file, or the refusals that stop it. Nothing is written unless the whole
 * export maps, so an import is complete or does not happen.
 */
import type {
  CommentRow,
  DependencyType,
  EdgeRow,
  EventRow,
  ExternalLinkRow,
  LabelRow,
  ProjectRow,
  StoreRows,
  TaskRow,
} from '@ntasks/domain';
import { isEmpty, textOf, timeOf, type BeadsExport, type BeadsProject } from './beads.ts';
import {
  projectComments,
  projectHistory,
  sharesSecond,
  taskEvents,
  type CommentRecord,
  type EventRecord,
  type TaskHistory,
  type Version,
} from './history.ts';
import { sameJson, stableJson } from './json.ts';
import { linkTarget, linkTypeOf, webAddress, type TaskState } from './task-state.ts';

/** Data the import leaves out by the owner's choice, reported so nothing goes unseen. */
export interface LeftOut {
  /** A task id, or "project <key>". */
  readonly subject: string;
  readonly what: string;
}

export interface Refusal {
  /** A task id, or "project <key>" for what no single task owns. */
  readonly subject: string;
  readonly reason: string;
}

/** Every row the import writes, in the task store's tables. */
export type ImportPlan = StoreRows;

/** Tables Beads keeps for its own bookkeeping, with no task data the import needs. */
const BOOKKEEPING_TABLES = new Set([
  'config',
  'metadata',
  'schema_migrations',
  'ignored_schema_migrations',
  'local_metadata',
  'child_counters',
  'dirty_issues',
  'export_hashes',
  'repo_mtimes',
  // The counter Beads numbers its audit log's entries from.
  'bd_events_seq',
]);
const READ_TABLES = new Set(['issues', 'labels', 'dependencies', 'comments', 'events']);
/** Why a table that holds rows belongs to something out of scope. */
const OUT_OF_SCOPE_TABLES: Readonly<Record<string, string>> = {
  wisps: 'wisps are out of scope',
  wisp_labels: 'wisps are out of scope',
  wisp_dependencies: 'wisps are out of scope',
  wisp_comments: 'wisps are out of scope',
  wisp_events: 'wisps are out of scope',
  issue_snapshots: 'Beads compacted tasks, and their original text is in these snapshots',
  compaction_snapshots: 'Beads compacted tasks, and their original text is in these snapshots',
};

/** Tables whose rows the owner chose to leave out, and why. */
const LEFT_OUT_TABLES: Readonly<Record<string, string>> = {
  leases: 'they record when a claim expires; Ntasks never expires a claim, and the claim itself is the assignee',
};

const PREFIX = /^[a-z0-9]{1,32}$/u;

function projectRefusals(project: BeadsProject): string[] {
  const reasons: string[] = [];
  if (!PREFIX.test(project.prefix))
    reasons.push(
      `its prefix "${project.prefix}" is not 1 to 32 lowercase letters and digits; prefixes with hyphens are out of scope`,
    );
  if (project.id.length < 1 || project.id.length > 128)
    reasons.push('its project id is empty or longer than 128 characters');
  if (project.key.length < 1 || project.key.length > 128)
    reasons.push('its key is empty or longer than 128 characters');
  if (project.name.length < 1 || project.name.length > 128)
    reasons.push('its name is empty or longer than 128 characters');
  if (project.branches.length > 1) {
    const names = project.branches.map((row) => textOf(row.name) ?? '').join(', ');
    reasons.push(
      `its database has ${project.branches.length} Dolt branches (${names}); branches are out of scope, and the export reads only one`,
    );
  }
  for (const table of project.tables) {
    if (table.rows === 0 || READ_TABLES.has(table.name) || BOOKKEEPING_TABLES.has(table.name)) continue;
    if (Object.hasOwn(LEFT_OUT_TABLES, table.name)) continue;
    const scope = OUT_OF_SCOPE_TABLES[table.name];
    reasons.push(
      `its table ${table.name} holds ${table.rows} rows: ${scope ?? 'the import does not know what it holds'}`,
    );
  }
  return reasons;
}

/**
 * The history without the task's `blocks` links onto `children`, in every
 * version, and without the versions that only added or removed them.
 */
function withoutBlocks(history: TaskHistory, children: ReadonlySet<string>): TaskHistory {
  const strip = (state: TaskState): TaskState => ({
    ...state,
    dependencies: state.dependencies.filter((link) => !(link.type === 'blocks' && children.has(link.taskId))),
  });
  // Shared seconds are counted before any version is left out, so a kept version
  // is never matched to the audit entry of one that is gone.
  const shared = sharesSecond(history.versions, history.current.createdAt ?? history.versions[0]?.at ?? '');
  const versions: Version[] = [];
  for (const [index, version] of history.versions.entries()) {
    const next: Version = { ...version, state: strip(version.state), ...(shared[index] ? { crowded: true } : {}) };
    const last = versions.at(-1);
    if (last === undefined || !sameJson(last.state, next.state)) versions.push(next);
  }
  const state = history.current.state;
  return { ...history, current: { ...history.current, state: state === null ? null : strip(state) }, versions };
}

/** Orders tasks so a parent and a duplicate's original come before the tasks naming them; null when they form a loop. */
function insertOrder(states: ReadonlyMap<string, TaskState>): string[] | null {
  const order: string[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (placed.has(id)) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    const state = states.get(id);
    for (const before of [state?.parentId, state?.close?.duplicateOf]) {
      if (before !== null && before !== undefined && states.has(before) && !visit(before)) return false;
    }
    visiting.delete(id);
    placed.add(id);
    order.push(id);
    return true;
  };
  for (const id of [...states.keys()].sort()) if (!visit(id)) return null;
  return order;
}

/** Tasks caught in a loop of `blocks` links or parents: Ntasks refuses a write that would make one. */
function waitingLoops(states: ReadonlyMap<string, TaskState>): string[] {
  const waitsOn = (state: TaskState) => [
    ...state.dependencies.filter((link) => link.type === 'blocks').map((link) => link.taskId),
    ...(state.parentId === null ? [] : [state.parentId]),
  ];
  const done = new Set<string>();
  const onPath = new Set<string>();
  const looped = new Set<string>();
  const visit = (id: string, path: string[]) => {
    if (done.has(id)) return;
    if (onPath.has(id)) {
      for (const member of path.slice(path.indexOf(id))) looped.add(member);
      return;
    }
    const state = states.get(id);
    if (state === undefined) return;
    onPath.add(id);
    path.push(id);
    for (const next of waitsOn(state)) visit(next, path);
    path.pop();
    onPath.delete(id);
    done.add(id);
  };
  for (const id of [...states.keys()].sort()) visit(id, []);
  return [...looped].sort();
}

function taskRow(state: TaskState, version: number, createdAt: string, updatedAt: string): TaskRow {
  const close = state.close;
  return {
    id: state.id,
    project_id: state.projectId,
    parent_id: state.parentId,
    type: state.type,
    await_type: state.awaitType,
    status: state.status,
    priority: state.priority,
    title: state.title,
    description: state.description,
    acceptance: state.acceptance,
    notes: state.notes,
    design: state.design,
    estimate_minutes: state.estimateMinutes,
    field_values: JSON.stringify(state.fields),
    assignee: state.assignee,
    assignee_model: state.assigneeModel,
    defer_until: state.deferUntil,
    due_at: state.dueAt,
    choices: state.choices === null ? null : JSON.stringify(state.choices),
    choice: state.choice === null ? null : JSON.stringify(state.choice),
    metadata: JSON.stringify(state.metadata),
    filed_by: state.filedBy,
    filed_model: state.filedModel,
    close_reason: close?.reason ?? null,
    resolution: close?.resolution ?? null,
    duplicate_of: close?.duplicateOf ?? null,
    closed_by: close?.by ?? null,
    closed_model: close?.model ?? null,
    version,
    created_at: createdAt,
    updated_at: updatedAt,
    started_at: state.startedAt,
    closed_at: close?.at ?? null,
  };
}

/** When something the task has now first appeared in the run of versions that still holds it. */
function heldSince(history: TaskHistory, holds: (state: TaskState) => boolean, createdAt: string): string {
  let since = createdAt;
  for (let index = history.versions.length - 1; index >= 0; index -= 1) {
    const version = history.versions[index]!;
    if (!holds(version.state)) break;
    since = index === 0 ? createdAt : version.at;
  }
  return since;
}

function linkSince(history: TaskHistory, taskId: string, type: DependencyType, createdAt: string): string {
  return heldSince(
    history,
    (state) => state.dependencies.some((link) => link.taskId === taskId && link.type === type),
    createdAt,
  );
}

/**
 * Merges each task's events into one sequence by time, never reordering one
 * task's events: an event sorts at its own time or its task's previous
 * event's, whichever is later.
 */
function sequence(perTask: readonly EventRecord[][]): EventRecord[] {
  const keyed = perTask.flatMap((events, task) => {
    let key = '';
    return events.map((event, position) => {
      key = event.at > key ? event.at : key;
      return { event, key, task, position };
    });
  });
  keyed.sort((a, b) => (a.key !== b.key ? (a.key < b.key ? -1 : 1) : a.task - b.task || a.position - b.position));
  return keyed.map((entry) => entry.event);
}

export function planImport(data: BeadsExport): {
  readonly plan: ImportPlan | null;
  readonly refusals: readonly Refusal[];
  readonly leftOut: readonly LeftOut[];
} {
  const leftOut: LeftOut[] = [];
  const refusals: Refusal[] = [];
  const refuse = (subject: string, reason: string) => refusals.push({ subject, reason });
  const projectOf = new Map<string, string>();
  const histories = new Map<string, TaskHistory>();
  const commentsByTask = new Map<string, CommentRecord[]>();
  const auditByTask = new Map<string, BeadsProject['rows']['events'][number][]>();
  const projects: ProjectRow[] = [];

  const seen = {
    id: new Set<string>(),
    key: new Set<string>(),
    prefix: new Set<string>(),
    database: new Set<string>(),
  };
  for (const project of data.projects) {
    const subject = `project ${project.key}`;
    for (const reason of projectRefusals(project)) refuse(subject, reason);
    for (const [field, value] of [
      ['id', project.id],
      ['key', project.key],
      ['prefix', project.prefix],
      ['database', project.database],
    ] as const) {
      if (seen[field].has(value)) refuse(subject, `another project in the export has the same ${field}, ${value}`);
      seen[field].add(value);
    }
    const history = projectHistory(project);
    for (const reason of history.problems) refuse(subject, reason);
    const comments = projectComments(project);
    for (const [taskId, reasons] of comments.problems) for (const reason of reasons) refuse(taskId, reason);
    for (const taskId of comments.byTask.keys()) {
      if (!history.tasks.has(taskId)) refuse(subject, `comments name ${taskId}, which is not one of its issues`);
    }
    for (const row of project.rows.events) {
      const taskId = textOf(row.issue_id);
      if (taskId === null) continue;
      const list = auditByTask.get(taskId) ?? [];
      list.push(row);
      auditByTask.set(taskId, list);
    }
    const times: string[] = [];
    for (const [taskId, history_] of history.tasks) {
      if (projectOf.has(taskId)) refuse(taskId, 'two projects in the export hold a task with this id');
      projectOf.set(taskId, project.id);
      histories.set(taskId, history_);
      commentsByTask.set(taskId, comments.byTask.get(taskId) ?? []);
      if (history_.current.createdAt !== null) times.push(history_.current.createdAt);
    }
    for (const row of project.commits) {
      const at = timeOf(row.date);
      if (typeof at === 'string') times.push(at);
    }
    times.sort();
    projects.push({
      id: project.id,
      key: project.key,
      name: project.name,
      prefix: project.prefix,
      created_at: times[0] ?? data.exportedAt,
    });
  }

  // A parent's blocks link onto its own child makes each wait on the other: the
  // parent waits on the child, and the child is held while its parent waits.
  // The owner chose to leave such links out; any other loop is still refused.
  const parentOf = new Map(
    [...histories].map(([taskId, history]) => [taskId, history.current.state?.parentId ?? null]),
  );
  for (const [taskId, history] of [...histories]) {
    const children = (history.current.state?.dependencies ?? [])
      .filter((link) => link.type === 'blocks' && parentOf.get(link.taskId) === taskId)
      .map((link) => link.taskId);
    if (children.length === 0) continue;
    histories.set(taskId, withoutBlocks(history, new Set(children)));
    for (const child of children)
      leftOut.push({ subject: taskId, what: `its blocks link onto its own child ${child}` });
  }
  for (const project of data.projects) {
    for (const table of project.tables) {
      const why = Object.hasOwn(LEFT_OUT_TABLES, table.name) ? LEFT_OUT_TABLES[table.name] : undefined;
      if (why !== undefined && table.rows > 0)
        leftOut.push({ subject: `project ${project.key}`, what: `${table.rows} rows of ${table.name}: ${why}` });
    }
  }

  const states = new Map<string, TaskState>();
  for (const [taskId, history] of histories) {
    for (const reason of history.problems) refuse(taskId, reason);
    const state = history.current.state;
    if (state === null) continue;
    states.set(taskId, state);
    const named: [string, string][] = [
      ...(state.parentId === null ? [] : [[state.parentId, 'its parent'] as [string, string]]),
      ...(state.close?.duplicateOf ? [[state.close.duplicateOf, 'the task it duplicates'] as [string, string]] : []),
      ...state.dependencies.map((link): [string, string] => [link.taskId, `its ${link.type} link`]),
    ];
    for (const [other, what] of named) {
      if (!projectOf.has(other)) refuse(taskId, `${what} names ${other}, which is not a task in the export`);
    }
    for (const ref of history.current.relatedRefs) {
      const actual = projectOf.get(ref.taskId);
      if (actual !== undefined && actual !== ref.projectId)
        refuse(
          taskId,
          `its related task ${ref.taskId} is named with project ${ref.projectId}, but that task is in project ${actual}`,
        );
    }
  }
  for (const taskId of waitingLoops(states))
    refuse(taskId, 'it is in a loop of tasks that wait on each other through blocks links or parents');
  const order = insertOrder(states);
  if (order === null) refuse('export', 'parents and duplicates form a loop');
  if (refusals.length > 0 || order === null) return { plan: null, refusals: sortRefusals(refusals), leftOut };

  const tasks: TaskRow[] = [];
  const labels: LabelRow[] = [];
  const edges: EdgeRow[] = [];
  const externalLinks: ExternalLinkRow[] = [];
  const comments: CommentRow[] = [];
  const perTask: EventRecord[][] = [];
  for (const taskId of order) {
    const history = histories.get(taskId)!;
    const state = states.get(taskId)!;
    const createdAt = history.current.createdAt!;
    const events = taskEvents(history, createdAt, commentsByTask.get(taskId) ?? [], auditByTask.get(taskId) ?? []);
    perTask.push(events);
    tasks.push(taskRow(state, history.versions.length, createdAt, history.current.updatedAt ?? createdAt));
    for (const label of state.labels) labels.push({ task_id: taskId, label });
    // Keyed by target and type, so a parent link never dates a link of another type to the same task.
    const linkRows = new Map<string, { at: string | null; by: string | null }>();
    const externalRows = new Map<string, { at: string | null; by: string | null }>();
    for (const row of history.links) {
      const target = linkTarget(row);
      const external = textOf(row.depends_on_external);
      const made = { at: timeOf(row.created_at) ?? null, by: isEmpty(row.created_by) ? null : textOf(row.created_by) };
      if (target !== null) linkRows.set(`${target} ${linkTypeOf(row)}`, made);
      else if (external !== null) {
        const url = webAddress(external);
        if (url !== null) externalRows.set(url, made);
      }
    }
    for (const link of state.dependencies) {
      const row = linkRows.get(`${link.taskId} ${link.type}`);
      edges.push({
        task_id: taskId,
        depends_on_id: link.taskId,
        type: link.type,
        created_at: row?.at ?? linkSince(history, link.taskId, link.type, createdAt),
        created_by: row?.by ?? null,
      });
    }
    for (const link of state.externalLinks) {
      const row = externalRows.get(link.url);
      externalLinks.push({
        task_id: taskId,
        url: link.url,
        title: link.title,
        kind: link.kind,
        created_at:
          row?.at ??
          heldSince(history, (held) => held.externalLinks.some((other) => other.url === link.url), createdAt),
        created_by: row?.by ?? null,
      });
    }
    for (const comment of commentsByTask.get(taskId) ?? []) {
      comments.push({
        id: comment.id,
        task_id: taskId,
        author: comment.author,
        text: comment.text,
        created_at: comment.createdAt,
      });
    }
  }
  const events = sequence(perTask).map((event, index): EventRow => ({
    seq: index + 1,
    task_id: event.taskId,
    project_id: event.projectId,
    version: event.version,
    kind: event.kind,
    actor: event.actor,
    model: event.model,
    at: event.at,
    changes: JSON.stringify(event.changes),
  }));
  return {
    plan: {
      projects,
      tasks,
      task_labels: labels,
      task_edges: edges,
      task_external_links: externalLinks,
      task_comments: comments,
      task_events: events,
    },
    refusals: [],
    leftOut,
  };
}

function sortRefusals(refusals: readonly Refusal[]): Refusal[] {
  const unique = new Map(refusals.map((refusal) => [stableJson(refusal), refusal]));
  return [...unique.values()].sort((a, b) => a.subject.localeCompare(b.subject) || a.reason.localeCompare(b.reason));
}
