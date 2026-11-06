/**
 * Checks of a tool call's arguments. A failed check refuses the call with a
 * sentence the model reads, naming the argument and what it must be.
 */
import { isTaskId } from '@ntasks/domain';
import { McpToolError } from './protocol.ts';

export type Args = Record<string, unknown>;

export function refuse(message: string): never {
  throw new McpToolError(message);
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
