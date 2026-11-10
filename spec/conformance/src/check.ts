/**
 * A check: one rule of the protocol, tested from outside the server. Each
 * names the rule it tests and that rule's section, the conformance level
 * the rule belongs to, and what it needs from the target. The runner runs a
 * check once on each binding the server offers; a check calls the binding
 * under test through `api` and arranges what it needs through `setup`.
 */
import { isDeepStrictEqual } from 'node:util';
import type { Api, HistoryEvent, Outcome, Refusal, Role, TaskRead } from './api.ts';
import type { BindingName, Level, Target } from './target.ts';

export interface Check {
  /** Unique, stable, and starting with the rule's id in lowercase. */
  readonly id: string;
  /** The rule it tests, such as `INV-1`. */
  readonly rule: string;
  readonly level: Level;
  /** What a server that keeps the rule does, in one sentence. */
  readonly title: string;
  /** `should`: the rule is a SHOULD, so a failure is reported and fails nothing. */
  readonly strength?: 'must' | 'should';
  /** Senders beyond the two agents. */
  readonly senders?: readonly Role[];
  /** Projects beyond `main`. */
  readonly projects?: readonly ('readOnly' | 'hidden')[];
  /** For a rule of one binding: the check runs on that binding only, and applies to no server that lacks it. */
  readonly binding?: BindingName;
  run(context: Context): Promise<void>;
}

export interface Context {
  readonly binding: BindingName;
  readonly target: Target;
  /** The binding under test, as `role` (an agent when left out). */
  api(role?: Role): Api;
  /** The binding the check arranges its tasks through: MCP when the server offers it, else the one under test. */
  setup(role?: Role): Api;
  /** A text unique to this run of this check, for titles, keys and model names. */
  unique(label: string): string;
  /** A fresh idempotency key. */
  key(): string;
}

/** The file and anchor of a rule's section, relative to the spec folder. */
export function sectionOf(rule: string): string {
  const anchor = rule.toLowerCase();
  if (rule.startsWith('MCP-')) return `mcp-profile.md#${anchor}`;
  if (rule.startsWith('HTTP-')) return `http-binding.md#${anchor}`;
  return `protocol.md#${anchor}`;
}

export class CheckFailed extends Error {}

export function fail(message: string): never {
  throw new CheckFailed(message);
}

export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

export function same(actual: unknown, expected: unknown, what: string): void {
  if (!isDeepStrictEqual(actual, expected))
    fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** The value of an answered call; fails the check when the call was refused. */
export function answered<T>(outcome: Outcome<T>, what: string): T {
  if (!outcome.ok) fail(`${what} was refused: ${firstLine(outcome.refusal.text)}`);
  return outcome.value;
}

/** The refusal of a refused call; fails the check when the call was answered. */
export function refused(outcome: Outcome<unknown>, what: string): Refusal {
  if (outcome.ok) fail(`${what} was answered, but the rule refuses it: ${short(outcome.value)}`);
  return outcome.refusal;
}

const firstLine = (text: string) => text.split('\n')[0] ?? '';
const short = (value: unknown) => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
};

/** What a task's record holds, to tell afterwards whether anything was written to it. */
export interface Snapshot {
  readonly read: TaskRead;
  readonly history: readonly HistoryEvent[];
}

export async function snapshot(api: Api, task: string): Promise<Snapshot> {
  return {
    read: answered(await api.read(task), `reading ${task}`),
    history: answered(await api.history(task), `reading ${task}'s history`),
  };
}

/** Fails the check when `task` changed since `before`: a field, a comment or a history event, added or edited. */
export async function unchanged(api: Api, task: string, before: Snapshot, what: string): Promise<void> {
  const after = await snapshot(api, task);
  const strip = (read: TaskRead) => {
    const { readAt: _readAt, ...task } = read.task as Record<string, unknown>;
    return { task, comments: read.comments };
  };
  same(strip(after.read), strip(before.read), `${what} left ${task} and its comments as they were`);
  same(after.history, before.history, `${what} left ${task}'s history as it was`);
}
