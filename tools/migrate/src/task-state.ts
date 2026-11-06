/**
 * One Beads issue, with its labels and links, as an Ntasks task. The rules
 * are docs/task-store.md's "Where NoticeOS's task metadata goes" and "Beads
 * behaviour in and out of scope"; tools/migrate/README.md lists each column.
 *
 * A task's state has exactly the fields the engine's `created` history event
 * records (workers/api/src/engine/writes.ts), so history built from states
 * reads like history the engine wrote.
 */
import { isDependencyType, isTaskId, isTaskResolution, isTaskStatus, isTaskType } from '@ntasks/domain';
import type { DependencyType, Json, JsonObject, TaskResolution, TaskStatus, TaskType } from '@ntasks/domain';
import { isEmpty, textOf, timeOf, type BeadsRow } from './beads.ts';
import { excerpt, isJsonObject } from './json.ts';

export interface LinkState {
  readonly taskId: string;
  readonly type: DependencyType;
}

export interface CloseState {
  readonly at: string;
  readonly reason: string | null;
  readonly resolution: TaskResolution;
  readonly duplicateOf: string | null;
  readonly by: string | null;
  readonly model: string | null;
}

export interface TaskState {
  readonly id: string;
  readonly projectId: string;
  readonly parentId: string | null;
  readonly type: TaskType;
  readonly awaitType: 'human' | null;
  readonly status: TaskStatus;
  readonly priority: number;
  readonly title: string;
  readonly description: string;
  readonly acceptance: string;
  readonly assignee: string | null;
  readonly assigneeModel: string | null;
  readonly startedAt: string | null;
  readonly deferUntil: string | null;
  readonly dueAt: string | null;
  readonly choices: JsonObject | null;
  readonly choice: JsonObject | null;
  readonly metadata: JsonObject;
  /** Sorted. */
  readonly labels: readonly string[];
  /** The tasks this one links to, sorted by id. */
  readonly dependencies: readonly LinkState[];
  readonly close: CloseState | null;
  readonly filedBy: string | null;
  readonly filedModel: string | null;
}

/** A task in another project that a task names in `noticeos_related_tasks`. */
export interface RelatedRef {
  readonly projectId: string;
  readonly taskId: string;
}

export interface MappedTask {
  /** Null when the issue cannot be read as a task at all. */
  readonly state: TaskState | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly relatedRefs: readonly RelatedRef[];
  /** Why the issue, as it stands, is refused. Empty when it maps fully. */
  readonly problems: readonly string[];
}

/** Issue columns the import reads. */
const ISSUE_COLUMNS = new Set([
  'id',
  'title',
  'description',
  'acceptance_criteria',
  'status',
  'priority',
  'issue_type',
  'assignee',
  'created_at',
  'created_by',
  'updated_at',
  'started_at',
  'closed_at',
  'close_reason',
  'await_type',
  'due_at',
  'defer_until',
  'metadata',
]);
/** Columns Beads computes from the others: nothing is lost by leaving them. */
const ISSUE_DERIVED = new Set(['content_hash', 'is_blocked']);
const LINK_COLUMNS = new Set(['issue_id', 'depends_on_issue_id', 'depends_on_id', 'type', 'created_at', 'created_by']);
/** A link's row id, which Beads numbers again whenever it migrates its schema. */
const LINK_DERIVED = new Set(['id']);
const LABEL_COLUMNS = new Set(['issue_id', 'label']);

/** Why a column that holds a value belongs to something out of scope. */
const OUT_OF_SCOPE_COLUMNS: Readonly<Record<string, string>> = {
  ephemeral: 'it is a wisp, and wisps are out of scope',
  wisp_type: 'it is a wisp, and wisps are out of scope',
  mol_type: 'molecules are out of scope',
  is_template: 'formulas and templates are out of scope',
  crystallizes: 'molecules are out of scope',
  await_id: 'only approvals a person answers are in scope',
  timeout_ns: 'only approvals a person answers are in scope',
  waiters: 'only approvals a person answers are in scope',
  compaction_level: 'Beads compacted it, so its original text is in a compaction snapshot',
  depends_on_wisp_id: 'it links to a wisp, and wisps are out of scope',
  depends_on_external: 'it links to a task outside the hub, and external links are out of scope',
};

/** NoticeOS metadata keys that are Ntasks columns or links; every other key stays in metadata as given. */
export const COLUMN_METADATA_KEYS = [
  'noticeos_filed_by',
  'noticeos_filed_model',
  'noticeos_claimed_model',
  'noticeos_closed_by',
  'noticeos_closed_model',
  'noticeos_closed_at',
  'noticeos_resolution',
  'noticeos_duplicate_of',
  'noticeos_choices',
  'noticeos_choice',
  'noticeos_related_tasks',
] as const;

/** How far apart NoticeOS's recorded close time and the task's own may be and still name one close (task-metadata.mts in NoticeOS). */
const SAME_CLOSE_MS = 1000;

/** The longest name the schema stores, such as an assignee, label or model. */
const NAME_LIMIT = 255;
const TITLE_LIMIT = 1024;

export function unmappedProblems(
  row: BeadsRow,
  mapped: ReadonlySet<string>,
  derived: ReadonlySet<string>,
  what: string,
): string[] {
  const problems: string[] = [];
  for (const [column, value] of Object.entries(row)) {
    if (mapped.has(column) || derived.has(column) || isEmpty(value)) continue;
    const scope = OUT_OF_SCOPE_COLUMNS[column];
    problems.push(
      scope === undefined
        ? `${what} column ${column} holds "${excerpt(value)}", and Ntasks has no field for it`
        : `${what} column ${column} holds "${excerpt(value)}": ${scope}`,
    );
  }
  return problems;
}

/** Links in the order the engine's history lists them (`linkList` in workers/api/src/engine/writes.ts). */
export function sortLinks(links: readonly LinkState[]): LinkState[] {
  return [...links].sort((a, b) => a.taskId.localeCompare(b.taskId));
}

/** The task a Beads link row points to. */
export function linkTarget(row: BeadsRow): string | null {
  return textOf(row.depends_on_issue_id) ?? textOf(row.depends_on_id);
}

function metadataOf(value: Json | undefined): JsonObject | null {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isJsonObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isJsonObject(value) ? value : null;
}

function hasNul(value: string): boolean {
  return value.includes('\u0000');
}

/**
 * Maps one issue as it stood at some point. `labels` and `links` are the
 * issue's label rows and the link rows that start at it.
 */
export function mapTask(input: {
  readonly issue: BeadsRow;
  readonly labels: readonly BeadsRow[];
  readonly links: readonly BeadsRow[];
  readonly projectId: string;
  readonly prefix: string;
}): MappedTask {
  const { issue, projectId, prefix } = input;
  const problems: string[] = [];
  const name = (value: Json | undefined, what: string): string | null => {
    const result = textOf(value);
    if (result !== null && (result.length > NAME_LIMIT || hasNul(result))) {
      problems.push(`${what} "${excerpt(result)}" is longer than ${NAME_LIMIT} characters or holds a NUL character`);
    }
    return result;
  };
  const time = (column: string): string | null => {
    const result = timeOf(issue[column]);
    if (result === undefined) {
      problems.push(`${column} "${excerpt(issue[column])}" is not a time`);
      return null;
    }
    return result;
  };
  const longText = (column: string): string => {
    const value = issue[column];
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') {
      problems.push(`${column} is not text`);
      return '';
    }
    if (hasNul(value)) problems.push(`${column} holds a NUL character`);
    return value;
  };

  const id = textOf(issue.id);
  if (id === null || !isTaskId(id)) {
    return {
      state: null,
      createdAt: null,
      updatedAt: null,
      relatedRefs: [],
      problems: [`its id "${excerpt(issue.id)}" is not a task id Ntasks accepts`],
    };
  }
  if (!id.startsWith(`${prefix}-`)) problems.push(`its id does not start with the project's prefix ${prefix}-`);
  problems.push(...unmappedProblems(issue, ISSUE_COLUMNS, ISSUE_DERIVED, 'its'));

  const typeValue = textOf(issue.issue_type);
  const type: TaskType = isTaskType(typeValue) ? typeValue : 'task';
  if (!isTaskType(typeValue)) problems.push(`its type "${excerpt(issue.issue_type)}" is not one of Ntasks' types`);
  const statusValue = textOf(issue.status);
  const status: TaskStatus = isTaskStatus(statusValue) ? statusValue : 'open';
  if (!isTaskStatus(statusValue)) problems.push(`its status "${excerpt(issue.status)}" is not one of Ntasks' statuses`);
  const awaitValue = textOf(issue.await_type);
  if (awaitValue !== null && !(awaitValue === 'human' && type === 'gate')) {
    problems.push(`it waits on "${excerpt(awaitValue)}": only approvals a person answers are in scope`);
  }
  const priorityValue = issue.priority;
  const priority = typeof priorityValue === 'number' ? priorityValue : Number(textOf(priorityValue) ?? Number.NaN);
  if (!Number.isInteger(priority) || priority < 0 || priority > 4)
    problems.push(`its priority "${excerpt(priorityValue)}" is not 0 to 4`);

  const title = longText('title');
  if (title.length < 1 || title.length > TITLE_LIMIT)
    problems.push(`its title is empty or longer than ${TITLE_LIMIT} characters`);

  const metadata = metadataOf(issue.metadata);
  if (metadata === null) problems.push('its metadata is not a JSON object');
  const meta: JsonObject = metadata ?? {};
  const metaName = (key: string): string | null => {
    const value = meta[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
      problems.push(`its metadata key ${key} is not text`);
      return null;
    }
    return name(value, `its metadata key ${key}`);
  };
  const metaObject = (key: string): JsonObject | null => {
    const value = meta[key];
    if (value === undefined || value === null) return null;
    if (!isJsonObject(value)) {
      problems.push(`its metadata key ${key} is not a JSON object`);
      return null;
    }
    return value;
  };

  const createdAt = time('created_at');
  if (createdAt === null) problems.push('it has no creation time');
  const updatedAt = time('updated_at') ?? createdAt;

  const assignee = name(issue.assignee, 'its assignee');
  const claimedModel = metaName('noticeos_claimed_model');
  const filedBy = metaName('noticeos_filed_by') ?? name(issue.created_by, 'its creator');
  const filedModel = metaName('noticeos_filed_model');
  const choices = metaObject('noticeos_choices');
  const choice = metaObject('noticeos_choice');
  if (choice !== null && choices === null) problems.push('it records a choice but no choices to pick from');

  let close: CloseState | null = null;
  const closedAt = time('closed_at');
  if (status === 'closed') {
    if (closedAt === null) problems.push('it is closed but records no close time');
    const closedBy = metaName('noticeos_closed_by');
    const recordedAt = timeOf(meta.noticeos_closed_at);
    // NoticeOS's closer, model and resolution describe only the close at
    // noticeos_closed_at; a task closed again since has none recorded.
    const recorded =
      closedBy !== null &&
      typeof recordedAt === 'string' &&
      closedAt !== null &&
      Math.abs(Date.parse(recordedAt) - Date.parse(closedAt)) <= SAME_CLOSE_MS;
    const resolutionValue = meta.noticeos_resolution;
    const resolution: TaskResolution = recorded && isTaskResolution(resolutionValue) ? resolutionValue : 'done';
    const duplicateValue = metaName('noticeos_duplicate_of');
    if (resolution === 'duplicate' && duplicateValue !== null && !isTaskId(duplicateValue)) {
      problems.push(`it closed as a duplicate of "${excerpt(duplicateValue)}", which is not a task id Ntasks accepts`);
    }
    close = {
      at: closedAt ?? createdAt ?? '',
      reason: textOf(issue.close_reason),
      resolution,
      duplicateOf:
        resolution === 'duplicate' && duplicateValue !== null && isTaskId(duplicateValue) ? duplicateValue : null,
      by: recorded ? closedBy : null,
      model: recorded ? metaName('noticeos_closed_model') : null,
    };
  }

  const labels: string[] = [];
  for (const row of input.labels) {
    problems.push(...unmappedProblems(row, LABEL_COLUMNS, new Set(), 'a label'));
    const label = textOf(row.label);
    if (label === null || label.length > NAME_LIMIT || hasNul(label))
      problems.push(`its label "${excerpt(row.label)}" is empty or longer than ${NAME_LIMIT} characters`);
    else if (!labels.includes(label)) labels.push(label);
  }
  labels.sort();

  let parentId: string | null = null;
  const links = new Map<string, DependencyType>();
  const addLink = (target: string, type: DependencyType) => {
    if (target === id) problems.push('it links to itself');
    const existing = links.get(target);
    if (existing !== undefined && existing !== type)
      problems.push(`it links to ${target} twice, as ${existing} and ${type}; Ntasks keeps one link per pair`);
    links.set(target, type);
  };
  for (const row of input.links) {
    problems.push(...unmappedProblems(row, LINK_COLUMNS, LINK_DERIVED, 'a link'));
    const target = linkTarget(row);
    const linkType = textOf(row.type) ?? 'blocks';
    if (target === null) continue;
    if (!isTaskId(target)) {
      problems.push(`it links to "${excerpt(target)}", which is not a task id Ntasks accepts`);
      continue;
    }
    if (linkType === 'parent-child') {
      if (parentId !== null && parentId !== target) problems.push(`it has two parents, ${parentId} and ${target}`);
      parentId = target;
    } else if (isDependencyType(linkType)) {
      addLink(target, linkType);
    } else {
      problems.push(`its link to ${target} has the type ${linkType}, which is out of scope`);
    }
  }
  const relatedRefs: RelatedRef[] = [];
  const related = meta.noticeos_related_tasks;
  if (related !== undefined && related !== null) {
    const refs = Array.isArray(related) ? related : null;
    if (refs === null) problems.push('its metadata key noticeos_related_tasks is not a list');
    for (const ref of refs ?? []) {
      if (
        !isJsonObject(ref) ||
        typeof ref.projectId !== 'string' ||
        typeof ref.taskId !== 'string' ||
        !isTaskId(ref.taskId)
      ) {
        problems.push(`its related task "${excerpt(ref)}" does not name a project and a task id`);
        continue;
      }
      relatedRefs.push({ projectId: ref.projectId, taskId: ref.taskId });
      addLink(ref.taskId, 'related');
    }
  }
  if (parentId === id) problems.push('it is its own parent');

  const kept: Record<string, Json> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!(COLUMN_METADATA_KEYS as readonly string[]).includes(key)) kept[key] = value;
  }

  const state: TaskState = {
    id,
    projectId,
    parentId,
    type,
    awaitType: awaitValue === 'human' ? 'human' : null,
    status,
    priority: Number.isInteger(priority) ? priority : 2,
    title,
    description: longText('description'),
    acceptance: longText('acceptance_criteria'),
    assignee,
    assigneeModel: assignee === null ? null : claimedModel,
    startedAt: time('started_at'),
    deferUntil: time('defer_until'),
    dueAt: time('due_at'),
    choices,
    choice,
    metadata: kept,
    labels,
    dependencies: sortLinks([...links].map(([taskId, linkType]) => ({ taskId, type: linkType }))),
    close,
    filedBy,
    filedModel,
  };
  return { state, createdAt, updatedAt, relatedRefs, problems };
}
