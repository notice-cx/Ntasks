/**
 * A project's custom fields as the pages read and write them: a typed value
 * from the words a person typed, a value in words, and whether a task holds
 * the value a board's filter names. The rules for each type are the API's
 * (docs/api.md, "custom fields").
 */
import { TASK_LIMITS } from '@ntasks/domain';
import type { TaskField, TaskFieldValue } from '@/api/types';

/** The field types the pages draw an editor for; a type this build does not know is shown as its value, read-only. */
export const KNOWN_FIELD_TYPES = [
  'text',
  'number',
  'date',
  'single-choice',
  'multiple-choice',
  'url',
  'yes-no',
] as const;
export type KnownFieldType = (typeof KNOWN_FIELD_TYPES)[number];

export function isKnownFieldType(type: string): type is KnownFieldType {
  return (KNOWN_FIELD_TYPES as readonly string[]).includes(type);
}

/** Whether a field takes new values: it is in use and of a type this build knows. */
export function fieldEditable(field: TaskField): boolean {
  return field.retiredAt === null && isKnownFieldType(field.type);
}

/** An http or https address as the URL standard writes it, or null for anything else. */
export function httpUrl(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.length > TASK_LIMITS.externalLinkUrl) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `text` is a real calendar day written `YYYY-MM-DD`. */
export function isCalendarDate(text: string): boolean {
  const parts = CALENDAR_DATE.exec(text);
  if (parts === null) return false;
  const [year, month, day] = parts.slice(1).map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The value of a typed field (text, number, date or URL) from what a person typed, or what is wrong with it. */
export function parseFieldInput(type: string, text: string): Parsed<TaskFieldValue> {
  const trimmed = text.trim();
  switch (type) {
    case 'number': {
      const value = trimmed === '' ? Number.NaN : Number(trimmed);
      return Number.isFinite(value) ? { ok: true, value } : { ok: false, error: 'Not a number' };
    }
    case 'date':
      return isCalendarDate(trimmed) ? { ok: true, value: trimmed } : { ok: false, error: 'Not a date' };
    case 'url': {
      const url = httpUrl(trimmed);
      return url === null ? { ok: false, error: 'Not an http or https address' } : { ok: true, value: url };
    }
    default:
      if (trimmed === '') return { ok: false, error: 'Empty' };
      return trimmed.length > TASK_LIMITS.fieldText
        ? { ok: false, error: `Longer than ${TASK_LIMITS.fieldText} characters` }
        : { ok: true, value: trimmed };
  }
}

/** A multiple-choice value with `option` turned on or off, in the field's order; null when none is left on. */
export function toggledOptions(
  field: TaskField,
  held: TaskFieldValue | undefined,
  option: string,
  on: boolean,
): string[] | null {
  const now = new Set(Array.isArray(held) ? held : []);
  if (on) now.add(option);
  else now.delete(option);
  const next = (field.options ?? []).filter((candidate) => now.has(candidate));
  return next.length === 0 ? null : next;
}

/** Whether a task's value is the one a board's filter names, as the API matches it: a multiple-choice value includes the option. */
export function fieldMatches(
  field: Pick<TaskField, 'type'>,
  value: TaskFieldValue | undefined,
  wanted: string,
): boolean {
  if (value === undefined) return false;
  switch (field.type) {
    case 'number':
      return wanted.trim() !== '' && typeof value === 'number' && value === Number(wanted);
    case 'yes-no':
      return typeof value === 'boolean' && String(value) === wanted;
    case 'multiple-choice':
      return Array.isArray(value) && value.includes(wanted);
    case 'url':
      return typeof value === 'string' && value === (httpUrl(wanted) ?? wanted);
    default:
      return value === wanted;
  }
}

/** A filter's value in words, as its badge shows it. */
export function filterValueText(field: Pick<TaskField, 'type'> | undefined, wanted: string): string {
  if (field?.type === 'yes-no') return wanted === 'true' ? 'Yes' : wanted === 'false' ? 'No' : wanted;
  return wanted;
}
