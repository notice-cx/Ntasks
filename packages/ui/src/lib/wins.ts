/**
 * What the Productivity page shows of the wins the server reads (docs/api.md,
 * "Wins"): the day each win falls on, in the person's time zone, and the
 * words for it.
 */
import type { Win, WinsDay, WinsPage } from '../api/types';
import { dayIn } from './dates';

/** The wins of each day in `zone` that has any, newest day first, each day's newest win first. */
export function winsByDay(wins: readonly Win[], zone: string): { day: string; wins: Win[] }[] {
  const days = new Map<string, Win[]>();
  for (const win of wins) {
    const day = dayIn(Date.parse(win.at), zone);
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
