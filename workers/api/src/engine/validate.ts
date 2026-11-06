// Checks of the engine's inputs against the task model and TASK_LIMITS. Each
// failure is a TaskRefused('invalid') that names the field and the rule.
import {
  IDEMPOTENCY_KEY,
  isDependencyType,
  isTaskId,
  isTaskResolution,
  isTaskStatus,
  isTaskType,
  TASK_LIMITS,
  TASK_PRIORITY,
  TaskRefused,
  type Actor,
  type CreateTaskInput,
  type DependencyType,
  type Json,
  type JsonObject,
  type NewTaskLink,
  type Retry,
  type TaskFieldChanges,
  type TaskResolution,
  type TaskWrite,
} from '@ntasks/domain';

export function invalid(message: string): never {
  throw new TaskRefused('invalid', message);
}

/** A date or time, as the UTC ISO 8601 text the database stores. */
export function instant(value: unknown, field: string): string {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) invalid(`${field} must be a date or time, such as 2026-11-06 or 2026-11-06T18:00:00Z`);
  return new Date(parsed).toISOString();
}

export function text(value: unknown, field: string, max: number, required = false): string {
  if (typeof value !== 'string') invalid(`${field} must be text`);
  if (required && value.trim() === '') invalid(`${field} must not be empty`);
  if (value.length > max) invalid(`${field} must be at most ${max} characters`);
  return value;
}

export function priority(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < TASK_PRIORITY.highest || (value as number) > TASK_PRIORITY.lowest) {
    invalid(`priority must be a whole number from ${TASK_PRIORITY.highest} to ${TASK_PRIORITY.lowest}`);
  }
  return value as number;
}

export function taskId(value: unknown, field: string): string {
  if (!isTaskId(value)) invalid(`${field} must be a task id, such as web-a1b2`);
  return value;
}

export function labels(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > TASK_LIMITS.labels) invalid(`${field} must be a list of at most ${TASK_LIMITS.labels} labels`);
  return [...new Set(value.map((label, index) => text(label, `${field}[${index}]`, TASK_LIMITS.label, true).trim()))];
}

/** A plain JSON object, such as metadata or a decision's choices. */
export function jsonObject(value: unknown, field: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} must be a JSON object`);
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(value));
  } catch {
    invalid(`${field} must be a JSON object`);
  }
  return copy as JsonObject;
}

export function actor(value: Actor): Actor {
  if (value === null || typeof value !== 'object') invalid('actor must name who is acting');
  const name = text(value.name, 'actor.name', TASK_LIMITS.actor, true);
  if (value.model === undefined) return { name };
  return { name, model: text(value.model, 'actor.model', TASK_LIMITS.actor, true) };
}

export function retry(value: Retry | undefined): Retry | undefined {
  if (value === undefined) return undefined;
  if (typeof value.key !== 'string' || !IDEMPOTENCY_KEY.test(value.key)) {
    invalid('the idempotency key must be 8 to 128 letters, digits, dots, colons, underscores or hyphens');
  }
  if (typeof value.requestHash !== 'string' || !/^[0-9a-f]{64}$/u.test(value.requestHash)) {
    invalid('requestHash must be 64 lowercase hexadecimal characters');
  }
  text(value.principal, 'retry.principal', 128, true);
  text(value.operation, 'retry.operation', 64, true);
  return value;
}

function nullable<T>(value: T | null | undefined, check: (present: T) => T): T | null | undefined {
  return value === undefined || value === null ? value : check(value);
}

function links(value: unknown): { taskId: string; type: DependencyType }[] {
  if (!Array.isArray(value) || value.length > TASK_LIMITS.links) invalid(`links must be a list of at most ${TASK_LIMITS.links}`);
  return value.map((entry: { taskId?: unknown; type?: unknown }, index) => {
    if (!isDependencyType(entry?.type)) invalid(`links[${index}].type must be blocks, related or discovered-from`);
    return { taskId: taskId(entry.taskId, `links[${index}].taskId`), type: entry.type };
  });
}

export interface CreateFields {
  readonly title: string;
  readonly description: string;
  readonly acceptance: string;
  readonly type: Exclude<CreateTaskInput['type'], undefined>;
  readonly priority: number;
  readonly parentId: string | null;
  readonly labels: string[];
  readonly links: NewTaskLink[];
  readonly deferUntil: string | null;
  readonly dueAt: string | null;
  readonly choices: JsonObject | null;
  readonly metadata: JsonObject;
  readonly requestApproval: { reason: string } | null;
}

export function createInput(input: CreateTaskInput): CreateFields {
  if (input === null || typeof input !== 'object') invalid('the new task must be an object');
  // Widened to string: callers send JSON, which the static type does not bind.
  const type: string = input.type ?? 'task';
  if (!isTaskType(type) || type === 'gate') invalid('type must be task, bug, feature, epic, chore or decision');
  const newLinks = (input.links ?? []).map((link, index): NewTaskLink => {
    if (link?.direction !== 'depends-on' && link?.direction !== 'blocks') invalid(`links[${index}].direction must be depends-on or blocks`);
    const [checked] = links([{ taskId: link.taskId, type: link.type }]);
    return { direction: link.direction, taskId: checked!.taskId, type: checked!.type };
  });
  if (newLinks.length > TASK_LIMITS.links) invalid(`links must be a list of at most ${TASK_LIMITS.links}`);
  return {
    title: text(input.title, 'title', TASK_LIMITS.title, true),
    description: text(input.description ?? '', 'description', TASK_LIMITS.description),
    acceptance: text(input.acceptance ?? '', 'acceptance', TASK_LIMITS.acceptance),
    type,
    priority: priority(input.priority ?? TASK_PRIORITY.default),
    parentId: input.parentId === undefined ? null : taskId(input.parentId, 'parentId'),
    labels: labels(input.labels ?? [], 'labels'),
    links: newLinks,
    deferUntil: input.deferUntil === undefined ? null : instant(input.deferUntil, 'deferUntil'),
    dueAt: input.dueAt === undefined ? null : instant(input.dueAt, 'dueAt'),
    choices: input.choices === undefined ? null : jsonObject(input.choices, 'choices'),
    metadata: input.metadata === undefined ? {} : jsonObject(input.metadata, 'metadata'),
    requestApproval: input.requestApproval === undefined ? null : approval(input.requestApproval),
  };
}

function approval(value: { reason: string } | undefined): { reason: string } {
  return { reason: text(value?.reason, 'requestApproval.reason', TASK_LIMITS.reason, true) };
}

export interface CheckedWrite {
  readonly expectedVersion: number;
  readonly set: TaskFieldChanges;
  readonly addLabels: string[];
  readonly removeLabels: string[];
  readonly metadata: Readonly<Record<string, Json | null>> | null;
  readonly addLinks: { taskId: string; type: DependencyType }[];
  readonly removeLinks: string[];
  readonly requestApproval: { reason: string } | null;
  readonly close: { reason: string; resolution: TaskResolution; duplicateOf: string | null } | null;
  readonly reopen: boolean;
  readonly comment: string | null;
}

export function write(input: TaskWrite): CheckedWrite {
  if (input === null || typeof input !== 'object') invalid('the write must be an object');
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) invalid('expectedVersion must be the version you read, a whole number of 1 or more');
  const given = input.set ?? {};
  // Widened to string: callers send JSON, which the static types do not bind.
  const givenType: string | undefined = given.type;
  const givenStatus: string | undefined = given.status;
  if (givenType === 'gate' || (givenType !== undefined && !isTaskType(givenType))) invalid('type must be task, bug, feature, epic, chore or decision');
  if (givenStatus !== undefined && (!isTaskStatus(givenStatus) || givenStatus === 'closed')) {
    invalid('status must be open, in_progress, blocked or deferred; a task is closed with close');
  }
  const set: TaskFieldChanges = {
    ...(given.title === undefined ? {} : { title: text(given.title, 'title', TASK_LIMITS.title, true) }),
    ...(given.description === undefined ? {} : { description: text(given.description, 'description', TASK_LIMITS.description) }),
    ...(given.acceptance === undefined ? {} : { acceptance: text(given.acceptance, 'acceptance', TASK_LIMITS.acceptance) }),
    ...(given.type === undefined ? {} : { type: given.type }),
    ...(given.priority === undefined ? {} : { priority: priority(given.priority) }),
    ...(given.status === undefined ? {} : { status: given.status }),
    ...(given.assignee === undefined ? {} : { assignee: nullable(given.assignee, (name) => text(name, 'assignee', TASK_LIMITS.actor, true)) }),
    ...(given.parentId === undefined ? {} : { parentId: nullable(given.parentId, (id) => taskId(id, 'parentId')) }),
    ...(given.deferUntil === undefined ? {} : { deferUntil: nullable(given.deferUntil, (at) => instant(at, 'deferUntil')) }),
    ...(given.dueAt === undefined ? {} : { dueAt: nullable(given.dueAt, (at) => instant(at, 'dueAt')) }),
    ...(given.choices === undefined ? {} : { choices: nullable(given.choices, (value) => jsonObject(value, 'choices')) }),
    ...(given.choice === undefined ? {} : { choice: nullable(given.choice, (value) => jsonObject(value, 'choice')) }),
  };
  if (input.close !== undefined && input.reopen === true) invalid('a write closes or reopens a task, not both');
  const close = input.close === undefined ? null : closing(input.close);
  if (close !== null && set.status !== undefined) invalid('a write that closes a task does not also set its status');
  const metadata = input.metadata === undefined ? null : (jsonObject(input.metadata, 'metadata') as Record<string, Json | null>);
  const removeLinks: unknown = input.removeLinks ?? [];
  if (!Array.isArray(removeLinks) || removeLinks.length > TASK_LIMITS.links) invalid(`removeLinks must be a list of at most ${TASK_LIMITS.links} task ids`);
  const checked: CheckedWrite = {
    expectedVersion: input.expectedVersion,
    set,
    addLabels: labels(input.addLabels ?? [], 'addLabels'),
    removeLabels: labels(input.removeLabels ?? [], 'removeLabels'),
    metadata,
    addLinks: links(input.addLinks ?? []),
    removeLinks: [...new Set(removeLinks.map((id, index) => taskId(id, `removeLinks[${index}]`)))],
    requestApproval: input.requestApproval === undefined ? null : approval(input.requestApproval),
    close,
    reopen: input.reopen === true,
    comment: input.comment === undefined ? null : text(input.comment, 'comment', TASK_LIMITS.comment, true),
  };
  const empty =
    Object.keys(set).length === 0 &&
    checked.addLabels.length === 0 &&
    checked.removeLabels.length === 0 &&
    metadata === null &&
    checked.addLinks.length === 0 &&
    checked.removeLinks.length === 0 &&
    checked.requestApproval === null &&
    close === null &&
    !checked.reopen &&
    checked.comment === null;
  if (empty) invalid('the write changes nothing');
  return checked;
}

function closing(value: NonNullable<TaskWrite['close']>): NonNullable<CheckedWrite['close']> {
  if (!isTaskResolution(value?.resolution)) invalid('close.resolution must be a resolution, such as done or wont-do');
  const reason = text(value.reason, 'close.reason', TASK_LIMITS.reason, true);
  if (value.resolution === 'duplicate') {
    return { reason, resolution: value.resolution, duplicateOf: taskId(value.duplicateOf, 'close.duplicateOf') };
  }
  if (value.duplicateOf !== undefined) invalid('close.duplicateOf is only for a close as duplicate');
  return { reason, resolution: value.resolution, duplicateOf: null };
}
