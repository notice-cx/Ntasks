// Checks of the engine's inputs against the task model and TASK_LIMITS. Each
// failure is a TaskRefused('invalid') that names the field and the rule.
import {
  CHOICE_FIELD_TYPES,
  COMMIT_SHA,
  FIELD_TYPES,
  IDEMPOTENCY_KEY,
  isDependencyType,
  isExternalLinkKind,
  isFieldType,
  isTaskId,
  isTaskResolution,
  isTaskStatus,
  isTaskType,
  TASK_LIMITS,
  TASK_PRIORITY,
  TaskRefused,
  WORK_DETAILS,
  WORK_LIMITS,
  type ActionRequest,
  type Actor,
  type CreateTaskInput,
  type CustomField,
  type DefineFieldInput,
  type DeliverySignal,
  type DependencyType,
  type ExternalLink,
  type FieldType,
  type FieldValue,
  type Json,
  type JsonObject,
  type NewExternalLink,
  type NewTaskLink,
  type NewTaskStep,
  type Retry,
  type StepMark,
  type TaskFieldChanges,
  type TaskResolution,
  type TaskStep,
  type TaskWrite,
  type WorkDetail,
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
  if (
    !Number.isInteger(value) ||
    (value as number) < TASK_PRIORITY.highest ||
    (value as number) > TASK_PRIORITY.lowest
  ) {
    invalid(`priority must be a whole number from ${TASK_PRIORITY.highest} to ${TASK_PRIORITY.lowest}`);
  }
  return value as number;
}

/** An estimate: whole minutes, from 0 to TASK_LIMITS.estimateMinutes. */
export function estimate(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > TASK_LIMITS.estimateMinutes)
    invalid(`${field} must be a whole number of minutes from 0 to ${TASK_LIMITS.estimateMinutes}`);
  return value as number;
}

export function taskId(value: unknown, field: string): string {
  if (!isTaskId(value)) invalid(`${field} must be a task id, such as web-a1b2`);
  return value;
}

export function labels(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > TASK_LIMITS.labels)
    invalid(`${field} must be a list of at most ${TASK_LIMITS.labels} labels`);
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
  text(value.principal, 'retry.principal', TASK_LIMITS.retryPrincipal, true);
  text(value.operation, 'retry.operation', 64, true);
  if (value.derived !== undefined && typeof value.derived !== 'boolean') invalid('retry.derived must be true or false');
  return value;
}

/**
 * An http or https URL as the URL standard writes it, so one page has one
 * URL, or null when `value` is not one or the URL is longer than
 * TASK_LIMITS.externalLinkUrl. Space and control characters are refused, not
 * dropped as the URL parser drops some.
 */
export function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f]/u.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href.length > TASK_LIMITS.externalLinkUrl ? null : url.href;
}

function externalUrl(value: unknown, field: string): string {
  return (
    httpUrl(value) ??
    invalid(`${field} must be an http or https URL of at most ${TASK_LIMITS.externalLinkUrl} characters`)
  );
}

/** Links to pages outside Ntasks, each URL once. */
function externalLinks(value: unknown, field: string): ExternalLink[] {
  if (!Array.isArray(value) || value.length > TASK_LIMITS.externalLinks)
    invalid(`${field} must be a list of at most ${TASK_LIMITS.externalLinks} links`);
  const checked = value.map((entry: NewExternalLink | null, index): ExternalLink => {
    const at = `${field}[${index}]`;
    if (entry === null || typeof entry !== 'object') invalid(`${at} must be a link with a url and a title`);
    const kind: unknown = entry.kind ?? null;
    if (kind !== null && !isExternalLinkKind(kind)) invalid(`${at}.kind must be pull-request, document or other`);
    return {
      url: externalUrl(entry.url, `${at}.url`),
      title: text(entry.title, `${at}.title`, TASK_LIMITS.externalLinkTitle, true),
      kind,
    };
  });
  if (new Set(checked.map((link) => link.url)).size !== checked.length) invalid(`${field} names a URL twice`);
  return checked;
}

// ─── Custom fields ─────────────────────────────────────────────────────────────

const FIELD_KEY = /^[a-z][a-z0-9_-]{0,63}$/u;
const LINE_BREAK = /[\r\n]/u;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** "a", "a or b", "a, b or c". */
function either(values: readonly string[]): string {
  return values.length < 2 ? values.join('') : `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`;
}

function oneLine(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length >= 1 &&
    value.length <= max &&
    !LINE_BREAK.test(value) &&
    !CONTROL.test(value) &&
    !value.includes('\t')
  );
}

export function isFieldKey(value: unknown): value is string {
  return typeof value === 'string' && FIELD_KEY.test(value);
}

/** A new field as the store keeps it. */
export function fieldDefinition(input: DefineFieldInput): {
  key: string;
  name: string;
  type: FieldType;
  options: string[] | null;
} {
  if (input === null || typeof input !== 'object') invalid('the field must be an object');
  if (!isFieldKey(input.key))
    invalid('key must be a lowercase letter, then up to 63 lowercase letters, digits, underscores or hyphens');
  if (!oneLine(input.name, TASK_LIMITS.fieldName))
    invalid(`name must be one line of 1 to ${TASK_LIMITS.fieldName} characters, with no spaces around it`);
  if (!isFieldType(input.type)) invalid(`type must be ${either(FIELD_TYPES)}`);
  const choice = (CHOICE_FIELD_TYPES as readonly string[]).includes(input.type);
  if (!choice) {
    if (input.options !== undefined) invalid(`options are for a ${either(CHOICE_FIELD_TYPES)} field`);
    return { key: input.key, name: input.name, type: input.type, options: null };
  }
  const options: unknown = input.options;
  if (
    !Array.isArray(options) ||
    options.length < 1 ||
    options.length > TASK_LIMITS.fieldOptions ||
    !options.every((option) => oneLine(option, TASK_LIMITS.fieldOption)) ||
    new Set(options).size !== options.length
  ) {
    invalid(
      `options must be 1 to ${TASK_LIMITS.fieldOptions} options, each one line of 1 to ${TASK_LIMITS.fieldOption} characters, none twice`,
    );
  }
  return { key: input.key, name: input.name, type: input.type, options: [...(options as string[])] };
}

/** What a field's values must be, in the words of a refusal. */
function valueRule(field: CustomField, filter: boolean): string {
  const options = either(field.options ?? []);
  switch (field.type) {
    case 'text':
      return `text of 1 to ${TASK_LIMITS.fieldText} characters`;
    case 'number':
      return 'a number';
    case 'date':
      return 'a date as YYYY-MM-DD';
    case 'single-choice':
      return `one of ${options}`;
    case 'multiple-choice':
      return filter ? `one of ${options}` : `a list of its options, each one of ${options}, none twice`;
    case 'url':
      return `an http or https URL of at most ${TASK_LIMITS.externalLinkUrl} characters`;
    case 'yes-no':
      return 'true or false';
  }
}

/** The value as the store keeps it, or null when it breaks the field's rule. */
function checkedValue(field: CustomField, value: unknown, filter: boolean): FieldValue | null {
  const options = field.options ?? [];
  switch (field.type) {
    case 'text':
      return typeof value === 'string' &&
        value.trim() !== '' &&
        value.length <= TASK_LIMITS.fieldText &&
        !CONTROL.test(value)
        ? value
        : null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    case 'date': {
      const parts = typeof value === 'string' ? CALENDAR_DATE.exec(value) : null;
      if (parts === null) return null;
      const [year, month, day] = parts.slice(1).map(Number) as [number, number, number];
      // Date.UTC reads years 0 to 99 as 1900 to 1999; setUTCFullYear keeps the year given.
      const date = new Date(0);
      date.setUTCFullYear(year, month - 1, day);
      return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
        ? (value as string)
        : null;
    }
    case 'single-choice':
      return typeof value === 'string' && options.includes(value) ? value : null;
    case 'multiple-choice':
      if (filter) return typeof value === 'string' && options.includes(value) ? value : null;
      if (
        !Array.isArray(value) ||
        value.length < 1 ||
        new Set(value).size !== value.length ||
        !value.every((option) => typeof option === 'string' && options.includes(option))
      )
        return null;
      // In the field's order, so one set of options is one value, for history and filters alike.
      return options.filter((option) => (value as string[]).includes(option));
    case 'url':
      return httpUrl(value);
    case 'yes-no':
      return typeof value === 'boolean' ? value : null;
  }
}

function fieldOf(fields: readonly CustomField[], key: string, at: string): CustomField {
  return fields.find((field) => field.key === key) ?? invalid(`${at}${key}: the project has no field ${key}`);
}

function valuesObject(values: unknown, at: string): Record<string, unknown> {
  if (values === null || typeof values !== 'object' || Array.isArray(values))
    invalid(`${at.replace(/\.$/u, '')} must be an object of values by field key`);
  if (Object.keys(values).length > TASK_LIMITS.fields)
    invalid(`${at.replace(/\.$/u, '')} names at most ${TASK_LIMITS.fields} fields`);
  return values as Record<string, unknown>;
}

/**
 * Values for a task's fields, checked against the project's fields and kept
 * as the store keeps them. With `clearable`, null takes a value off, a
 * retired field's too; a retired field takes no other value. `at` names the
 * argument in a refusal, such as `fields.`.
 */
export function fieldValues(
  fields: readonly CustomField[],
  values: unknown,
  clearable: boolean,
  at = 'fields.',
): Record<string, FieldValue | null> {
  const given = valuesObject(values, at);
  const checked: Record<string, FieldValue | null> = {};
  for (const [key, value] of Object.entries(given)) {
    const field = fieldOf(fields, key, at);
    if (value === null && clearable) {
      checked[key] = null;
      continue;
    }
    if (field.retiredAt !== null) invalid(`${at}${key}: ${field.name} is retired and takes no new values`);
    checked[key] =
      checkedValue(field, value, false) ??
      invalid(`${at}${key} must be ${valueRule(field, false)}: ${field.name} is a ${field.type} field`);
  }
  return checked;
}

/** Filter values for the project's fields, retired ones included: for a
 * multiple-choice field, one of its options, which a task's options include. */
export function fieldFilters(
  fields: readonly CustomField[],
  values: unknown,
  at = 'fields.',
): Record<string, string | number | boolean> {
  const given = valuesObject(values, at);
  const checked: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(given)) {
    const field = fieldOf(fields, key, at);
    checked[key] =
      (checkedValue(field, value, true) as string | number | boolean | null) ??
      invalid(`${at}${key} must be ${valueRule(field, true)}: ${field.name} is a ${field.type} field`);
  }
  return checked;
}

function nullable<T>(value: T | null | undefined, check: (present: T) => T): T | null | undefined {
  return value === undefined || value === null ? value : check(value);
}

function links(value: unknown): { taskId: string; type: DependencyType }[] {
  if (!Array.isArray(value) || value.length > TASK_LIMITS.links)
    invalid(`links must be a list of at most ${TASK_LIMITS.links}`);
  return value.map((entry: { taskId?: unknown; type?: unknown }, index) => {
    if (!isDependencyType(entry?.type))
      invalid(`links[${index}].type must be blocks, related, discovered-from, duplicates or supersedes`);
    return { taskId: taskId(entry.taskId, `links[${index}].taskId`), type: entry.type };
  });
}

export interface CreateFields {
  readonly title: string;
  readonly description: string;
  readonly acceptance: string;
  readonly notes: string;
  readonly design: string;
  readonly estimateMinutes: number | null;
  readonly type: Exclude<CreateTaskInput['type'], undefined>;
  readonly priority: number;
  readonly parentId: string | null;
  readonly labels: string[];
  readonly links: NewTaskLink[];
  readonly externalLinks: ExternalLink[];
  /** Checked against the project's fields when the write is made. */
  readonly fields: Record<string, unknown> | null;
  readonly deferUntil: string | null;
  readonly dueAt: string | null;
  readonly choices: JsonObject | null;
  readonly metadata: JsonObject;
  readonly requestApproval: { reason: string } | null;
  readonly claim: boolean;
  /** A close as done the task is filed with. */
  readonly close: { reason: string; commit: string | null; pullRequest: string | null; link: string | null } | null;
}

export function createInput(input: CreateTaskInput): CreateFields {
  if (input === null || typeof input !== 'object') invalid('the new task must be an object');
  // Widened to string: callers send JSON, which the static type does not bind.
  const type: string = input.type ?? 'task';
  if (!isTaskType(type) || type === 'gate') invalid('type must be task, bug, feature, epic, chore or decision');
  const newLinks = (input.links ?? []).map((link, index): NewTaskLink => {
    if (link?.direction !== 'depends-on' && link?.direction !== 'blocks')
      invalid(`links[${index}].direction must be depends-on or blocks`);
    const [checked] = links([{ taskId: link.taskId, type: link.type }]);
    return { direction: link.direction, taskId: checked!.taskId, type: checked!.type };
  });
  if (newLinks.length > TASK_LIMITS.links) invalid(`links must be a list of at most ${TASK_LIMITS.links}`);
  return {
    title: text(input.title, 'title', TASK_LIMITS.title, true),
    description: text(input.description ?? '', 'description', TASK_LIMITS.description),
    acceptance: text(input.acceptance ?? '', 'acceptance', TASK_LIMITS.acceptance),
    notes: text(input.notes ?? '', 'notes', TASK_LIMITS.notes),
    design: text(input.design ?? '', 'design', TASK_LIMITS.design),
    estimateMinutes: input.estimateMinutes === undefined ? null : estimate(input.estimateMinutes, 'estimateMinutes'),
    type,
    priority: priority(input.priority ?? TASK_PRIORITY.default),
    parentId: input.parentId === undefined ? null : taskId(input.parentId, 'parentId'),
    labels: labels(input.labels ?? [], 'labels'),
    links: newLinks,
    externalLinks: externalLinks(input.externalLinks ?? [], 'externalLinks'),
    fields: input.fields === undefined ? null : valuesObject(input.fields, 'fields.'),
    deferUntil: input.deferUntil === undefined ? null : instant(input.deferUntil, 'deferUntil'),
    dueAt: input.dueAt === undefined ? null : instant(input.dueAt, 'dueAt'),
    choices: input.choices === undefined ? null : jsonObject(input.choices, 'choices'),
    metadata: input.metadata === undefined ? {} : jsonObject(input.metadata, 'metadata'),
    requestApproval: input.requestApproval === undefined ? null : approval(input.requestApproval),
    ...filedAs(input),
  };
}

/** Whether a new task is filed claimed or closed as done: at most one of
 * them, and neither while it waits on the approval it opens. */
function filedAs(input: CreateTaskInput): Pick<CreateFields, 'claim' | 'close'> {
  if (input.claim !== undefined && input.claim !== true) invalid('claim must be true or left out');
  const claim = input.claim === true;
  if (input.close === undefined) return { claim, close: null };
  if (claim) invalid('a new task is filed claimed or closed, not both');
  if (input.requestApproval !== undefined) invalid('a new task that waits on an approval is not filed closed');
  const { reason, commit, pullRequest, link } = closing({ ...input.close, resolution: 'done' });
  return { claim, close: { reason, commit, pullRequest, link } };
}

/** One line of text: no line break, tab or control character, nor spaces around it. */
function line(value: unknown, field: string, max: number): string {
  if (!oneLine(value, max)) invalid(`${field} must be one line of 1 to ${max} characters, with no spaces around it`);
  return value;
}

/** Work details: each one line, a pull request an http or https URL. */
function workDetails(value: unknown): Partial<Record<WorkDetail, string>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('work must be an object');
  const checked: Partial<Record<WorkDetail, string>> = {};
  for (const [key, detail] of Object.entries(value)) {
    if (!(WORK_DETAILS as readonly string[]).includes(key))
      invalid(`work.${key} is not a work detail; they are ${either([...WORK_DETAILS])}`);
    const name = key as WorkDetail;
    if (name === 'pr')
      checked[name] =
        httpUrl(detail) ?? invalid(`work.pr must be an http or https URL of at most ${WORK_LIMITS.pr} characters`);
    else checked[name] = line(detail, `work.${name}`, WORK_LIMITS[name]);
  }
  return checked;
}

function approval(value: { reason: string } | undefined): { reason: string } {
  return { reason: text(value?.reason, 'requestApproval.reason', TASK_LIMITS.reason, true) };
}

/** A request that a person do steps, checked: its steps carry no marks yet. */
export interface CheckedAction {
  readonly title: string;
  readonly context: string;
  readonly steps: TaskStep[];
}

function action(value: ActionRequest): CheckedAction {
  if (value === null || typeof value !== 'object') invalid('requestAction must be an object');
  const steps: unknown = value.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > TASK_LIMITS.steps)
    invalid(`requestAction.steps must be a list of 1 to ${TASK_LIMITS.steps} steps`);
  return {
    title: line(value.title, 'requestAction.title', TASK_LIMITS.title),
    context: text(value.context, 'requestAction.context', TASK_LIMITS.description),
    steps: steps.map((step: unknown, index): TaskStep => {
      const field = `requestAction.steps[${index}]`;
      if (step === null || typeof step !== 'object' || Array.isArray(step)) invalid(`${field} must be an object`);
      const { text: words, command } = step as NewTaskStep;
      return {
        text: text(words, `${field}.text`, TASK_LIMITS.stepText, true),
        command: command === undefined ? null : text(command, `${field}.command`, TASK_LIMITS.stepCommand, true),
        done: null,
        note: null,
        stuck: null,
      };
    }),
  };
}

/** A mark on a step: who and when, and with `words` the text it carries; null for none. */
function stepMark(value: unknown, field: string, words?: 'text' | 'reason'): Record<string, string> | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) invalid(`${field} must be an object or null`);
  const given = value as Partial<StepMark> & Record<string, unknown>;
  return {
    by: text(given.by, `${field}.by`, TASK_LIMITS.actor, true),
    ...(given.app === undefined ? {} : { app: text(given.app, `${field}.app`, TASK_LIMITS.actor, true) }),
    at: instant(given.at, `${field}.at`),
    ...(words === undefined ? {} : { [words]: text(given[words], `${field}.${words}`, TASK_LIMITS.stepNote, true) }),
  };
}

/** A request's steps with a person's marks, as a write sets them. The engine
 * checks they keep the text and commands the request was filed with. */
function stepsWithMarks(value: unknown): TaskStep[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > TASK_LIMITS.steps)
    invalid(`steps must be a list of 1 to ${TASK_LIMITS.steps} steps`);
  return value.map((step: unknown, index): TaskStep => {
    const field = `steps[${index}]`;
    if (step === null || typeof step !== 'object' || Array.isArray(step)) invalid(`${field} must be an object`);
    const given = step as Record<string, unknown>;
    return {
      text: text(given.text, `${field}.text`, TASK_LIMITS.stepText, true),
      command: given.command === null ? null : text(given.command, `${field}.command`, TASK_LIMITS.stepCommand, true),
      done: stepMark(given.done, `${field}.done`) as StepMark | null,
      note: stepMark(given.note, `${field}.note`, 'text') as TaskStep['note'],
      stuck: stepMark(given.stuck, `${field}.stuck`, 'reason') as TaskStep['stuck'],
    };
  });
}

export interface CheckedWrite {
  readonly expectedVersion: number;
  readonly set: TaskFieldChanges;
  readonly addLabels: string[];
  readonly removeLabels: string[];
  readonly metadata: Readonly<Record<string, Json | null>> | null;
  readonly addLinks: { taskId: string; type: DependencyType }[];
  readonly removeLinks: string[];
  readonly addExternalLinks: ExternalLink[];
  readonly removeExternalLinks: string[];
  /** Checked against the project's fields when the write is made. */
  readonly setFields: Record<string, unknown> | null;
  readonly requestApproval: { reason: string } | null;
  readonly requestAction: CheckedAction | null;
  readonly close: {
    reason: string;
    resolution: TaskResolution;
    duplicateOf: string | null;
    commit: string | null;
    pullRequest: string | null;
    link: string | null;
  } | null;
  readonly reopen: boolean;
  readonly comment: string | null;
  /** Changes to other tasks in the same batch, each checked as a write of its own. */
  readonly others: readonly { readonly taskId: string; readonly write: CheckedWrite }[];
}

/** A write's changes to other tasks: each a write of its own that opens no
 * approval and carries no further changes, each task named once. */
function otherWrites(value: unknown): CheckedWrite['others'] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > TASK_LIMITS.others)
    invalid(`others must be a list of at most ${TASK_LIMITS.others} changes to other tasks`);
  const checked = value.map((entry: unknown, index) => {
    if (entry === null || typeof entry !== 'object') invalid(`others[${index}] must be an object`);
    const { taskId: id, ...change } = entry as TaskWrite & { readonly taskId?: unknown };
    if (change.requestApproval !== undefined || change.requestAction !== undefined || change.others !== undefined)
      invalid(`others[${index}] changes another task's fields, links or comments, and opens no request`);
    return { taskId: taskId(id, `others[${index}].taskId`), write: write(change) };
  });
  if (new Set(checked.map((other) => other.taskId)).size !== checked.length) invalid('others names each task once');
  return checked;
}

export function write(input: TaskWrite): CheckedWrite {
  if (input === null || typeof input !== 'object') invalid('the write must be an object');
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1)
    invalid('expectedVersion must be the version you read, a whole number of 1 or more');
  const given = input.set ?? {};
  // Widened to string: callers send JSON, which the static types do not bind.
  const givenType: string | undefined = given.type;
  const givenStatus: string | undefined = given.status;
  if (givenType === 'gate' || (givenType !== undefined && !isTaskType(givenType)))
    invalid('type must be task, bug, feature, epic, chore or decision');
  if (givenStatus !== undefined && (!isTaskStatus(givenStatus) || givenStatus === 'closed')) {
    invalid('status must be open, in_progress, blocked or deferred; a task is closed with close');
  }
  const set: TaskFieldChanges = {
    ...(given.title === undefined ? {} : { title: text(given.title, 'title', TASK_LIMITS.title, true) }),
    ...(given.description === undefined
      ? {}
      : { description: text(given.description, 'description', TASK_LIMITS.description) }),
    ...(given.acceptance === undefined
      ? {}
      : { acceptance: text(given.acceptance, 'acceptance', TASK_LIMITS.acceptance) }),
    ...(given.notes === undefined ? {} : { notes: text(given.notes, 'notes', TASK_LIMITS.notes) }),
    ...(given.design === undefined ? {} : { design: text(given.design, 'design', TASK_LIMITS.design) }),
    ...(given.estimateMinutes === undefined
      ? {}
      : { estimateMinutes: nullable(given.estimateMinutes, (minutes) => estimate(minutes, 'estimateMinutes')) }),
    ...(given.type === undefined ? {} : { type: given.type }),
    ...(given.priority === undefined ? {} : { priority: priority(given.priority) }),
    ...(given.status === undefined ? {} : { status: given.status }),
    ...(given.assignee === undefined
      ? {}
      : { assignee: nullable(given.assignee, (name) => text(name, 'assignee', TASK_LIMITS.actor, true)) }),
    ...(given.assigneeFor === undefined
      ? {}
      : { assigneeFor: line(given.assigneeFor, 'assigneeFor', TASK_LIMITS.helper) }),
    ...(given.work === undefined ? {} : { work: workDetails(given.work) }),
    ...(given.parentId === undefined ? {} : { parentId: nullable(given.parentId, (id) => taskId(id, 'parentId')) }),
    ...(given.deferUntil === undefined
      ? {}
      : { deferUntil: nullable(given.deferUntil, (at) => instant(at, 'deferUntil')) }),
    ...(given.dueAt === undefined ? {} : { dueAt: nullable(given.dueAt, (at) => instant(at, 'dueAt')) }),
    ...(given.choices === undefined
      ? {}
      : { choices: nullable(given.choices, (value) => jsonObject(value, 'choices')) }),
    ...(given.choice === undefined ? {} : { choice: nullable(given.choice, (value) => jsonObject(value, 'choice')) }),
    ...(given.steps === undefined ? {} : { steps: stepsWithMarks(given.steps) }),
  };
  if (input.close !== undefined && input.reopen === true) invalid('a write closes or reopens a task, not both');
  const close = input.close === undefined ? null : closing(input.close);
  if (close !== null && set.status !== undefined) invalid('a write that closes a task does not also set its status');
  if (input.requestApproval !== undefined && input.requestAction !== undefined)
    invalid('a write opens one request: an approval or steps for a person to do');
  const metadata =
    input.metadata === undefined ? null : (jsonObject(input.metadata, 'metadata') as Record<string, Json | null>);
  const removeLinks: unknown = input.removeLinks ?? [];
  if (!Array.isArray(removeLinks) || removeLinks.length > TASK_LIMITS.links)
    invalid(`removeLinks must be a list of at most ${TASK_LIMITS.links} task ids`);
  const removeExternal: unknown = input.removeExternalLinks ?? [];
  if (!Array.isArray(removeExternal) || removeExternal.length > TASK_LIMITS.externalLinks)
    invalid(`removeExternalLinks must be a list of at most ${TASK_LIMITS.externalLinks} URLs`);
  const addExternalLinks = externalLinks(input.addExternalLinks ?? [], 'addExternalLinks');
  const removeExternalLinks = [
    ...new Set(removeExternal.map((url, index) => externalUrl(url, `removeExternalLinks[${index}]`))),
  ];
  if (addExternalLinks.some((link) => removeExternalLinks.includes(link.url)))
    invalid('a write adds or removes an external link, not both');
  const checked: CheckedWrite = {
    expectedVersion: input.expectedVersion,
    set,
    addLabels: labels(input.addLabels ?? [], 'addLabels'),
    removeLabels: labels(input.removeLabels ?? [], 'removeLabels'),
    metadata,
    addLinks: links(input.addLinks ?? []),
    removeLinks: [...new Set(removeLinks.map((id, index) => taskId(id, `removeLinks[${index}]`)))],
    addExternalLinks,
    removeExternalLinks,
    setFields: input.setFields === undefined ? null : valuesObject(input.setFields, 'setFields.'),
    requestApproval: input.requestApproval === undefined ? null : approval(input.requestApproval),
    requestAction: input.requestAction === undefined ? null : action(input.requestAction),
    close,
    reopen: input.reopen === true,
    comment: input.comment === undefined ? null : text(input.comment, 'comment', TASK_LIMITS.comment, true),
    others: otherWrites(input.others),
  };
  const empty =
    Object.keys(set).length === 0 &&
    checked.addLabels.length === 0 &&
    checked.removeLabels.length === 0 &&
    metadata === null &&
    checked.addLinks.length === 0 &&
    checked.removeLinks.length === 0 &&
    addExternalLinks.length === 0 &&
    removeExternalLinks.length === 0 &&
    (checked.setFields === null || Object.keys(checked.setFields).length === 0) &&
    checked.requestApproval === null &&
    checked.requestAction === null &&
    close === null &&
    !checked.reopen &&
    checked.comment === null;
  if (empty) invalid('the write changes nothing');
  return checked;
}

function closing(value: NonNullable<TaskWrite['close']>): NonNullable<CheckedWrite['close']> {
  if (!isTaskResolution(value?.resolution)) invalid('close.resolution must be a resolution, such as done or wont-do');
  const reason = text(value.reason, 'close.reason', TASK_LIMITS.reason, true);
  const commit = value.commit === undefined ? null : commitSha(value.commit, 'close.commit');
  const pullRequest = value.pullRequest === undefined ? null : externalUrl(value.pullRequest, 'close.pullRequest');
  const link = value.link === undefined ? null : externalUrl(value.link, 'close.link');
  if ((commit !== null || pullRequest !== null || link !== null) && value.resolution !== 'done')
    invalid('close.commit, close.pullRequest and close.link show what shipped, so they close a task as done');
  if (value.resolution === 'duplicate') {
    return {
      reason,
      resolution: value.resolution,
      duplicateOf: taskId(value.duplicateOf, 'close.duplicateOf'),
      commit,
      pullRequest,
      link,
    };
  }
  if (value.duplicateOf !== undefined) invalid('close.duplicateOf is only for a close as duplicate');
  return { reason, resolution: value.resolution, duplicateOf: null, commit, pullRequest, link };
}

/** A commit: 7 to 64 lowercase hexadecimal characters. */
export function commitSha(value: unknown, field: string): string {
  if (typeof value !== 'string' || !COMMIT_SHA.test(value))
    invalid(`${field} must be a commit: 7 to 64 lowercase hexadecimal characters`);
  return value;
}

/** The most pull requests, and the most commits, one delivery signal names. */
export const SIGNAL_ITEMS = 100;

export function deliverySignal(value: DeliverySignal): DeliverySignal {
  if (value === null || typeof value !== 'object') invalid('the signal must be an object');
  if (value.stage !== 'merged' && value.stage !== 'live') invalid('stage must be merged or live');
  const list = <T>(items: unknown, field: string, each: (item: unknown, at: string) => T): T[] => {
    if (!Array.isArray(items) || items.length > SIGNAL_ITEMS)
      invalid(`${field} must be a list of at most ${SIGNAL_ITEMS}`);
    return [...new Set(items.map((item: unknown, index) => each(item, `${field}[${index}]`)))];
  };
  const pullRequests = list(value.pullRequests, 'pullRequests', externalUrl);
  const commits = list(value.commits, 'commits', commitSha);
  if (pullRequests.length === 0 && commits.length === 0) invalid('a signal names a pull request or a commit');
  return { stage: value.stage, pullRequests, commits };
}
