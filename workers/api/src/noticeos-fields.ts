/**
 * The rules NoticeOS kept for the facts it stored in task metadata, which
 * Ntasks keeps the same way so agents and the web app written for NoticeOS
 * read and write them unchanged: a decision's choices, a task's card (what
 * the work is worth) and the card it shipped with, its change class, and the
 * source of a copied handoff. Ported from NoticeOS's packages/contract
 * (task-choices, task-card, task-change-class, task-metadata, task-gate).
 */
import type { Json, JsonObject } from '@ntasks/domain';

/** The metadata keys NoticeOS wrote, which Ntasks stores and returns as given. */
export const NOTICEOS_METADATA = Object.freeze({
  card: 'noticeos_card',
  cardShipped: 'noticeos_card_shipped',
  changeClass: 'noticeos_change_class',
});

/** A problem with a value: the field at fault, as the caller names it, and what it must be. */
export interface Problem {
  readonly field: string;
  readonly rule: string;
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ─── Choices ──────────────────────────────────────────────────────────────────

/** The keys options take, in the order they are shown. */
export const TASK_CHOICE_KEYS = Object.freeze(['a', 'b', 'c', 'd', 'e', 'f'] as const);
export type TaskChoiceKey = (typeof TASK_CHOICE_KEYS)[number];

export const TASK_CHOICE_LIMITS = Object.freeze({
  question: 400,
  label: 120,
  detail: 600,
  fewest: 2,
  most: TASK_CHOICE_KEYS.length,
});

function choiceTextProblem(value: unknown, field: string, max: number, oneLine: boolean): Problem | null {
  if (typeof value !== 'string') return { field, rule: 'text' };
  if (!value.trim()) return { field, rule: 'empty' };
  if (value.length > max) return { field, rule: `at most ${max} characters; this one has ${value.length}` };
  if (CONTROL.test(value)) return { field, rule: 'a control character; tab and line breaks are the only ones allowed' };
  if (oneLine && /[\r\n]/u.test(value)) return { field, rule: 'one line' };
  return null;
}

/** Why a value is not a set of choices a task may carry, or null when it is
 * one: a question and two to six options keyed a, b, c… in the order shown,
 * each with a one-line label and an optional detail, exactly one marked
 * `recommended: true`. */
export function choicesProblem(value: unknown): Problem | null {
  if (!isRecord(value)) return { field: 'choices', rule: 'an object with question and options' };
  const extra = Object.keys(value).find((key) => key !== 'question' && key !== 'options');
  if (extra !== undefined)
    return { field: `choices.${extra}`, rule: 'not a field of choices, which takes question and options' };
  const question = choiceTextProblem(value.question, 'choices.question', TASK_CHOICE_LIMITS.question, false);
  if (question) return question;
  const options = value.options;
  if (
    !Array.isArray(options) ||
    options.length < TASK_CHOICE_LIMITS.fewest ||
    options.length > TASK_CHOICE_LIMITS.most
  ) {
    return { field: 'choices.options', rule: `${TASK_CHOICE_LIMITS.fewest} to ${TASK_CHOICE_LIMITS.most} options` };
  }
  let recommended = 0;
  for (const [index, option] of options.entries()) {
    const at = `choices.options[${index}]`;
    if (!isRecord(option)) return { field: at, rule: 'an object with key and label' };
    const unknown = Object.keys(option).find((key) => !['key', 'label', 'detail', 'recommended'].includes(key));
    if (unknown !== undefined)
      return {
        field: `${at}.${unknown}`,
        rule: 'not a field of an option, which takes key, label, detail and recommended',
      };
    const key = TASK_CHOICE_KEYS[index]!;
    if (option.key !== key)
      return { field: `${at}.key`, rule: `${key}: keys run a, b, c… in the order the options are shown` };
    const label = choiceTextProblem(option.label, `${at}.label`, TASK_CHOICE_LIMITS.label, true);
    if (label) return label;
    if (option.detail !== undefined) {
      const detail = choiceTextProblem(option.detail, `${at}.detail`, TASK_CHOICE_LIMITS.detail, false);
      if (detail) return detail;
    }
    if (option.recommended !== undefined && typeof option.recommended !== 'boolean')
      return { field: `${at}.recommended`, rule: 'true or false' };
    if (option.recommended === true) recommended += 1;
  }
  if (recommended !== 1)
    return { field: 'choices.options', rule: `exactly one option with recommended: true; these have ${recommended}` };
  return null;
}

/** A set that passes choicesProblem, as it is stored: `recommended` only on the one option. */
export function choicesOf(value: unknown): JsonObject | null {
  if (choicesProblem(value) !== null) return null;
  const row = value as {
    question: string;
    options: { key: TaskChoiceKey; label: string; detail?: string; recommended?: boolean }[];
  };
  return {
    question: row.question,
    options: row.options.map((option) => ({
      key: option.key,
      label: option.label,
      ...(option.detail === undefined ? {} : { detail: option.detail }),
      ...(option.recommended === true ? { recommended: true } : {}),
    })),
  };
}

/** A person's pick as a sentence names it, such as "(b) Keep the old page",
 * or null when the recorded pick cannot be read. */
export function choiceName(choice: JsonObject): string | null {
  const { option, label } = choice;
  return typeof option === 'string' &&
    (TASK_CHOICE_KEYS as readonly string[]).includes(option) &&
    typeof label === 'string' &&
    label.trim()
    ? `(${option}) ${label}`
    : null;
}

/** Lines that open with an option letter: (a), a), a. or a list dash before (a). */
const LETTERED_LINE = /^\s*(?:[-*]\s*)?(?:\(([a-f])\)|([a-f])[.)])\s/u;

/** Whether a description offers a person lettered options in prose: lines
 * for (a) and (b), or "(a) … (b) …" inside one line. */
export function offersLetteredOptions(description: string): boolean {
  const letters = new Set<string>();
  for (const line of description.split(/\r?\n/u)) {
    if (/\(a\)\s.*\(b\)\s/u.test(line)) return true;
    const match = LETTERED_LINE.exec(line);
    if (match) letters.add(match[1] ?? match[2]!);
  }
  return letters.has('a') && letters.has('b');
}

export const CHOICES_ADVICE =
  'choices: the description offers lettered options. Pass them as choices, so the person picks one with a button ' +
  'and the pick is recorded on the task.';

/** Advice beside lint's missing sections: a person's task whose options are prose a button cannot press. */
export function choiceAdvice(task: {
  readonly labels: readonly string[];
  readonly description: string;
  readonly choices: unknown;
}): readonly string[] {
  if (!task.labels.includes('human') || task.choices) return [];
  return offersLetteredOptions(task.description) ? [CHOICES_ADVICE] : [];
}

// ─── Cards ────────────────────────────────────────────────────────────────────

export const TASK_MEASURABILITIES = Object.freeze(['cohort', 'holdout', 'unmeasured'] as const);
export const TASK_REVENUE_FAMILIES = Object.freeze(['ads', 'affiliate', 'subs', 'licensing'] as const);

export const TASK_CARD_LIMITS = Object.freeze({
  /** USD a month, either sign: a loss avoided is a positive value for the task that avoids it. */
  valuePerMonth: { min: -1_000_000, max: 1_000_000 },
  likelihood: { min: 0.01, max: 0.99 },
  reviewMinutes: { min: 0, max: 100_000 },
  buildMinutes: { min: 0, max: 1_000_000 },
  daysToSignal: { min: 1, max: 730 },
  durability: { min: 0.5, max: 1.2 },
  killState: 300,
  note: 600,
  by: 120,
});

const CARD_FIELDS = [
  'valuePerMonth',
  'likelihood',
  'reviewMinutes',
  'buildMinutes',
  'daysToSignal',
  'measurability',
  'revenueFamily',
  'durability',
  'kill',
  'note',
  'by',
  'at',
] as const;

function numberProblem(
  value: unknown,
  field: string,
  range: { min: number; max: number },
  whole = false,
): Problem | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { field, rule: 'a number' };
  if (whole && !Number.isInteger(value)) return { field, rule: 'a whole number' };
  if (value < range.min || value > range.max) return { field, rule: `between ${range.min} and ${range.max}` };
  return null;
}

function lineProblem(value: unknown, field: string, max: number): Problem | null {
  if (typeof value !== 'string') return { field, rule: 'text' };
  if (!value.trim()) return { field, rule: 'empty' };
  if (value.length > max) return { field, rule: `at most ${max} characters; this one has ${value.length}` };
  if (CONTROL.test(value) || /[\r\n]/u.test(value)) return { field, rule: 'one line' };
  return null;
}

/** Whether `value` is a calendar date, YYYY-MM-DD, that exists. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function oneOf(values: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && values.includes(value);
}

function killProblem(value: unknown): Problem | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return { field: 'card.kill', rule: 'an object with state and date' };
  const extra = Object.keys(value).find((key) => key !== 'state' && key !== 'date');
  if (extra !== undefined)
    return { field: `card.kill.${extra}`, rule: 'not a field of kill, which takes state and date' };
  const state = lineProblem(value.state, 'card.kill.state', TASK_CARD_LIMITS.killState);
  if (state) return state;
  if (typeof value.date !== 'string' || !isCalendarDate(value.date))
    return { field: 'card.kill.date', rule: 'a calendar date, YYYY-MM-DD' };
  return null;
}

/** Why a value is not a card a task may carry, or null when it is one. */
export function cardProblem(value: unknown): Problem | null {
  if (!isRecord(value))
    return {
      field: 'card',
      rule: 'an object with valuePerMonth, likelihood, reviewMinutes, daysToSignal and measurability',
    };
  const extra = Object.keys(value).find((key) => !(CARD_FIELDS as readonly string[]).includes(key));
  if (extra !== undefined)
    return { field: `card.${extra}`, rule: `not a field of a card, which takes ${CARD_FIELDS.join(', ')}` };
  const L = TASK_CARD_LIMITS;
  return (
    numberProblem(value.valuePerMonth, 'card.valuePerMonth', L.valuePerMonth) ??
    numberProblem(value.likelihood, 'card.likelihood', L.likelihood) ??
    numberProblem(value.reviewMinutes, 'card.reviewMinutes', L.reviewMinutes) ??
    (value.buildMinutes === undefined
      ? null
      : numberProblem(value.buildMinutes, 'card.buildMinutes', L.buildMinutes)) ??
    numberProblem(value.daysToSignal, 'card.daysToSignal', L.daysToSignal, true) ??
    (oneOf(TASK_MEASURABILITIES, value.measurability)
      ? null
      : { field: 'card.measurability', rule: `one of ${TASK_MEASURABILITIES.join(', ')}` }) ??
    (value.revenueFamily === undefined || oneOf(TASK_REVENUE_FAMILIES, value.revenueFamily)
      ? null
      : { field: 'card.revenueFamily', rule: `one of ${TASK_REVENUE_FAMILIES.join(', ')}` }) ??
    (value.durability === undefined ? null : numberProblem(value.durability, 'card.durability', L.durability)) ??
    killProblem(value.kill) ??
    (value.note === undefined ? null : lineProblem(value.note, 'card.note', L.note)) ??
    (value.by === undefined ? null : lineProblem(value.by, 'card.by', L.by)) ??
    (value.at === undefined || (typeof value.at === 'string' && Number.isFinite(Date.parse(value.at)))
      ? null
      : { field: 'card.at', rule: 'an instant, as ISO 8601' })
  );
}

/** A card that passes cardProblem, as it is stored, with no absent field present. */
export function cardOf(value: unknown): JsonObject | null {
  if (cardProblem(value) !== null) return null;
  const row = value as Record<string, Json>;
  const card: Record<string, Json> = {
    valuePerMonth: row.valuePerMonth!,
    likelihood: row.likelihood!,
    reviewMinutes: row.reviewMinutes!,
    daysToSignal: row.daysToSignal!,
    measurability: row.measurability!,
  };
  for (const key of ['buildMinutes', 'revenueFamily', 'durability', 'note', 'by', 'at'] as const) {
    if (row[key] !== undefined) card[key] = row[key];
  }
  if (row.kill !== undefined) {
    const kill = row.kill as JsonObject;
    card.kill = { state: kill.state!, date: kill.date! };
  }
  return card;
}

/** A card as a caller sends it: its figures, without the by and at only its
 * writer records, or the field at fault and the rule it breaks. */
export function sentCard(value: unknown): { readonly card: JsonObject } | { readonly problem: Problem } {
  const figures = isRecord(value)
    ? Object.fromEntries(Object.entries(value).filter(([name]) => name !== 'by' && name !== 'at'))
    : value;
  const problem = cardProblem(figures);
  return problem === null ? { card: cardOf(figures)! } : { problem };
}

/** The card a task stores: the caller's figures with who recorded them and when. */
export function recordedCard(card: JsonObject, by: string, at: string): JsonObject {
  return { ...card, by: by.slice(0, TASK_CARD_LIMITS.by), at };
}

/** The card a task's metadata holds, or null when it holds none that reads as one. */
export function readCard(metadata: JsonObject): JsonObject | null {
  return cardOf(metadata[NOTICEOS_METADATA.card]);
}

const COMMIT = /^[0-9a-f]{7,64}$/u;

/** The close a task's shipped card records, or null when it carries none that reads as one. */
export function readCardShipped(metadata: JsonObject): { readonly closedAt: string } | null {
  const shipped = metadata[NOTICEOS_METADATA.cardShipped];
  if (!isRecord(shipped) || Object.keys(shipped).some((key) => !['card', 'closedAt', 'commit'].includes(key)))
    return null;
  const { closedAt, commit } = shipped;
  if (cardOf(shipped.card) === null || typeof closedAt !== 'string' || closedAt.length > 64) return null;
  if (!Number.isFinite(Date.parse(closedAt))) return null;
  if (commit !== undefined && (typeof commit !== 'string' || !COMMIT.test(commit))) return null;
  return { closedAt };
}

/** A commit hash as a close reason names it: a word of 7 to 64 lowercase hex
 * digits holding a digit and a letter, as git prints one. A number, a word
 * such as "defaced" and the hash part of a task id are not one. */
const REASON_COMMIT = /(?<![\w-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}(?![\w-])/u;

/** What a close as done keeps of the task's card: the card as it stood, when
 * the task closed and the first commit the reason names. Null for a task
 * without a card, or one that already shipped one: the first ship stands, so
 * a task reopened and done again keeps the prediction it first shipped with. */
export function shippedCard(metadata: JsonObject, reason: string, closedAt: string): JsonObject | null {
  if (readCardShipped(metadata) !== null) return null;
  const card = readCard(metadata);
  if (card === null) return null;
  const commit = REASON_COMMIT.exec(reason)?.[0];
  return { card, closedAt, ...(commit === undefined ? {} : { commit }) };
}

// ─── Change classes ───────────────────────────────────────────────────────────

/** The kinds of change a task makes, which NoticeOS's autonomy ladder and likelihood priors are kept by. */
export const TASK_CHANGE_CLASSES = Object.freeze(['content-data', 'copy', 'template', 'feature', 'infra'] as const);

// ─── Handoff metadata ─────────────────────────────────────────────────────────

/** The label a NoticeOS handoff carries, and the source its metadata names. */
export const HANDOFF_LABEL = 'noticeos-handoff';
/** The fields a copied NoticeOS handoff names its source with, all of them, and nothing else. */
export const HANDOFF_FIELDS = Object.freeze([
  'noticeos_source',
  'noticeos_asset',
  'noticeos_kind',
  'noticeos_rule',
  'noticeos_key',
] as const);
/** The site key plus the six-character `asset:` prefix fits a 128-character label. */
export const HANDOFF_LIMITS = Object.freeze({ asset: 122, value: 2048 });
export const HANDOFF_KINDS = Object.freeze(['query', 'finding', 'page', 'alert'] as const);

/** A copied handoff's complete source identity, or null for anything else. */
export function handoffMetadataOf(value: unknown): JsonObject | null {
  if (!isRecord(value)) return null;
  if (
    Object.keys(value).length !== HANDOFF_FIELDS.length ||
    !HANDOFF_FIELDS.every((key) => Object.hasOwn(value, key)) ||
    Object.values(value).some(
      (entry) =>
        typeof entry !== 'string' ||
        !entry.trim() ||
        entry.length > HANDOFF_LIMITS.value ||
        /[\p{Cc}\p{Cf}]/u.test(entry),
    )
  )
    return null;
  const asset = value.noticeos_asset as string;
  if (
    value.noticeos_source !== HANDOFF_LABEL ||
    !oneOf(HANDOFF_KINDS, value.noticeos_kind) ||
    asset.length > HANDOFF_LIMITS.asset ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(asset)
  )
    return null;
  return Object.fromEntries(HANDOFF_FIELDS.map((key) => [key, value[key] as string]));
}

/** The metadata keys a new task from the web app may carry: what a handoff,
 * a panel review or a task-map report names its source with. Every other key
 * NoticeOS wrote is the server's, or arrives in a field of its own. */
export const SOURCE_METADATA_KEYS: readonly string[] = Object.freeze([
  ...HANDOFF_FIELDS,
  'noticeos_panel_asset',
  'noticeos_panel_date',
  'noticeos_panel_version',
  'noticeos_task_map_asset',
]);

// ─── Approvals ────────────────────────────────────────────────────────────────

/** The longest reason an approval asks with. */
export const GATE_REASON_MAX = 400;

/** Text with its line ends made alike and the spaces around it taken off. */
function normalized(text: string): string {
  return text.replace(/\r\n?/gu, '\n').trim();
}

/** Everything an approval asks, from its gate's description: the text after
 * "Reason:" in a gate imported from Beads when that text is not blank, else
 * the whole description, with its line ends made alike and the spaces around
 * it taken off. */
export function askedOf(description: string): string | null {
  const whole = normalized(description);
  const imported = /(?:^|\n)Reason:[ \t]*([\s\S]+)$/u.exec(whole);
  const reason = normalized(imported?.[1] ?? '') || whole;
  return reason === '' ? null : reason;
}

/** Whether an open approval asks what `reason` asks: its whole description
 * is the reason, or the reason is the whole of a Beads gate's "Reason:" text.
 * A request is compared whole, never by a part of it, so two requests that
 * share a "Reason:" line still open two approvals. */
export function asksAlike(description: string, reason: string): boolean {
  const asked = normalized(reason);
  return asked !== '' && (normalized(description) === asked || askedOf(description) === asked);
}

/** What an approval asks, as an answer shows it: at most GATE_REASON_MAX characters. */
export function gateReason(description: string): string | null {
  return askedOf(description)?.slice(0, GATE_REASON_MAX) ?? null;
}
