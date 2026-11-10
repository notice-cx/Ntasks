/**
 * Agent statistics: who is working on what and how fast work closes, grouped
 * by the model each agent named, in the shape NoticeOS's Agents page and its
 * get_agent_stats tool give (packages/contract/src/agent-stats.mts there).
 * Only counts leave the server: no task's text, id or metadata.
 */
import { modelIdentity, type Project, type WorkItem } from '@ntasks/domain';
import { reachable } from './auth.ts';
import { projectOf, type Reader } from './lookup.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** 1970-01-05, a Monday: weeks start on Mondays, in UTC. */
const MONDAY = 4 * DAY;
/** The days of closed work the statistics read: the Agents page's eight weeks. */
export const AGENT_HISTORY_DAYS = 56;
export const OTHER_MODEL = 'Other';

export interface ModelStats {
  id: string;
  name: string;
  inHand: number;
  blocked: number;
  days: number[];
  week: number;
  lastWeek: number;
  medianHours: number | null;
}
export interface VelocityWeek {
  start: string;
  current: boolean;
  counts: Record<string, number>;
  total: number;
}
export interface AgentRacePlayer {
  key: string;
  name: string;
  closes: number[];
  points: number;
}
export interface AgentAward {
  key: 'most' | 'fastest' | 'streak' | 'urgent';
  award: string;
  holder: string;
  value: string;
  detail: string | null;
}
export interface AgentStats {
  workers: ModelStats[];
  velocity: { weeks: VelocityWeek[]; keys: string[]; names: Record<string, string> };
  race: { from: number; to: number; players: AgentRacePlayer[] };
  trophies: AgentAward[];
  week: number;
  lastWeek: number;
  inHand: number;
  blocked: number;
  medianHours: number | null;
}
export interface AgentStatsPayload {
  readAt: string;
  /** How many projects were read. */
  projects: number;
  /** The projects that could not be read. One store answers every project, so none fails alone. */
  broken: string[];
  stats: AgentStats;
}

/** The name a model's work is counted under: its display name, or Other when it named none or no rule knows it. */
export function canonicalAgentModel(value: string | null): string {
  const model = modelIdentity(value);
  return model?.id ? model.name : OTHER_MODEL;
}

export function medianOf(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
export function taskPoints(priority: number): number {
  return priority <= 0 ? 5 : priority === 1 ? 3 : priority === 2 ? 2 : 1;
}
export function streakOf(days: readonly number[]): number {
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i]! > 0) streak++;
    else if (i !== days.length - 1) break;
  }
  return streak;
}
export function formatHours(hours: number): string {
  if (hours < 1) return 'under 1 h';
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${(hours / 24).toFixed(hours < 240 ? 1 : 0)} d`;
}

/** The model a task's work counts for: its closer's when a closer was recorded, else its holder's. */
function modelOf(task: WorkItem): string {
  const closedModel = task.status === 'closed' && task.closedBy?.trim() ? task.closedModel : null;
  return canonicalAgentModel(closedModel?.trim() ? closedModel : task.assigneeModel);
}
function cycleOf(task: WorkItem): number | null {
  const hours = (Date.parse(task.closedAt ?? '') - Date.parse(task.startedAt ?? '')) / HOUR;
  return Number.isFinite(hours) && hours >= 0 ? hours : null;
}

/** The statistics of this work as of `nowMs`. A close counts even when its model no longer works here. */
export function readAgentStats(work: readonly WorkItem[], nowMs: number): AgentStats {
  const tasks = work.filter((task) => task.type !== 'epic' && task.type !== 'gate' && task.awaitType === null);
  const current = MONDAY + Math.floor((nowMs - MONDAY) / (7 * DAY)) * 7 * DAY;
  const starts = Array.from({ length: 8 }, (_, i) => current - (7 - i) * 7 * DAY);
  const closed = tasks.filter(
    (task) =>
      task.status === 'closed' &&
      Date.parse(task.closedAt ?? '') <= nowMs &&
      Date.parse(task.closedAt ?? '') >= nowMs - AGENT_HISTORY_DAYS * DAY,
  );
  const from = nowMs - 7 * DAY;
  const groups = new Map<string, ModelStats & { cycles: number[] }>();
  const get = (name: string) => {
    let group = groups.get(name);
    if (!group) {
      group = {
        id: name,
        name,
        inHand: 0,
        blocked: 0,
        days: Array<number>(7).fill(0),
        week: 0,
        lastWeek: 0,
        medianHours: null,
        cycles: [],
      };
      groups.set(name, group);
    }
    return group;
  };
  const players = new Map<string, AgentRacePlayer>();
  const totals = new Map<string, number>();
  const cycles: number[] = [];
  const urgent = new Map<string, number>();
  let fastest: { name: string; hours: number } | null = null;
  for (const task of closed) {
    const name = modelOf(task);
    const group = get(name);
    const at = Date.parse(task.closedAt!);
    const hours = cycleOf(task);
    if (at >= starts[0]!) totals.set(name, (totals.get(name) ?? 0) + 1);
    if (hours !== null) {
      group.cycles.push(hours);
      cycles.push(hours);
    }
    if (at > from) {
      group.week++;
      const day = Math.floor(at / DAY) - Math.floor(nowMs / DAY) + 6;
      if (day >= 0 && day < 7) group.days[day]!++;
      const player = players.get(name) ?? { key: name, name, closes: [], points: 0 };
      player.closes.push(at);
      player.points += taskPoints(task.priority);
      players.set(name, player);
      if (name !== OTHER_MODEL) {
        if (hours !== null && (!fastest || hours < fastest.hours)) fastest = { name, hours };
        if (task.priority <= 1) urgent.set(name, (urgent.get(name) ?? 0) + 1);
      }
    } else if (at > nowMs - 14 * DAY) group.lastWeek++;
  }
  for (const task of tasks) {
    if (!task.assignee || (task.status !== 'in_progress' && task.status !== 'blocked')) continue;
    const group = get(modelOf(task));
    if (task.status === 'in_progress') group.inHand++;
    else group.blocked++;
  }
  const workers = [...groups.values()]
    .filter((group) => group.week > 0 || group.inHand > 0 || group.blocked > 0)
    .map(({ cycles: durations, ...group }) => ({ ...group, medianHours: medianOf(durations) }))
    .sort(
      (a, b) =>
        Number(a.name === OTHER_MODEL) - Number(b.name === OTHER_MODEL) ||
        b.week - a.week ||
        b.inHand - a.inHand ||
        b.blocked - a.blocked ||
        a.name.localeCompare(b.name),
    );
  const named = [...totals]
    .filter(([name]) => name !== OTHER_MODEL)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([name]) => name);
  const weeks = starts.map((start) => {
    const counts: Record<string, number> = {};
    for (const task of closed) {
      const at = Date.parse(task.closedAt!);
      if (at < start || at >= start + 7 * DAY) continue;
      const name = modelOf(task);
      const key = named.includes(name) ? name : '';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return {
      start: new Date(start).toISOString().slice(0, 10),
      current: start === current,
      counts,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    };
  });
  const racers = [...players.values()]
    .map((player) => ({ ...player, closes: player.closes.sort((a, b) => a - b) }))
    .sort((a, b) => b.points - a.points || b.closes.length - a.closes.length || a.name.localeCompare(b.name));
  const trophies: AgentAward[] = [];
  const most = racers
    .filter((player) => player.name !== OTHER_MODEL)
    .sort((a, b) => b.closes.length - a.closes.length || b.points - a.points)[0];
  if (most)
    trophies.push({
      key: 'most',
      award: 'Most tasks closed',
      holder: most.name,
      value: `${most.closes.length}`,
      detail: most.closes.length === 1 ? 'task' : 'tasks',
    });
  const quickest = fastest as { name: string; hours: number } | null;
  if (quickest)
    trophies.push({
      key: 'fastest',
      award: 'Fastest close',
      holder: quickest.name,
      value: formatHours(quickest.hours),
      detail: null,
    });
  const streak = workers
    .filter((worker) => worker.name !== OTHER_MODEL)
    .map((worker) => ({ name: worker.name, days: streakOf(worker.days) }))
    .sort((a, b) => b.days - a.days)[0];
  if (streak && streak.days > 1)
    trophies.push({
      key: 'streak',
      award: 'Most days in a row',
      holder: streak.name,
      value: `${streak.days}`,
      detail: 'days',
    });
  const mostUrgent = [...urgent].sort((a, b) => b[1] - a[1])[0];
  if (mostUrgent)
    trophies.push({
      key: 'urgent',
      award: 'Most urgent tasks closed',
      holder: mostUrgent[0],
      value: `${mostUrgent[1]}`,
      detail: mostUrgent[1] === 1 ? 'high-priority close' : 'high-priority closes',
    });
  return {
    workers,
    velocity: {
      weeks,
      keys: [...named, ...(weeks.some((week) => (week.counts[''] ?? 0) > 0) ? [''] : [])],
      names: Object.fromEntries([...named.map((name) => [name, name]), ['', OTHER_MODEL]]),
    },
    race: { from, to: nowMs, players: racers },
    trophies,
    week: [...groups.values()].reduce((sum, group) => sum + group.week, 0),
    lastWeek: [...groups.values()].reduce((sum, group) => sum + group.lastWeek, 0),
    inHand: workers.reduce((sum, group) => sum + group.inHand, 0),
    blocked: workers.reduce((sum, group) => sum + group.blocked, 0),
    medianHours: medianOf(cycles),
  };
}

/**
 * The statistics of one project the sender reaches, or of every one it
 * reaches: the work in progress or blocked, and closed from the start of the
 * day 56 days ago, read in one statement.
 */
export async function agentStats(
  context: Reader & { readonly now: () => string },
  projectId: string | undefined,
): Promise<AgentStatsPayload> {
  const { engine, principal } = context;
  const projects: readonly Project[] =
    projectId === undefined ? reachable(principal, await engine.listProjects()) : [await projectOf(context, projectId)];
  const readAt = context.now();
  const since = new Date(Date.parse(readAt) - AGENT_HISTORY_DAYS * DAY).toISOString().slice(0, 10);
  const work = await engine.listWork(
    projects.map((project) => project.id),
    `${since}T00:00:00.000Z`,
  );
  return { readAt, projects: projects.length, broken: [], stats: readAgentStats(work, Date.parse(readAt)) };
}
