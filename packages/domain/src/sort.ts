/**
 * The orders a list of tasks can be read in, the same in the web app and in
 * the agent tools: by priority, when created, when last changed, when closed
 * or by title, each ascending or descending. Ties fall back to the default
 * order, most urgent first: priority, then the oldest, then the id.
 */

export const TASK_SORTS = ['priority', 'created', 'updated', 'closed', 'title'] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/** The direction each sort reads in when none is named: the most urgent first, the newest first, A to Z. */
export const DEFAULT_SORT_DIRECTIONS: Readonly<Record<TaskSort, SortDirection>> = Object.freeze({
  priority: 'asc',
  created: 'desc',
  updated: 'desc',
  closed: 'desc',
  title: 'asc',
});

export function isTaskSort(value: unknown): value is TaskSort {
  return (TASK_SORTS as readonly unknown[]).includes(value);
}

export function isSortDirection(value: unknown): value is SortDirection {
  return (SORT_DIRECTIONS as readonly unknown[]).includes(value);
}

/** What a sort reads of a task. Times are ISO 8601 in UTC, which order as text. */
export interface SortFacts {
  readonly id: string;
  readonly title: string;
  readonly priority: number;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly closedAt: string | null;
}

const TITLES = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The default order: priority, then the oldest, then the id. A task with no time recorded comes after those with one. */
export function byDefaultOrder(a: SortFacts, b: SortFacts): number {
  return a.priority - b.priority || compareTimes(a.createdAt, b.createdAt) || compareText(a.id, b.id);
}

function compareTimes(a: string | null, b: string | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return compareText(a, b);
}

const TIME: Readonly<Record<'created' | 'updated' | 'closed', keyof SortFacts>> = {
  created: 'createdAt',
  updated: 'updatedAt',
  closed: 'closedAt',
};

/**
 * Compares two tasks by `sort` read in `direction`, then by the default order.
 * A task without the time a sort reads, such as an open task's close, comes
 * last in either direction.
 */
export function taskComparator(
  sort: TaskSort,
  direction: SortDirection = DEFAULT_SORT_DIRECTIONS[sort],
): (a: SortFacts, b: SortFacts) => number {
  const sign = direction === 'asc' ? 1 : -1;
  return (a, b) => {
    let first: number;
    if (sort === 'priority') first = sign * (a.priority - b.priority);
    else if (sort === 'title') first = sign * TITLES.compare(a.title, b.title);
    else {
      const x = a[TIME[sort]] as string | null;
      const y = b[TIME[sort]] as string | null;
      if (x === null || y === null) first = x === y ? 0 : x === null ? 1 : -1;
      else first = sign * compareText(x, y);
    }
    return first || byDefaultOrder(a, b);
  };
}
