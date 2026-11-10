/**
 * What the Productivity page shows of the wins the server reads (docs/api.md,
 * "Wins"): the day each win falls on and the words for it. Days are UTC, as
 * the server counts them.
 */
import type { Win, WinsDay, WinsPage } from '../api/types';

const DAY_LABEL = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });

/** A UTC day `YYYY-MM-DD` as `Tue, Nov 10`. */
export function winsDayLabel(day: string): string {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isNaN(at) ? day : DAY_LABEL.format(at);
}

/** A UTC day `YYYY-MM-DD` as its weekday and date, `Tue 10`, for the strip of days. */
export function winsDayShort(day: string): string {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isNaN(at) ? day : `${WEEKDAY.format(at)} ${Number(day.slice(8))}`;
}

/** The wins of each day that has any, newest day first, each day's newest win first. */
export function winsByDay(wins: readonly Win[]): { day: string; wins: Win[] }[] {
  const days = new Map<string, Win[]>();
  for (const win of wins) {
    const day = win.at.slice(0, 10);
    const list = days.get(day);
    if (list) list.push(win);
    else days.set(day, [win]);
  }
  return [...days]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, list]) => ({ day, wins: [...list].sort((a, b) => b.at.localeCompare(a.at)) }));
}

/** A day's wins in words, kinds with none left out: `42 shipped, 10 decided, 1 epic finished`. */
export function winsDayRule(counts: Pick<WinsDay, 'shipped' | 'decided' | 'finished'>): string {
  return [
    counts.shipped > 0 ? `${counts.shipped} shipped` : null,
    counts.decided > 0 ? `${counts.decided} decided` : null,
    counts.finished > 0 ? `${counts.finished} ${counts.finished === 1 ? 'epic' : 'epics'} finished` : null,
  ]
    .filter((part) => part !== null)
    .join(', ');
}

/** The counts of one day's wins, by kind. */
export function countsOf(wins: readonly Win[]): Pick<WinsDay, 'shipped' | 'decided' | 'finished'> {
  const counts = { shipped: 0, decided: 0, finished: 0 };
  for (const win of wins) counts[win.kind]++;
  return counts;
}

/** A pull request's number from its URL, as `#42`, or its kind when the URL names none. */
export function pullRequestLabel(url: string): string {
  const number = /\/pull\/(\d+)/u.exec(url)?.[1];
  return number === undefined ? 'Pull request' : `#${number}`;
}

/** The first day a change shipped among these pages, when no change shipped before them. */
export function firstShipped(pages: readonly WinsPage[]): string | null {
  const oldest = pages.at(-1);
  if (oldest === undefined || oldest.shippedBefore) return null;
  const days = pages.flatMap((page) => page.days).filter((day) => day.shipped > 0);
  return days.map((day) => day.day).sort()[0] ?? null;
}
