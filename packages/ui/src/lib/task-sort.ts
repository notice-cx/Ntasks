/**
 * The order a task page is read in, chosen in its Sort menu and kept in the
 * address (`?sort=created&dir=asc`), so a sorted page is a link. Without one,
 * each list keeps its own order: the board's most urgent first, Waiting for
 * you's by what an answer releases, the Epics tab's by priority and change.
 * A board holds every task it shows, so the page sorts what it read and
 * reads nothing again.
 */
import {
  DEFAULT_SORT_DIRECTIONS,
  isSortDirection,
  isTaskSort,
  TASK_SORTS,
  taskComparator,
  type SortDirection,
  type SortFacts,
  type TaskSort,
} from '@ntasks/domain';

export { DEFAULT_SORT_DIRECTIONS, TASK_SORTS, type SortDirection, type TaskSort };

export interface PageSort {
  by: TaskSort;
  direction: SortDirection;
}

export const SORT_LABELS: Readonly<Record<TaskSort, string>> = Object.freeze({
  priority: 'Priority',
  created: 'Created',
  updated: 'Last change',
  closed: 'Closed',
  title: 'Title',
});

/** Each direction in the words of its sort. */
export function directionLabel(by: TaskSort, direction: SortDirection): string {
  if (by === 'priority') return direction === 'asc' ? 'Most urgent first' : 'Least urgent first';
  if (by === 'title') return direction === 'asc' ? 'A to Z' : 'Z to A';
  return direction === 'desc' ? 'Newest first' : 'Oldest first';
}

/** The sort an address names, or null for each list's own order. */
export function sortOf(params: URLSearchParams): PageSort | null {
  const by = params.get('sort');
  if (!isTaskSort(by)) return null;
  const dir = params.get('dir');
  return { by, direction: isSortDirection(dir) ? dir : DEFAULT_SORT_DIRECTIONS[by] };
}

/** The address's sort and dir for `sort`: none for each list's own order, and no dir for a sort's own direction. */
export function sortParams(sort: PageSort | null): { sort: string; dir: string } {
  if (sort === null) return { sort: '', dir: '' };
  return { sort: sort.by, dir: sort.direction === DEFAULT_SORT_DIRECTIONS[sort.by] ? '' : sort.direction };
}

/** `rows` in `sort`'s order, as a new list; `rows` as they are without one. A task is its own facts. */
export function sorted<T>(
  rows: readonly T[],
  sort: PageSort | null,
  facts: (row: T) => SortFacts = (row) => row as SortFacts,
): T[] {
  if (sort === null) return [...rows];
  const compare = taskComparator(sort.by, sort.direction);
  return [...rows].sort((a, b) => compare(facts(a), facts(b)));
}
