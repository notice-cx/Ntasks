/**
 * Each task's history, rebuilt from Dolt's record of every change.
 *
 * Beads keeps a task in three tables: the issue row, its label rows and its
 * link rows. `dolt_diff_<table>` lists every change to a table, commit by
 * commit. Replaying those changes in commit order gives every state each task
 * passed through; each state that differs from the one before is a version of
 * the task. The last version must equal the task as it stands now, or the
 * task is refused: a history that does not rebuild the task cannot be trusted.
 */
import type { Json, JsonObject, TaskEventKind } from '@ntasks/domain';
import { textOf, timeOf, type BeadsProject, type BeadsRow } from './beads.ts';
import { excerpt, sameJson, stableJson } from './json.ts';
import { mapTask, unmappedProblems, linkTarget, type MappedTask, type TaskState } from './task-state.ts';

/** One version of a task: the state a commit left it in. */
export interface Version {
  readonly state: TaskState;
  readonly at: string;
  /** Who Dolt recorded as making the commit; null for a change not yet committed. */
  readonly committer: string | null;
  /** Another version of the task fell in the same second, though it has since been left out. */
  readonly crowded?: true;
}

export interface TaskHistory {
  readonly id: string;
  readonly current: MappedTask;
  /** The link rows that start at the task now. */
  readonly links: readonly BeadsRow[];
  /** Oldest first. */
  readonly versions: readonly Version[];
  readonly problems: readonly string[];
}

export interface ProjectHistory {
  readonly tasks: ReadonlyMap<string, TaskHistory>;
  /** Problems with the project's data that no single task owns. */
  readonly problems: readonly string[];
}

/** One history event, as `task_events` stores it, before its sequence number is given. */
export interface EventRecord {
  readonly taskId: string;
  readonly projectId: string;
  readonly version: number;
  readonly kind: TaskEventKind;
  readonly actor: string;
  readonly model: string | null;
  readonly at: string;
  readonly changes: JsonObject;
}

export interface CommentRecord {
  readonly id: string;
  readonly taskId: string;
  readonly author: string;
  readonly text: string;
  readonly createdAt: string;
}

const COMMENT_COLUMNS = new Set(['id', 'issue_id', 'author', 'text', 'created_at']);
/** The actor of a history event whose actor Beads did not record. */
export const UNKNOWN_ACTOR = 'unknown';

/** The two sides of a `dolt_diff_<table>` row: the row before the change and after it. */
function sides(diff: BeadsRow): { readonly from: BeadsRow | null; readonly to: BeadsRow | null } {
  const from: Record<string, Json> = {};
  const to: Record<string, Json> = {};
  for (const [column, value] of Object.entries(diff)) {
    if (
      column === 'from_commit' ||
      column === 'from_commit_date' ||
      column === 'to_commit' ||
      column === 'to_commit_date'
    )
      continue;
    if (column.startsWith('from_')) from[column.slice('from_'.length)] = value;
    else if (column.startsWith('to_')) to[column.slice('to_'.length)] = value;
  }
  const kind = diff.diff_type;
  return { from: kind === 'added' ? null : from, to: kind === 'removed' ? null : to };
}

function linkKey(row: BeadsRow): string {
  return stableJson([
    linkTarget(row),
    textOf(row.depends_on_wisp_id),
    textOf(row.depends_on_external),
    textOf(row.type),
  ]);
}

function groupBy(rows: readonly BeadsRow[], column: string): Map<string, BeadsRow[]> {
  const groups = new Map<string, BeadsRow[]>();
  for (const row of rows) {
    const key = textOf(row[column]);
    if (key === null) continue;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  return groups;
}

/** The fields of `next` that differ from `previous`. */
export function changedFields(previous: TaskState, next: TaskState): JsonObject {
  const changes: Record<string, Json> = {};
  for (const [field, value] of Object.entries(next) as [keyof TaskState, Json][]) {
    if (!sameJson(previous[field], value)) changes[field] = value;
  }
  return changes;
}

interface Commit {
  readonly order: number;
  readonly at: string | null;
  readonly committer: string | null;
}

export function projectHistory(project: BeadsProject): ProjectHistory {
  const projectProblems: string[] = [];
  const taskProblems = new Map<string, Set<string>>();
  const problem = (taskId: string, message: string) => {
    const set = taskProblems.get(taskId) ?? new Set<string>();
    set.add(message);
    taskProblems.set(taskId, set);
  };

  // dolt_log lists the newest commit first; changes not yet committed come after every commit.
  const commits = new Map<string, Commit>();
  const log = [...project.commits].reverse();
  log.forEach((row, index) => {
    const hash = textOf(row.commit_hash);
    if (hash !== null)
      commits.set(hash, { order: index, at: timeOf(row.date) ?? null, committer: textOf(row.committer) });
  });
  commits.set('STAGED', { order: log.length, at: null, committer: null });
  commits.set('WORKING', { order: log.length + 1, at: null, committer: null });

  type Change = {
    readonly table: 'issues' | 'labels' | 'dependencies';
    readonly from: BeadsRow | null;
    readonly to: BeadsRow | null;
  };
  const changesByCommit = new Map<string, { commit: Commit; date: string | null; changes: Change[] }>();
  for (const table of ['issues', 'labels', 'dependencies'] as const) {
    for (const diff of project.diffs[table]) {
      const hash = textOf(diff.to_commit) ?? '';
      const commit = commits.get(hash);
      if (commit === undefined) {
        projectProblems.push(
          `its Dolt history has a change in commit "${excerpt(hash)}", which is not on the branch the hub reads`,
        );
        continue;
      }
      const group = changesByCommit.get(hash) ?? { commit, date: timeOf(diff.to_commit_date) ?? null, changes: [] };
      group.changes.push({ table, ...sides(diff) });
      changesByCommit.set(hash, group);
    }
  }

  const issues = new Map<string, BeadsRow>();
  const labels = new Map<string, Map<string, BeadsRow>>();
  const links = new Map<string, Map<string, BeadsRow>>();
  const versions = new Map<string, Version[]>();
  const historyProblems = new Map<string, Map<string, string>>();
  const rowsOf = (map: Map<string, Map<string, BeadsRow>>, id: string) => [...(map.get(id)?.values() ?? [])];

  for (const { commit, date, changes } of [...changesByCommit.values()].sort(
    (a, b) => a.commit.order - b.commit.order,
  )) {
    const touched = new Set<string>();
    for (const { table, from, to } of changes) {
      if (table === 'issues') {
        const fromId = from === null ? null : textOf(from.id);
        const toId = to === null ? null : textOf(to.id);
        if (fromId !== null && toId !== null && fromId !== toId) {
          problem(toId, `its id changed from ${fromId} in Dolt history, and Ntasks keeps a task's id`);
        }
        if (fromId !== null) {
          issues.delete(fromId);
          touched.add(fromId);
        }
        if (toId !== null && to !== null) {
          issues.set(toId, to);
          touched.add(toId);
        }
        continue;
      }
      const map = table === 'labels' ? labels : links;
      const keyOf = table === 'labels' ? (row: BeadsRow) => textOf(row.label) ?? '' : linkKey;
      for (const [row, present] of [
        [from, false],
        [to, true],
      ] as const) {
        if (row === null) continue;
        const issueId = textOf(row.issue_id);
        if (issueId === null) continue;
        const rowsOfIssue = map.get(issueId) ?? new Map<string, BeadsRow>();
        if (present) rowsOfIssue.set(keyOf(row), row);
        else rowsOfIssue.delete(keyOf(row));
        map.set(issueId, rowsOfIssue);
        touched.add(issueId);
      }
    }
    for (const id of touched) {
      const issue = issues.get(id);
      if (issue === undefined) continue;
      const mapped = mapTask({
        issue,
        labels: rowsOf(labels, id),
        links: rowsOf(links, id),
        projectId: project.id,
        prefix: project.prefix,
      });
      const at = commit.at ?? date ?? mapped.updatedAt;
      if (mapped.state === null || at === null) {
        const found = historyProblems.get(id) ?? new Map<string, string>();
        for (const message of mapped.problems) found.set(message, at ?? 'an unknown time');
        historyProblems.set(id, found);
        continue;
      }
      if (mapped.problems.length > 0) {
        const found = historyProblems.get(id) ?? new Map<string, string>();
        for (const message of mapped.problems) if (!found.has(message)) found.set(message, at);
        historyProblems.set(id, found);
      }
      const list = versions.get(id) ?? [];
      const last = list.at(-1);
      if (last === undefined || !sameJson(last.state, mapped.state))
        list.push({ state: mapped.state, at, committer: commit.committer });
      versions.set(id, list);
    }
  }

  const currentLabels = groupBy(project.rows.labels, 'issue_id');
  const currentLinks = groupBy(project.rows.dependencies, 'issue_id');
  const tasks = new Map<string, TaskHistory>();
  for (const issue of project.rows.issues) {
    const id = textOf(issue.id) ?? '';
    const current = mapTask({
      issue,
      labels: currentLabels.get(id) ?? [],
      links: currentLinks.get(id) ?? [],
      projectId: project.id,
      prefix: project.prefix,
    });
    const problems = [...current.problems, ...(taskProblems.get(id) ?? [])];
    for (const [message, at] of historyProblems.get(id) ?? []) {
      if (!current.problems.includes(message)) problems.push(`${message} (in its history, at ${at})`);
    }
    const list = versions.get(id) ?? [];
    const last = list.at(-1);
    if (current.state !== null) {
      if (last === undefined) problems.push('its Dolt history holds no version of it');
      else if (!sameJson(last.state, current.state)) {
        const fields = Object.keys(changedFields(last.state, current.state)).join(', ');
        problems.push(`its Dolt history does not rebuild it as it stands now (${fields} differ)`);
      }
    }
    if (tasks.has(id)) projectProblems.push(`it holds two issues with the id ${id}`);
    tasks.set(id, { id, current, links: currentLinks.get(id) ?? [], versions: list, problems });
  }
  for (const [table, groups] of [
    ['label', currentLabels],
    ['link', currentLinks],
  ] as const) {
    for (const issueId of groups.keys()) {
      if (!tasks.has(issueId)) projectProblems.push(`${table} rows name ${issueId}, which is not one of its issues`);
    }
  }
  return { tasks, problems: projectProblems };
}

/** The project's comments by task, with the problems that refuse them. */
export function projectComments(project: BeadsProject): {
  readonly byTask: Map<string, CommentRecord[]>;
  readonly problems: Map<string, string[]>;
} {
  const byTask = new Map<string, CommentRecord[]>();
  const problems = new Map<string, string[]>();
  for (const row of project.rows.comments) {
    const taskId = textOf(row.issue_id) ?? '';
    const found: string[] = unmappedProblems(row, COMMENT_COLUMNS, new Set(), 'a comment');
    const id = textOf(row.id);
    const author = textOf(row.author);
    const text = typeof row.text === 'string' ? row.text : '';
    const createdAt = timeOf(row.created_at);
    if (id === null) found.push('a comment has no id');
    if (author === null || author.length > 255)
      found.push(`a comment's author "${excerpt(row.author)}" is empty or longer than 255 characters`);
    if (text === '' || text.includes('\u0000')) found.push(`comment ${id ?? ''} is empty or holds a NUL character`);
    if (createdAt === undefined || createdAt === null) found.push(`comment ${id ?? ''} has no time`);
    if (found.length > 0) {
      problems.set(taskId, [...(problems.get(taskId) ?? []), ...found]);
      continue;
    }
    const list = byTask.get(taskId) ?? [];
    list.push({ id: id ?? '', taskId, author: author ?? '', text, createdAt: createdAt ?? '' });
    byTask.set(taskId, list);
  }
  for (const list of byTask.values())
    list.sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1));
  return { byTask, problems };
}

function second(at: string): number {
  return Math.floor(Date.parse(at) / 1000);
}

/**
 * Whether each version shares its second with another version of the task,
 * the first timed at the task's creation. An audit entry from that second
 * cannot then be told apart, so such a version keeps its committer.
 */
export function sharesSecond(versions: readonly Version[], createdAt: string): boolean[] {
  const timeOfVersion = (index: number, version: Version) => (index === 0 ? createdAt : version.at);
  const counts = new Map<number, number>();
  versions.forEach((version, index) => {
    const key = second(timeOfVersion(index, version));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return versions.map(
    (version, index) => version.crowded === true || (counts.get(second(timeOfVersion(index, version))) ?? 0) > 1,
  );
}

/**
 * A task's history events: one per version, then one per comment placed by
 * time. A version's actor is the one Beads' audit log names for that task in
 * the same second, when exactly one does and no other version of the task
 * falls in that second; otherwise the commit's committer.
 * A model is known only where NoticeOS recorded it: the filer's, the
 * claimer's and the closer's.
 */
export function taskEvents(
  history: TaskHistory,
  createdAt: string,
  comments: readonly CommentRecord[],
  audit: readonly BeadsRow[],
): EventRecord[] {
  const actorsBySecond = new Map<number, Set<string>>();
  for (const row of audit) {
    const at = timeOf(row.created_at);
    const actor = textOf(row.actor);
    // A comment's audit entry names the comment's author, who did not make a version.
    if (typeof at !== 'string' || actor === null || row.event_type === 'commented') continue;
    const set = actorsBySecond.get(second(at)) ?? new Set<string>();
    set.add(actor);
    actorsBySecond.set(second(at), set);
  }
  const timeOfVersion = (index: number, version: Version) => (index === 0 ? createdAt : version.at);
  const shared = sharesSecond(history.versions, createdAt);

  const states: EventRecord[] = history.versions.map((version, index) => {
    const at = timeOfVersion(index, version);
    const candidates = shared[index] ? undefined : actorsBySecond.get(second(at));
    const actor = candidates?.size === 1 ? [...candidates][0]! : (version.committer ?? UNKNOWN_ACTOR);
    const previous = index === 0 ? null : history.versions[index - 1]!.state;
    const next = version.state;
    let kind: TaskEventKind = 'updated';
    if (previous === null) kind = 'created';
    else if (previous.status !== 'closed' && next.status === 'closed') kind = 'closed';
    else if (previous.status === 'closed' && next.status !== 'closed') kind = 'reopened';
    const changes = previous === null ? (next as unknown as JsonObject) : changedFields(previous, next);
    let model: string | null = null;
    if (kind === 'created' && actor === next.filedBy) model = next.filedModel;
    else if ('assignee' in changes && next.assignee === actor) model = next.assigneeModel;
    else if ('close' in changes && next.close?.by === actor) model = next.close.model;
    return { taskId: next.id, projectId: next.projectId, version: index + 1, kind, actor, model, at, changes };
  });

  // Comments go between versions by time; one at the same time as a version follows it.
  const events: EventRecord[] = [];
  let next = 0;
  for (const state of states) {
    while (next < comments.length && comments[next]!.createdAt < state.at && events.length > 0) {
      events.push(commentEvent(comments[next]!, events.at(-1)!));
      next += 1;
    }
    events.push(state);
  }
  for (; next < comments.length; next += 1) {
    const last = events.at(-1);
    if (last !== undefined) events.push(commentEvent(comments[next]!, last));
  }
  return events;
}

function commentEvent(comment: CommentRecord, before: EventRecord): EventRecord {
  return {
    taskId: before.taskId,
    projectId: before.projectId,
    version: before.version,
    kind: 'commented',
    actor: comment.author,
    model: null,
    at: comment.createdAt,
    changes: { commentId: comment.id, text: comment.text },
  };
}
