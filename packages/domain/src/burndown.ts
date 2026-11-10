/**
 * The open tasks of some projects, day by day, for the Productivity page's
 * burn-down: each day's tasks created, closed as done and closed any other
 * way, and the tasks still open at its end. A task is open from when it was
 * created until it closes. A task holds only its latest close, so a task
 * reopened counts as open from its creation until it closes again, and only
 * that close counts. No task closed before the first day was open on any of
 * the days, so the count needs only the tasks not closed and those closed
 * from the first day on. A day that ends before the projects' first record
 * holds null, never zero.
 */
import { addDays, zoneDays } from './days.ts';
import type { TaskResolution } from './task.ts';

/** The days a burn-down covers: eight weeks, today included. */
export const BURNDOWN_DAYS = 56;

/** What a burn-down reads of one task. */
export interface BurndownItem {
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly resolution: TaskResolution | null;
}

/** What a burn-down reads of some projects' tasks. */
export interface BurndownRead {
  /** The tasks not closed, and those closed from the first day on. */
  readonly items: readonly BurndownItem[];
  /** Whether any of these projects holds a task closed before the first day. */
  readonly closedBefore: boolean;
}

/** One day of a burn-down. Every count is null when nothing was recorded by the day's end. */
export interface BurndownDay {
  /** The day in the burn-down's time zone, as YYYY-MM-DD. */
  readonly day: string;
  /** The tasks not closed at the end of the day; for today, now. */
  readonly open: number | null;
  readonly created: number | null;
  /** The tasks closed as done. */
  readonly done: number | null;
  /** The tasks closed any other way: won't do, duplicate, can't reproduce, already handled or no longer needed. */
  readonly closedNotDone: number | null;
}

/** The days a burn-down covers, each cut at midnight in `timeZone`. */
export interface BurndownWindow {
  readonly timeZone: string;
  /** The first day's first instant. */
  readonly from: string;
  /** The instant after the last day: tomorrow's midnight. */
  readonly to: string;
  /** Each day, oldest first, as YYYY-MM-DD. */
  readonly days: readonly string[];
  /** Each day's first instant in milliseconds, then `to`'s: one more than `days`. */
  readonly bounds: readonly number[];
}

/** The BURNDOWN_DAYS days up to and including today in `timeZone`, as of `nowMs`. */
export function burndownWindow(nowMs: number, timeZone = 'UTC'): BurndownWindow {
  const { dayIn, dayStart } = zoneDays(timeZone);
  const today = dayIn(nowMs);
  const days = Array.from({ length: BURNDOWN_DAYS }, (_, i) => addDays(today, i + 1 - BURNDOWN_DAYS));
  const bounds = [...days, addDays(today, 1)].map(dayStart);
  return {
    timeZone,
    from: new Date(bounds[0]!).toISOString(),
    to: new Date(bounds.at(-1)!).toISOString(),
    days,
    bounds,
  };
}

/**
 * Each day of `window` counted from `read`, and the first day with a record:
 * the day any of the projects was created, or any of their tasks, whichever
 * came first. `projectsCreatedAt` holds when each project was created.
 */
export function burndownDays(
  read: BurndownRead,
  projectsCreatedAt: readonly string[],
  window: Pick<BurndownWindow, 'days' | 'bounds'>,
): { readonly recordedFrom: string | null; readonly days: readonly BurndownDay[] } {
  const { days, bounds } = window;
  const n = days.length;
  /** The day `ms` falls on: -1 before the first day, n from the end of the last. */
  const dayOf = (ms: number) => {
    let low = 0;
    let high = bounds.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (bounds[mid]! <= ms) low = mid + 1;
      else high = mid;
    }
    return low - 1;
  };
  const created = new Array<number>(n).fill(0);
  const done = new Array<number>(n).fill(0);
  const closedNotDone = new Array<number>(n).fill(0);
  // How the open count changes at the end of each day: +1 where a task starts
  // being open at a day's end, -1 where it stops.
  const change = new Array<number>(n + 1).fill(0);
  // A task closed before the first day proves records from before it.
  let first = read.closedBefore ? -Infinity : Infinity;
  for (const at of projectsCreatedAt) first = Math.min(first, Date.parse(at));
  for (const item of read.items) {
    const made = Date.parse(item.createdAt);
    first = Math.min(first, made);
    const madeOn = dayOf(made);
    if (madeOn >= 0 && madeOn < n) created[madeOn]!++;
    let closedOn = n;
    if (item.closedAt !== null) {
      closedOn = dayOf(Date.parse(item.closedAt));
      if (closedOn >= 0 && closedOn < n) (item.resolution === 'done' ? done : closedNotDone)[closedOn]!++;
    }
    // Open at the end of each day from the day it was created to the day before it closed.
    const start = Math.max(madeOn, 0);
    const end = Math.min(closedOn, n);
    if (start < end) {
      change[start]!++;
      change[end]!--;
    }
  }
  let open = 0;
  const counted = days.map((day, i): BurndownDay => {
    open += change[i]!;
    if (!(first < bounds[i + 1]!)) return { day, open: null, created: null, done: null, closedNotDone: null };
    return { day, open, created: created[i]!, done: done[i]!, closedNotDone: closedNotDone[i]! };
  });
  return { recordedFrom: counted.find((day) => day.open !== null)?.day ?? null, days: counted };
}
