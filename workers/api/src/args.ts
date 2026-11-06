/**
 * Checks of a call's arguments: an MCP tool's, or the fields of an HTTP
 * write's body. A failed check refuses the call with a sentence naming the
 * argument, by the name its caller sent, and what it must be.
 */
import {
  IDEMPOTENCY_KEY,
  isTaskId,
  TASK_LIMITS,
  TASK_PRIORITY,
  TASK_RESOLUTIONS,
  TASK_TYPES,
  type JsonObject,
  type TaskType,
} from '@ntasks/domain';
import {
  choicesOf,
  choicesProblem,
  HANDOFF_LIMITS,
  handoffMetadataOf,
  isCalendarDate,
  sentCard,
  SOURCE_METADATA_KEYS,
} from './noticeos-fields.ts';
import { Refused, type RefusalKind } from './refused.ts';

export type Args = Record<string, unknown>;

/** Refuses the call; an argument that breaks a rule unless `kind` says otherwise. */
export function refuse(message: string, kind: RefusalKind = 'invalid'): never {
  throw new Refused(kind, message);
}

/** Refuses any argument the tool does not take. */
export function only(args: Args, allowed: readonly string[]): void {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) refuse(`invalid arguments: unknown ${unknown.join(', ')}`);
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export function textArg(args: Args, name: string, max: number, required: boolean, empty = false): string | undefined {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (value === undefined) refuse(`invalid arguments: ${name} (required)`);
  if (typeof value !== 'string') refuse(`invalid arguments: ${name} (text)`);
  if (value.length > max)
    refuse(`invalid arguments: ${name} (at most ${max} characters; this one has ${value.length})`);
  if (!empty && !value.trim()) refuse(`invalid arguments: ${name} (empty)`);
  if (CONTROL.test(value))
    refuse(`invalid arguments: ${name} (a control character; tab and line breaks are the only ones allowed)`);
  return value;
}

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function projectArg(args: Args, name = 'project'): string {
  const value = args[name];
  if (typeof value !== 'string' || !PROJECT_ID.test(value))
    refuse(`invalid arguments: ${name} (a projectId from list_projects)`);
  return value;
}

export function taskArg(args: Args, name = 'task'): string {
  const value = args[name];
  if (!isTaskId(value)) refuse(`invalid arguments: ${name} (a task id such as abc-1x2)`);
  return value;
}

export function integerArg(args: Args, name: string, least: number, most: number, fallback: number): number {
  const value = args[name] ?? fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < least || value > most)
    refuse(`invalid arguments: ${name} (${least}–${most})`);
  return value;
}

export function booleanArg(args: Args, name: string): boolean | undefined {
  const value = args[name];
  if (value !== undefined && typeof value !== 'boolean') refuse(`invalid arguments: ${name} (true or false)`);
  return value;
}

/** A list of short strings, such as labels or types. */
export function stringsArg(args: Args, name: string): readonly string[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 200 ||
    value.some((entry) => typeof entry !== 'string' || !entry || entry.length > 512)
  ) {
    refuse(`invalid arguments: ${name}`);
  }
  return value as string[];
}

/** A date or time, as YYYY-MM-DD or an ISO time with its offset. */
export function instantArg(args: Args, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  const at =
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value)
      ? Date.parse(value)
      : Number.NaN;
  if (!Number.isFinite(at)) refuse(`invalid arguments: ${name} (YYYY-MM-DD or an ISO time)`);
  return new Date(at).toISOString();
}

// ─── The arguments of a write ─────────────────────────────────────────────────
// NoticeOS's task tools and Tasks API checked these, with these sentences.

/** The retry key every write that would repeat its effect takes. */
export function keyArg(args: Args, name = 'idempotency_key'): string {
  const value = args[name];
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    refuse(`invalid arguments: ${name} (8–128 of A–Z a–z 0–9 . _ : -; reuse it when retrying this call)`);
  }
  return value;
}

/** The model an agent names, kept beside its name on what it files, claims and closes. */
export function modelArg(args: Args, name = 'model'): string | undefined {
  const value = textArg(args, name, TASK_LIMITS.actor, false);
  if (value !== undefined && (/[\r\n\t]/u.test(value) || value.trim() !== value))
    refuse(`invalid arguments: ${name} (one line, no surrounding spaces)`);
  return value;
}

export function priorityArg(args: Args, name = 'priority'): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < TASK_PRIORITY.highest ||
    value > TASK_PRIORITY.lowest
  )
    refuse(`invalid arguments: ${name} (${TASK_PRIORITY.highest}–${TASK_PRIORITY.lowest})`);
  return value;
}

/** One of `values`, or undefined when the argument is left out. */
export function choiceArg<T extends string>(args: Args, name: string, values: readonly T[]): T | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value))
    refuse(`invalid arguments: ${name} (one of ${values.join(', ')})`);
  return value as T;
}

/** The types a task is filed or changed as; a gate is made by asking for an approval. */
export const WRITABLE_TYPES = Object.freeze(TASK_TYPES.filter((type) => type !== 'gate')) as readonly Exclude<
  TaskType,
  'gate'
>[];

export function typeArg(args: Args, name = 'type'): Exclude<TaskType, 'gate'> | undefined {
  if (args[name] === 'gate') {
    refuse(
      `invalid arguments: ${name} (a gate holds another task until a person approves it: pass approval with that task, or call request_human_approval)`,
    );
  }
  return choiceArg(args, name, WRITABLE_TYPES);
}

/** Labels as Beads kept them: each one line without commas or surrounding spaces, none twice. */
export function labelsArg(args: Args, name: string, least = 0): string[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length < least ||
    value.length > TASK_LIMITS.labels ||
    new Set(value).size !== value.length ||
    value.some(
      (label) =>
        typeof label !== 'string' ||
        !label ||
        label.length > TASK_LIMITS.label ||
        /[\r\n\t,]/u.test(label) ||
        label.trim() !== label,
    )
  ) {
    refuse(
      `invalid arguments: ${name} (${least ? `${least} to ` : 'at most '}${TASK_LIMITS.labels} labels, each at most ${TASK_LIMITS.label} ` +
        'characters on one line, without commas or surrounding spaces, none twice)',
    );
  }
  return value as string[];
}

/** A defer date, or "" to clear one. */
export function deferArg(args: Args, name = 'defer'): string | undefined {
  const value = args[name];
  if (value === undefined || value === '') return value;
  if (typeof value !== 'string' || !isCalendarDate(value))
    refuse(`invalid arguments: ${name} (YYYY-MM-DD, or "" to clear it)`);
  return value;
}

/** A decision's options, refused with the field at fault named. */
export function choicesArg(args: Args, name = 'choices'): JsonObject | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  const problem = choicesProblem(value);
  if (problem !== null) refuse(`invalid arguments: ${problem.field} (${problem.rule})`);
  return choicesOf(value)!;
}

/** A card's figures. Who wrote it and when are the server's to record, so a
 * caller's by and at never reach the rules or the task. */
export function cardArg(args: Args, name = 'card'): JsonObject | undefined {
  if (args[name] === undefined) return undefined;
  const sent = sentCard(args[name]);
  if ('problem' in sent) refuse(`invalid arguments: ${sent.problem.field} (${sent.problem.rule})`);
  return sent.card;
}

/** A copied NoticeOS handoff's source identity, all five of its fields. */
export function handoffMetadataArg(args: Args, name = 'metadata'): JsonObject | undefined {
  if (args[name] === undefined) return undefined;
  return (
    handoffMetadataOf(args[name]) ??
    refuse(
      `invalid arguments: ${name} (the five bounded handoff source fields only; keep the complete identity unchanged)`,
    )
  );
}

/** The source metadata a new task from the web app may carry: those keys, each text. */
export function sourceMetadataArg(args: Args, name = 'metadata'): JsonObject | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.entries(value).some(
      ([key, entry]) =>
        !SOURCE_METADATA_KEYS.includes(key) ||
        typeof entry !== 'string' ||
        !entry.trim() ||
        entry.length > HANDOFF_LIMITS.value ||
        CONTROL.test(entry),
    )
  ) {
    refuse(
      `invalid arguments: ${name} (only ${SOURCE_METADATA_KEYS.join(', ')}, each text of at most ${HANDOFF_LIMITS.value} characters)`,
    );
  }
  return value as JsonObject;
}

/** Task ids as a sentence lists them: "a", "a and b", "a, b and c". */
export function listed(ids: readonly string[]): string {
  return ids.length < 2 ? ids.join('') : `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`;
}

/** "" clears a field: null to the write. */
export function emptyIsNone(value: string | undefined): string | null | undefined {
  return value === '' ? null : value;
}

/** A close's reason, resolution and the task a duplicate names, checked as NoticeOS checked them. */
export function closingArgs(args: Args, taskId: string, duplicateName: string) {
  const resolution = choiceArg(args, 'resolution', TASK_RESOLUTIONS);
  const duplicateOf = args[duplicateName] === undefined ? undefined : taskArg(args, duplicateName);
  if (resolution === 'duplicate' && duplicateOf === undefined)
    refuse(`invalid arguments: ${duplicateName} (required with resolution duplicate: the task this one duplicates)`);
  if (duplicateOf !== undefined && resolution !== 'duplicate')
    refuse(`invalid arguments: ${duplicateName} (only with resolution duplicate)`);
  if (duplicateOf === taskId) refuse(`invalid arguments: ${duplicateName} (another task than the one closing)`);
  const reason = textArg(args, 'reason', TASK_LIMITS.reason, true)!;
  return {
    reason,
    ...(resolution === undefined ? {} : { resolution }),
    ...(duplicateOf === undefined ? {} : { duplicateOf }),
  };
}

/** Choices, a card and a change class are set together or taken off together, never both in one change. */
export function setOrTakeOff(args: Args, names: readonly string[]): void {
  const kept = names.filter((name) => args[name] !== undefined);
  if (kept.some((name) => args[name] === null) && kept.some((name) => args[name] !== null)) {
    refuse(
      `invalid arguments: ${listed(kept)} (a call either sets these or takes them off with null, not both; take them off in a call of their own)`,
    );
  }
}
