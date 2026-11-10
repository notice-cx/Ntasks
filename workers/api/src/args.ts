/**
 * Checks of a call's arguments: an MCP tool's, or the fields of an HTTP
 * write's body. A failed check refuses the call with a sentence naming the
 * argument, by the name its caller sent, and what it must be.
 */
import {
  EXTERNAL_LINK_KINDS,
  IDEMPOTENCY_KEY,
  isExternalLinkKind,
  isTaskId,
  TASK_LIMITS,
  TASK_PRIORITY,
  TASK_RESOLUTIONS,
  TASK_TYPES,
  WORK_DETAILS,
  WORK_LIMITS,
  type CommentPins,
  type ExternalLink,
  type FieldValue,
  type JsonObject,
  type TaskFieldChanges,
  type TaskType,
  type WorkDetail,
} from '@ntasks/domain';
import { httpUrl } from './engine/validate.ts';
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

/** Who reads a refusal's advice: an agent over MCP, which names tools, or a
 * client of the HTTP routes, which names routes. */
export type Caller = 'mcp' | 'http';

/** Refuses the call; an argument that breaks a rule unless `kind` says otherwise. */
export function refuse(message: string, kind: RefusalKind = 'invalid'): never {
  throw new Refused(kind, message);
}

/** Refuses any argument the tool does not take. */
export function only(args: Args, allowed: readonly string[]): void {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) refuse(`invalid arguments: unknown ${unknown.join(', ')}`);
}

/** Names agents send for an argument under another name, with the arguments
 * each may mean, in order; one applies only where the tool takes it. */
const ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  id: ['task'],
  task_id: ['task'],
  project_id: ['project'],
  workspace_id: ['workspace'],
  key: ['idempotency_key'],
  comment: ['text', 'reason'],
  body: ['text', 'description'],
  message: ['text', 'reason'],
  labels: ['add_labels'],
});

/** Edit distance in which swapping two neighbouring letters is one edit. */
function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  }
  return rows[a.length]![b.length]!;
}

/**
 * The argument of `allowed` that an unknown `name` most likely means: the same
 * name in snake_case, a common other name for it, or the closest within two
 * edits (one for a name of three or four letters). Null when none is close.
 */
export function suggestion(name: string, allowed: readonly string[]): string | null {
  const snake = name.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase();
  if (allowed.includes(snake)) return snake;
  const alias = (Object.hasOwn(ALIASES, snake) ? ALIASES[snake]! : []).find((other) => allowed.includes(other));
  if (alias !== undefined) return alias;
  const most = snake.length >= 5 ? 2 : snake.length >= 3 ? 1 : 0;
  let best: { readonly name: string; readonly edits: number } | null = null;
  for (const candidate of allowed) {
    const edits = distance(snake, candidate);
    if (edits <= most && (best === null || edits < best.edits)) best = { name: candidate, edits };
  }
  return best?.name ?? null;
}

/** The refusal of arguments a tool does not take, each named by its path
 * and, when one is close, the argument it most likely means. */
export function unknownArguments(unknown: readonly { readonly path: string; readonly meant: string | null }[]): string {
  if (unknown.length === 1) {
    const { path, meant } = unknown[0]!;
    return `invalid arguments: unknown argument ${path}${meant === null ? '' : `; this tool takes ${meant}`}`;
  }
  const named = unknown.map(({ path, meant }) => (meant === null ? path : `${path} (this tool takes ${meant})`));
  return `invalid arguments: unknown arguments ${listed(named)}`;
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

/** A project as a call names it: over HTTP by its projectId; over MCP by its
 * projectId, key or prefix, so by any text a key may be. */
export function projectArg(args: Args, name = 'project', caller: Caller = 'mcp'): string {
  const value = args[name];
  if (caller === 'http') {
    if (typeof value !== 'string' || !PROJECT_ID.test(value))
      refuse(`invalid arguments: ${name} (a projectId from /api/tasks/projects)`);
    return value;
  }
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value))
    refuse(`invalid arguments: ${name} (a projectId, key or prefix from list_projects)`);
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

/** The criteria a person found met, by their places in the task's criteria
 * from 1, in order: distinct whole numbers, and an empty list when none is. */
export function criteriaMetArg(args: Args, name: string): number[] {
  const value: unknown = args[name];
  if (
    !Array.isArray(value) ||
    value.length > TASK_LIMITS.acceptance ||
    value.some((place) => !Number.isInteger(place) || (place as number) < 1) ||
    new Set(value).size !== value.length
  )
    refuse(
      `invalid arguments: ${name} (the numbers of the criteria that are met, counting from 1, each once; [] when none is)`,
    );
  return (value as number[]).toSorted((a, b) => a - b);
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
  // Date.parse reads 2026-02-31 as 3 March, so the day is checked against its month first.
  const at =
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value) &&
    isCalendarDate(value.slice(0, 10))
      ? Date.parse(value)
      : Number.NaN;
  if (!Number.isFinite(at)) refuse(`invalid arguments: ${name} (YYYY-MM-DD or an ISO time)`);
  return new Date(at).toISOString();
}

// ─── The arguments of a write ─────────────────────────────────────────────────
// NoticeOS's task tools and Tasks API checked these, with these sentences.

/** The retry key a write that would repeat its effect takes, when its caller chose one. */
export function keyArg(args: Args, name = 'idempotency_key'): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    refuse(`invalid arguments: ${name} (8–128 of A–Z a–z 0–9 . _ : -; reuse it when retrying this call)`);
  }
  return value;
}

/** How a new comment changes pinned comments: `pin` true pins it, and
 * `unpin` names pinned comments of its task to unpin. Undefined when it
 * changes none; the engine checks the ids. */
export function pinsArg(args: Args): CommentPins | undefined {
  const pin = booleanArg(args, 'pin');
  const unpin = args.unpin;
  if (
    unpin !== undefined &&
    (!Array.isArray(unpin) ||
      unpin.length > TASK_LIMITS.unpin ||
      unpin.some((id) => typeof id !== 'string' || id === '' || id.length > 64))
  )
    refuse(`invalid arguments: unpin (at most ${TASK_LIMITS.unpin} ids of pinned comments on the task)`);
  const ids = (unpin ?? []) as string[];
  if (pin !== true && ids.length === 0) return undefined;
  return { ...(pin === true ? { pin: true } : {}), ...(ids.length > 0 ? { unpin: ids } : {}) };
}

/** How much of the task a write's reply shows: "full" for all of it, as get_task shows it. */
export function detailArg(args: Args, name = 'detail'): 'full' | undefined {
  const value = args[name];
  if (value !== undefined && value !== 'full')
    refuse(`invalid arguments: ${name} ("full" for the whole task; left out, the reply names what changed)`);
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

/** An estimate in whole minutes; with `clearable`, null takes it off. */
export function estimateArg(args: Args, name: string, clearable = false): number | null | undefined {
  const value = args[name];
  if (value === undefined || (clearable && value === null)) return value;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > TASK_LIMITS.estimateMinutes)
    refuse(
      `invalid arguments: ${name} (whole minutes, 0–${TASK_LIMITS.estimateMinutes}${clearable ? ', or null to take it off' : ''})`,
    );
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

export function typeArg(args: Args, name = 'type', caller: Caller = 'mcp'): Exclude<TaskType, 'gate'> | undefined {
  if (args[name] === 'gate') {
    refuse(
      caller === 'mcp'
        ? `invalid arguments: ${name} (a gate holds another task until a person approves it: pass approval with that task, or call request_human_approval)`
        : `invalid arguments: ${name} (a gate holds another task until a person approves it, and only the MCP endpoint asks for an approval: request_human_approval, or create_task with approval)`,
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

/** The holder a change names: a name on one line with no spaces around it,
 * as list_tasks takes one, or "" to release the task, which is null to the write. */
export function assigneeArg(args: Args, name = 'assignee'): string | null | undefined {
  const value = textArg(args, name, TASK_LIMITS.actor, false, true);
  if (value === '') return null;
  if (value !== undefined && (/[\r\n\t]/u.test(value) || value.trim() !== value))
    refuse(`invalid arguments: ${name} (a name on one line, or "" to release the task)`);
  return value;
}

const URL_RULE = `an http or https URL of at most ${TASK_LIMITS.externalLinkUrl} characters`;

/** Links to pages outside Ntasks: each a url, a title on one line and
 * optionally a kind, each URL once, as the URL standard writes it. */
export function externalLinksArg(args: Args, name: string, least = 0): ExternalLink[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < least || value.length > TASK_LIMITS.externalLinks)
    refuse(
      `invalid arguments: ${name} (${least ? `${least} to ` : 'at most '}${TASK_LIMITS.externalLinks} links, each a url and a title)`,
    );
  const links = value.map((entry: unknown, index): ExternalLink => {
    const at = `${name}[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
      refuse(`invalid arguments: ${at} (a link: url, title and optionally kind)`);
    const link = entry as Args;
    const unknown = Object.keys(link).filter((key) => !['url', 'title', 'kind'].includes(key));
    if (unknown.length > 0) refuse(`invalid arguments: ${at} (url, title and kind only; not ${unknown.join(', ')})`);
    const url = httpUrl(link.url) ?? refuse(`invalid arguments: ${at}.url (${URL_RULE})`);
    const title = textArg({ [`${at}.title`]: link.title }, `${at}.title`, TASK_LIMITS.externalLinkTitle, true)!;
    if (/[\r\n\t]/u.test(title) || title.trim() !== title)
      refuse(`invalid arguments: ${at}.title (one line, no surrounding spaces)`);
    if (link.kind !== undefined && !isExternalLinkKind(link.kind))
      refuse(`invalid arguments: ${at}.kind (one of ${EXTERNAL_LINK_KINDS.join(', ')})`);
    return { url, title, kind: link.kind ?? null };
  });
  if (new Set(links.map((link) => link.url)).size !== links.length)
    refuse(`invalid arguments: ${name} (a URL named twice; a task links to a URL once)`);
  return links;
}

/** The URLs of external links to take off, as the URL standard writes them. */
export function urlsArg(args: Args, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > TASK_LIMITS.externalLinks)
    refuse(`invalid arguments: ${name} (1 to ${TASK_LIMITS.externalLinks} URLs)`);
  const urls = value.map(
    (url: unknown, index) => httpUrl(url) ?? refuse(`invalid arguments: ${name}[${index}] (${URL_RULE})`),
  );
  return [...new Set(urls)];
}

/** A change adds or takes off a link to a URL, not both. */
export function addsOrRemoves(
  added: readonly ExternalLink[] | undefined,
  removed: readonly string[] | undefined,
  names: string,
): void {
  if (added?.some((link) => removed?.includes(link.url)))
    refuse(`invalid arguments: ${names} (a URL both added and taken off; send one)`);
}

/**
 * Values of a project's custom fields, by key: text, a number, true or false,
 * or a list of text, and with `clearable` null to take one off. Their fields
 * check them further when the write is made.
 */
export function fieldsArg(
  args: Args,
  name: string,
  clearable = false,
): Readonly<Record<string, FieldValue | null>> | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  const shaped = (entry: unknown) =>
    (typeof entry === 'string' && !CONTROL.test(entry)) ||
    (typeof entry === 'number' && Number.isFinite(entry)) ||
    typeof entry === 'boolean' ||
    (clearable && entry === null) ||
    (Array.isArray(entry) && entry.every((item) => typeof item === 'string'));
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > TASK_LIMITS.fields ||
    !Object.values(value).every(shaped)
  ) {
    refuse(
      `invalid arguments: ${name} (an object of at most ${TASK_LIMITS.fields} values by field key: text, a number, true or false, or a list of options${clearable ? ', or null to take one off' : ''})`,
    );
  }
  return value as Record<string, FieldValue | null>;
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

/** The arguments that name a holder's helper and work details: `for` and WORK_DETAILS. */
export const WORK_ARGS: readonly string[] = Object.freeze(['for', ...WORK_DETAILS]);

/**
 * The helper (`for`) and work details a claim or a comment names, each one
 * line and `pr` an http or https URL; undefined when it names none. `at`
 * starts the names a refusal gives the details, such as `work.`.
 */
export function workArgs(args: Args, at = '', helperArgs: Args = args): WorkArgs | undefined {
  const line = (from: Args, name: string, shown: string, max: number): string | undefined => {
    const value = from[name];
    if (value === undefined) return undefined;
    if (
      typeof value !== 'string' ||
      !value ||
      value.length > max ||
      value.trim() !== value ||
      /[\r\n\t]/u.test(value) ||
      CONTROL.test(value)
    )
      refuse(`invalid arguments: ${shown} (one line of 1 to ${max} characters)`);
    return value;
  };
  const helper = line(helperArgs, 'for', 'for', TASK_LIMITS.helper);
  const work: Partial<Record<WorkDetail, string>> = {};
  for (const detail of WORK_DETAILS) {
    const value = line(args, detail, `${at}${detail}`, WORK_LIMITS[detail]);
    if (value === undefined) continue;
    work[detail] =
      detail === 'pr' ? (httpUrl(value) ?? refuse(`invalid arguments: ${at}pr (an http or https URL)`)) : value;
  }
  if (helper === undefined && Object.keys(work).length === 0) return undefined;
  return { ...(helper === undefined ? {} : { assigneeFor: helper }), ...(Object.keys(work).length ? { work } : {}) };
}

/** A holder's helper and work details, as the engine takes them. */
export type WorkArgs = Pick<TaskFieldChanges, 'assigneeFor' | 'work'>;
