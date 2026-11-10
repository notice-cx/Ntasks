/**
 * The burn-down for the Productivity page: for each day of the last eight
 * weeks, the tasks created, closed as done and closed any other way, and the
 * tasks still open at its end, in one project or every one the sender
 * reaches. It shows the open workload beside the wins and scores nobody.
 * `@ntasks/domain`'s burndown.ts holds how a day is counted.
 */
import { burndownDays, burndownWindow, type BurndownDay, type Project } from '@ntasks/domain';
import { reachable } from './auth.ts';
import { projectOf, type Reader } from './lookup.ts';

export interface BurndownPayload {
  readonly readAt: string;
  /** The time zone the days are cut in, such as America/Los_Angeles. */
  readonly timeZone: string;
  /** The first day's midnight in `timeZone`. */
  readonly from: string;
  /** Tomorrow's midnight in `timeZone`: the instant after the last day. */
  readonly to: string;
  /** How many projects were read. */
  readonly projects: number;
  /** The first day these projects hold a record for, or null when they hold none by today's end. */
  readonly recordedFrom: string | null;
  /** Each day, oldest first. */
  readonly days: readonly BurndownDay[];
}

/** The burn-down of one project the sender reaches, or of every one it reaches, its days cut at midnight in `timeZone`. */
export async function burndown(
  context: Reader & { readonly now: () => string },
  projectId: string | undefined,
  timeZone = 'UTC',
): Promise<BurndownPayload> {
  const readAt = context.now();
  const window = burndownWindow(Date.parse(readAt), timeZone);
  const { engine, principal } = context;
  const projects: readonly Project[] =
    projectId === undefined ? reachable(principal, await engine.listProjects()) : [await projectOf(context, projectId)];
  const read = await engine.listBurndown(
    projects.map((project) => project.id),
    window.from,
  );
  const counted = burndownDays(
    read,
    projects.map((project) => project.createdAt),
    window,
  );
  return { readAt, timeZone, from: window.from, to: window.to, projects: projects.length, ...counted };
}
