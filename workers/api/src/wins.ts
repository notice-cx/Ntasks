/**
 * The wins feed: what a workspace got done that matters, day by day, for the
 * Productivity page. A win is a change that reached merged or live, a
 * person's answer to a task's choices, or an epic closed as done. It counts
 * approvals closed as done too, without listing them. A pull request is one
 * win however many tasks closed with it, and a close as won't do, duplicate
 * or no longer needed is never one. Nothing here counts tasks closed, which
 * an agent can raise by splitting work.
 */
import type { Project, WinItem } from '@ntasks/domain';
import { reachable } from './auth.ts';
import { projectOf, type Reader } from './lookup.ts';

const DAY = 86_400_000;
/** The days one read covers. */
export const WIN_DAYS = 7;
/** How far back the feed reaches: eight weeks, today included. */
export const WIN_HISTORY_DAYS = 56;
/** How long after its task closed a change is still found when it merges.
 * A change merged later than this is not a win; the read stays within the
 * closes of these weeks rather than the whole history. */
export const WIN_MERGE_LAG_DAYS = 28;

export interface WinTask {
  readonly id: string;
  readonly title: string;
}
/** A change that merged or went live: its pull request, or its commit when it has none, with the tasks it closed. */
export interface ShippedWin {
  readonly kind: 'shipped';
  readonly at: string;
  readonly projectId: string;
  readonly stage: 'merged' | 'live';
  readonly pullRequest: string | null;
  readonly commit: string | null;
  readonly tasks: readonly WinTask[];
}
/** A person's answer to a task's choices. */
export interface DecidedWin {
  readonly kind: 'decided';
  readonly at: string;
  readonly projectId: string;
  readonly id: string;
  readonly title: string;
  readonly option: string;
  readonly label: string;
  /** The person who answered. */
  readonly by: string;
}
/** An epic closed as done, with its tasks closed as done. */
export interface FinishedWin {
  readonly kind: 'finished';
  readonly at: string;
  readonly projectId: string;
  readonly id: string;
  readonly title: string;
  readonly done: number;
}
export type Win = ShippedWin | DecidedWin | FinishedWin;

export interface WinsDay {
  /** The UTC day, as YYYY-MM-DD. */
  readonly day: string;
  readonly shipped: number;
  readonly decided: number;
  readonly finished: number;
}
export interface WinsTotals {
  readonly shipped: number;
  readonly decided: number;
  readonly finished: number;
  /** Approvals closed as done: counted, not listed. */
  readonly approved: number;
}
export interface WinsPayload {
  readonly readAt: string;
  /** The first instant the feed covers, a UTC midnight. */
  readonly from: string;
  /** The instant after the last it covers, a UTC midnight. */
  readonly to: string;
  /** The `before` that reads the days before these, or null where they would start before the feed reaches. */
  readonly earlier: string | null;
  /** How many projects were read. */
  readonly projects: number;
  /** Whether any change in these projects shipped before `from`. When none
   * did, merges may simply not have been recorded yet. */
  readonly shippedBefore: boolean;
  readonly totals: WinsTotals;
  /** Each day of the span, oldest first. */
  readonly days: readonly WinsDay[];
  /** Every win, newest first. */
  readonly wins: readonly Win[];
}

const dayOf = (instant: string) => instant.slice(0, 10);
const midnight = (ms: number) => Math.floor(ms / DAY) * DAY;
const iso = (ms: number) => new Date(ms).toISOString();

/** The span a read covers: the WIN_DAYS days before `before`, a UTC day, or
 * up to and including today when none is named. */
export interface WinsWindow {
  readonly from: string;
  readonly to: string;
  readonly earlier: string | null;
}

/** The window ending before `before` (YYYY-MM-DD), or ending with today, as
 * of `nowMs`; null when `before` is no day the feed reaches. */
export function winsWindow(nowMs: number, before: string | undefined): WinsWindow | null {
  const tomorrow = midnight(nowMs) + DAY;
  let end = tomorrow;
  if (before !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(before)) return null;
    end = Date.parse(`${before}T00:00:00.000Z`);
    if (!Number.isFinite(end) || dayOf(iso(end)) !== before) return null;
  }
  const start = end - WIN_DAYS * DAY;
  const earliest = tomorrow - WIN_HISTORY_DAYS * DAY;
  if (end > tomorrow || start < earliest) return null;
  return {
    from: iso(start),
    to: iso(end),
    earlier: start - WIN_DAYS * DAY >= earliest ? dayOf(iso(start)) : null,
  };
}

/** When a task's change shipped: when it merged, or went live where no merge was recorded. */
function shippedAt(item: WinItem): string | null {
  if (item.stage !== 'merged' && item.stage !== 'live') return null;
  return item.mergedAt ?? item.liveAt;
}

/** A person's answer recorded on a task: the option, when and who. */
function answerOf(item: WinItem): { at: string; option: string; label: string; by: string } | null {
  const choice = item.choice;
  if (choice === null) return null;
  const { at, option, label, by } = choice;
  if (typeof at !== 'string' || typeof option !== 'string' || typeof by !== 'string') return null;
  return { at, option, label: typeof label === 'string' ? label : option, by };
}

/** The wins among `items` within `window`, as the feed shows them. */
export function readWins(
  items: readonly WinItem[],
  window: Pick<WinsWindow, 'from' | 'to'>,
): Pick<WinsPayload, 'totals' | 'days' | 'wins'> {
  const within = (at: string | null): at is string => at !== null && at >= window.from && at < window.to;
  const changes = new Map<string, { at: string; items: WinItem[] }>();
  const wins: Win[] = [];
  let approved = 0;
  const seen = new Set<string>();
  for (const item of items) {
    // A task can come from both of the store's reads; it counts once.
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const shipped = shippedAt(item);
    if (within(shipped)) {
      // A pull request is one change, however many tasks closed with it.
      const key = `${item.projectId} ${item.pullRequest ?? item.mergeCommit ?? item.commit ?? item.id}`;
      const change = changes.get(key);
      if (change === undefined) changes.set(key, { at: shipped, items: [item] });
      else {
        change.items.push(item);
        if (shipped < change.at) change.at = shipped;
      }
    }
    const answer = answerOf(item);
    if (answer !== null && within(answer.at)) {
      wins.push({
        kind: 'decided',
        at: answer.at,
        projectId: item.projectId,
        id: item.id,
        title: item.title,
        option: answer.option,
        label: answer.label,
        by: answer.by,
      });
    }
    if (item.status === 'closed' && item.resolution === 'done' && within(item.closedAt)) {
      if (item.type === 'epic') {
        wins.push({
          kind: 'finished',
          at: item.closedAt,
          projectId: item.projectId,
          id: item.id,
          title: item.title,
          done: item.done,
        });
      } else if (item.type === 'gate') approved++;
    }
  }
  for (const { at, items: closed } of changes.values()) {
    const ordered = [...closed].sort(
      (a, b) => (shippedAt(a) ?? '').localeCompare(shippedAt(b) ?? '') || a.id.localeCompare(b.id),
    );
    const first = ordered[0]!;
    wins.push({
      kind: 'shipped',
      at,
      projectId: first.projectId,
      stage: ordered.some((item) => item.stage === 'live') ? 'live' : 'merged',
      pullRequest: first.pullRequest,
      commit: first.pullRequest === null ? (first.mergeCommit ?? first.commit) : null,
      tasks: ordered.map((item) => ({ id: item.id, title: item.title })),
    });
  }
  wins.sort((a, b) => b.at.localeCompare(a.at) || a.kind.localeCompare(b.kind) || idOf(a).localeCompare(idOf(b)));
  const start = Date.parse(window.from);
  const count = Math.round((Date.parse(window.to) - start) / DAY);
  const days = Array.from({ length: count }, (_, i) => ({
    day: dayOf(iso(start + i * DAY)),
    shipped: 0,
    decided: 0,
    finished: 0,
  }));
  const byDay = new Map(days.map((day) => [day.day, day]));
  for (const win of wins) {
    const day = byDay.get(dayOf(win.at));
    if (day) day[win.kind]++;
  }
  const total = (kind: Win['kind']) => wins.filter((win) => win.kind === kind).length;
  return {
    totals: { shipped: total('shipped'), decided: total('decided'), finished: total('finished'), approved },
    days,
    wins,
  };
}

const idOf = (win: Win) => (win.kind === 'shipped' ? win.tasks[0]!.id : win.id);

/**
 * The wins of one project the sender reaches, or of every one it reaches,
 * over the WIN_DAYS days before `before` (YYYY-MM-DD), or up to now when it
 * names none. Null when `before` is no day the feed reaches.
 */
export async function wins(
  context: Reader & { readonly now: () => string },
  projectId: string | undefined,
  before: string | undefined,
): Promise<WinsPayload | null> {
  const readAt = context.now();
  const window = winsWindow(Date.parse(readAt), before);
  if (window === null) return null;
  const { engine, principal } = context;
  const projects: readonly Project[] =
    projectId === undefined ? reachable(principal, await engine.listProjects()) : [await projectOf(context, projectId)];
  const closedSince = iso(Date.parse(window.from) - WIN_MERGE_LAG_DAYS * DAY);
  const read = await engine.listWins(
    projects.map((project) => project.id),
    window.from,
    window.to,
    closedSince,
  );
  return {
    readAt,
    ...window,
    projects: projects.length,
    shippedBefore: read.shippedBefore,
    ...readWins(read.items, window),
  };
}
