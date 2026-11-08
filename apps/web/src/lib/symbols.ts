/**
 * Which symbol a task, a priority, a type or a person gets, as plain
 * functions. src/components/ui/symbols.tsx and avatar.tsx draw what these
 * return; docs/design.md lists every symbol and when it is used.
 */
import type { LiveTask } from '@/api/types';
import { IN_PROGRESS, isGate, PARKED, PRIORITY_BANDS, priorityBand, waitsOnPerson, waitsOnTask } from './task-model';

// --- Status -------------------------------------------------------------------

/** The six status marks, in the order a list groups them. */
export const STATUS_MARKS = ['waiting', 'in-progress', 'open', 'blocked', 'parked', 'done'] as const;
export type StatusMark = (typeof STATUS_MARKS)[number];

export const STATUS_MARK_LABELS: Readonly<Record<StatusMark, string>> = Object.freeze({
  open: 'Open',
  'in-progress': 'In progress',
  blocked: 'Blocked',
  waiting: 'Waiting for you',
  parked: 'Parked',
  done: 'Done',
});

type StatusFacts = Pick<LiveTask, 'status' | 'issueType' | 'labels' | 'ready' | 'awaitType' | 'dependencies'> &
  Pick<Partial<LiveTask>, 'choices' | 'choice'>;

/**
 * The mark a task shows. Closed and parked come from the stored status. Of
 * the live tasks, one a person must answer is Waiting for you, unless an
 * approval holds it: then the approval is the one question, and the task,
 * like one that is blocked or open and waiting on a task that is not closed,
 * is Blocked. `statuses` holds the other tasks' current statuses by id, for
 * links whose own read did not carry one; `held` the ids of the tasks a
 * pending approval holds (`readBoard`). A status this build does not know
 * shows as Open.
 */
export function statusMarkFor(
  task: StatusFacts & { id: string },
  statuses: ReadonlyMap<string, string> = new Map(),
  held: ReadonlySet<string> = new Set(),
): StatusMark {
  if (task.status === 'closed') return 'done';
  if (task.status === PARKED) return 'parked';
  if (held.has(task.id)) return 'blocked';
  if (waitsOnPerson(task)) return 'waiting';
  if (task.status === 'blocked' || waitsOnTask(task, statuses)) return 'blocked';
  if (task.status === IN_PROGRESS) return 'in-progress';
  return 'open';
}

/** The mark for a stored status alone, for a linked task whose other facts the read did not carry. */
export function statusMarkOfStored(stored: string): StatusMark {
  if (stored === 'closed') return 'done';
  if (stored === PARKED) return 'parked';
  if (stored === 'blocked') return 'blocked';
  if (stored === IN_PROGRESS) return 'in-progress';
  return 'open';
}

// --- Priority -----------------------------------------------------------------

/** Priority 0 to 4 in words, Top to Lowest. */
export const PRIORITY_LABELS = ['Top', 'High', 'Normal', 'Low', 'Lowest'] as const;
export type PriorityLabel = (typeof PRIORITY_LABELS)[number];

/** A priority outside 0 to 4 takes the nearest band's word. */
export function priorityLabel(priority: number): PriorityLabel {
  return PRIORITY_LABELS[PRIORITY_BANDS.indexOf(priorityBand(priority))] ?? 'Normal';
}

/** How many of the three bars a priority fills; Top draws its own mark and Lowest none. */
export function priorityBars(priority: number): 0 | 1 | 2 | 3 {
  const band = priorityBand(priority);
  return band === 'high' ? 3 : band === 'normal' ? 2 : band === 'low' ? 1 : 0;
}

// --- Type ---------------------------------------------------------------------

export const TYPE_MARKS = ['task', 'bug', 'feature', 'epic', 'decision', 'approval', 'chore', 'gate', 'other'] as const;
export type TypeMark = (typeof TYPE_MARKS)[number];

export const TYPE_MARK_LABELS: Readonly<Record<Exclude<TypeMark, 'other'>, string>> = Object.freeze({
  task: 'Task',
  bug: 'Bug',
  feature: 'Feature',
  epic: 'Epic',
  decision: 'Decision',
  approval: 'Approval',
  chore: 'Chore',
  gate: 'Gate',
});

/** A stored type as its mark. A gate a person answers is an Approval; any other gate waits on a system. */
export function typeMarkFor(issueType: string, awaitType: string | null = null): TypeMark {
  if (isGate({ issueType, awaitType })) return (awaitType ?? 'human') === 'human' ? 'approval' : 'gate';
  return (TYPE_MARKS as readonly string[]).includes(issueType) ? (issueType as TypeMark) : 'other';
}

/** A type in words; a type this build does not know is shown as itself. */
export function typeLabel(issueType: string, awaitType: string | null = null): string {
  const mark = typeMarkFor(issueType, awaitType);
  return mark === 'other' ? issueType.charAt(0).toUpperCase() + issueType.slice(1) : TYPE_MARK_LABELS[mark];
}

// --- People and agents ----------------------------------------------------------

export type AvatarFace =
  | { kind: 'person'; initials: string }
  | { kind: 'claude' }
  | { kind: 'codex' }
  /** An agent with no brand mark of its own. */
  | { kind: 'agent' };

const CLAUDE = /\bclaude\b|anthropic/i;
const CODEX = /codex|openai|\bgpt\b/i;

/**
 * The prefixes the API gives a non-person actor: `agent:<name>`, and
 * `service:<credential>` or `service:<credential>/<agent>` for a service and
 * the agent it acts for. A person whose own name starts like one is recorded
 * as `person:<name>` (docs/sign-in.md).
 */
const AGENT_ACTOR = /^(?:agent|service):/;
const PERSON_ACTOR = /^person:/;

/** Whether the API records this actor as an agent or a service rather than a person. */
export function isAgentActor(actor: string): boolean {
  return AGENT_ACTOR.test(actor);
}

/**
 * Who an avatar shows. Only an agent gets a brand mark: an actor the API
 * records as an agent or a service, one that named a model, or one the
 * caller knows to be an agent. Such an actor whose name or model names
 * Claude or Codex gets that mark, and any other gets the plain agent mark.
 * Everyone else is a person, shown by initials, whatever their name says.
 */
export function avatarFace({
  name,
  model = null,
  agent = false,
}: {
  name: string;
  model?: string | null;
  agent?: boolean;
}): AvatarFace {
  const isAgent = agent || AGENT_ACTOR.test(name) || (model ?? '').trim() !== '';
  if (!isAgent) return { kind: 'person', initials: initials(name.replace(PERSON_ACTOR, '')) };
  const said = `${name} ${model ?? ''}`;
  if (CLAUDE.test(said)) return { kind: 'claude' };
  if (CODEX.test(said)) return { kind: 'codex' };
  return { kind: 'agent' };
}

/** Up to two letters: the first of the first and last words, so "Example Owner" is EO and an address its first letter. */
export function initials(name: string): string {
  const words = name
    .replace(/@.*$/, '')
    .split(/[\s._:/-]+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  const letters = `${first}${last}`.toUpperCase();
  return letters === '' ? '?' : letters;
}

/** The share of an avatar's width a brand mark is drawn at, the same for every mark. */
export const AVATAR_MARK_SHARE = 0.62;

export function avatarMarkSize(avatarSize: number): number {
  return Math.round(avatarSize * AVATAR_MARK_SHARE);
}

// --- Workspaces -------------------------------------------------------------------

/**
 * The fills a workspace's icon is drawn on, each with its letter's colour.
 * Accent, amber, red and green keep their one meaning each, so these are
 * greys, chosen to stay apart from one another in both themes.
 */
export const WORKSPACE_TONES = [
  'bg-ink text-background',
  'bg-ink-2 text-background',
  'bg-ink-3 text-background',
  'bg-avatar text-avatar-ink',
] as const;

/**
 * A workspace's icon: the first letter or digit of its name, uppercase, on
 * the tone its id picks. The id never changes, so a rename changes the
 * letter and keeps the tone.
 */
export function workspaceMark(workspaceId: string, name: string): { letter: string; tone: string } {
  const first = /[\p{L}\p{N}]/u.exec(name)?.[0] ?? Array.from(name.trim())[0] ?? '?';
  let hash = 0;
  for (let at = 0; at < workspaceId.length; at += 1) hash = Math.imul(hash, 31) + workspaceId.charCodeAt(at);
  const tone = WORKSPACE_TONES[(hash >>> 0) % WORKSPACE_TONES.length] ?? WORKSPACE_TONES[0];
  return { letter: Array.from(first.toUpperCase())[0] ?? '?', tone };
}

// --- Keys -----------------------------------------------------------------------

/** Whether a key press belongs to a text field the person is typing in, or to a dialog, menu or list that takes its own keys, so a page's single-key shortcuts leave it alone. */
export function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  // A dialog, a menu and a list of options take their own keys.
  if (target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(target.type);
  }
  return false;
}

/**
 * Whether a key press is the single-key shortcut `key`: no Ctrl, Alt or
 * Command, not typed into a field, and not already handled. Letters match
 * either case.
 */
export function isShortcut(
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'defaultPrevented' | 'target'>,
  key: string,
): boolean {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || typingIn(event.target)) return false;
  return key.length === 1 ? event.key.toLowerCase() === key.toLowerCase() : event.key === key;
}
