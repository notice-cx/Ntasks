/**
 * A change to a task in a few words, as the Live board labels the card that
 * changed: "commented", "pushed a commit", "opened #42", "merged #42".
 */
import type { TaskWork } from '@ntasks/domain';
import type { LiveTask, TaskChange } from '../api/types';

/** A pull request's number from its URL, as `#42`, or its kind when the URL names none. */
export function pullRequestLabel(url: string): string {
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return number === undefined ? 'Pull request' : `#${number}`;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * What a work update did, from the holder's work details before and after.
 * The feed records the whole set after the change, so the one that differs
 * names it; a commit says most about progress, so it wins over the rest.
 */
function workWords(after: Record<string, unknown>, before: TaskWork | null | undefined): string | null {
  const changed = (detail: 'commit' | 'pr' | 'next' | 'branch') => {
    const now = text(after[detail]);
    return now !== null && now !== (before?.[detail] ?? null) ? now : null;
  };
  if (changed('commit') !== null) return 'pushed a commit';
  const pr = changed('pr');
  if (pr !== null) return `opened ${pullRequestLabel(pr)}`;
  if (changed('next') !== null) return 'set the next step';
  if (changed('branch') !== null) return 'started a branch';
  return null;
}

/**
 * The words for `change`, after its actor's name, or null when it did
 * nothing worth a label, such as a link added to another task. `before` is
 * the task as the page held it before the change, which a work update needs.
 */
export function changeWords(change: TaskChange, before?: Pick<LiveTask, 'work'> | null): string | null {
  const fields = change.changes ?? {};
  switch (change.kind) {
    case 'commented':
      return 'commented';
    case 'created':
      return 'created it';
    case 'closed':
      return 'closed it';
    case 'reopened':
      return 'reopened it';
    case 'updated':
      break;
    default:
      return null;
  }
  const delivery = record(fields.delivery);
  if (delivery !== null) {
    const pr = text(delivery.pullRequest);
    const what = pr === null ? 'it' : pullRequestLabel(pr);
    if (delivery.stage === 'merged') return `merged ${what}`;
    if (delivery.stage === 'live') return `deployed ${what}`;
  }
  if ('assignee' in fields) return fields.assignee === null ? 'freed it' : 'claimed it';
  const work = record(fields.work);
  return work === null ? null : workWords(work, before?.work);
}
