/**
 * What the Productivity page's burn-down draws from the days the server
 * counts (docs/api.md, "Burn-down"): each panel's scale, the days the axis
 * names, and the words for a day and for the change in open tasks.
 */
import type { BurndownDay } from '../api/types';
import { formatInt } from './format';

/** A day Ntasks has a record for: every count is a number. */
export type RecordedDay = { [K in keyof BurndownDay]: NonNullable<BurndownDay[K]> };

export function isRecorded(day: BurndownDay): day is RecordedDay {
  return day.open !== null && day.created !== null && day.done !== null && day.closedNotDone !== null;
}

/** The smallest of 1, 2, 3, 4, 5, 6 and 8 times a whole power of ten that is at least `value`, and at least 1. */
export function niceCeil(value: number): number {
  let power = 1;
  for (;;) {
    for (const step of [1, 2, 3, 4, 5, 6, 8]) if (step * power >= value) return step * power;
    power *= 10;
  }
}

/** The days the axis names: the last, and each one a week before it. */
export function weekTicks(days: readonly BurndownDay[]): number[] {
  const ticks: number[] = [];
  for (let index = days.length - 1; index >= 0; index -= 7) ticks.unshift(index);
  return ticks;
}

/** Whether any recorded day holds a task: open, created or closed. */
export function holdsTasks(days: readonly BurndownDay[]): boolean {
  return days.some((day) => isRecorded(day) && day.open + day.created + day.done + day.closedNotDone > 0);
}

/** How the open count moved from the end of the first recorded day to the last day; null with fewer than two recorded. */
export function openChange(days: readonly BurndownDay[]): { since: string; change: number } | null {
  const first = days.find(isRecorded);
  const last = days.at(-1);
  if (first === undefined || last === undefined || !isRecorded(last) || first === last) return null;
  return { since: first.day, change: last.open - first.open };
}

/** A recorded day's counts in words, a close not done left out at none: `312 open, 14 created, 20 done`. */
export function dayCounts(day: RecordedDay): string {
  return [
    `${formatInt(day.open)} open`,
    `${formatInt(day.created)} created`,
    `${formatInt(day.done)} done`,
    day.closedNotDone > 0 ? `${formatInt(day.closedNotDone)} closed, not done` : null,
  ]
    .filter((part) => part !== null)
    .join(', ');
}
