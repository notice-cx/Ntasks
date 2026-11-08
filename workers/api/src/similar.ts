/**
 * Possible duplicates of a new task: open tasks whose titles share most of
 * their words with its title. A word-overlap score over tasks already read,
 * so it costs no read and no index of its own.
 */
import type { Task, TaskStatus } from '@ntasks/domain';

/** Words too common in titles to make two of them alike. */
const COMMON = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'our',
  'than',
  'that',
  'the',
  'then',
  'this',
  'to',
  'via',
  'when',
  'with',
]);

function wordsOf(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1 && !COMMON.has(word)),
  );
}

/** The words two titles share, over the words of the longer one: 0 to 1. */
export function titleOverlap(a: string, b: string): number {
  const left = wordsOf(a);
  const right = wordsOf(b);
  const longer = Math.max(left.size, right.size);
  if (longer === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / longer;
}

/** The most possible duplicates a new task's answer names. */
const MOST = 3;

export interface PossibleDuplicate {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
}

/**
 * Up to three of `tasks`, leaving out those `except` names, whose titles
 * share more than half the words of the longer title with `title`, most alike
 * first and otherwise in the order given.
 */
export function possibleDuplicates(
  title: string,
  tasks: readonly Task[],
  except: ReadonlySet<string>,
): PossibleDuplicate[] {
  return tasks
    .filter((task) => !except.has(task.id) && task.status !== 'closed')
    .map((task, place) => ({ task, place, score: titleOverlap(title, task.title) }))
    .filter((entry) => entry.score > 0.5)
    .sort((a, b) => b.score - a.score || a.place - b.place)
    .slice(0, MOST)
    .map(({ task }) => ({ id: task.id, title: task.title, status: task.status }));
}
