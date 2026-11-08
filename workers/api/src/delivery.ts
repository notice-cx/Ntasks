/**
 * Where a closed task's change is: the arguments that record it on a close
 * and in a signal, and the signal itself, which the MCP tool report_delivery
 * and POST /api/delivery share. docs/concepts.md describes the stages.
 */
import {
  COMMIT_SHA,
  TaskRefused,
  type DeliveryMove,
  type DeliverySignal,
  type TaskResolution,
  type TaskWork,
} from '@ntasks/domain';
import { refuse, type Args } from './args.ts';
import { mayReach } from './auth.ts';
import { httpUrl, SIGNAL_ITEMS } from './engine/validate.ts';
import { Refused } from './refused.ts';
import type { WriteContext } from './task-writes.ts';

/** A GitHub repository: owner/name. */
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
/** A GitHub pull request's path, with anything after its number. */
const GITHUB_PULL = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d{1,9})(?:\/.*)?$/u;

function githubPull(repository: string, number: number): string {
  return `https://github.com/${repository.toLowerCase()}/pull/${number}`;
}

/**
 * A pull request as a delivery records it: an http or https URL as the URL
 * standard writes it, and a GitHub pull request's page, whatever tab or
 * anchor the URL shows and however its owner and name are capitalised, as
 * `https://github.com/<owner>/<name>/pull/<number>`, so one pull request is one URL.
 */
export function pullRequestUrl(value: unknown): string | null {
  const href = httpUrl(value);
  if (href === null) return null;
  const url = new URL(href);
  const pull =
    url.hostname === 'github.com' || url.hostname === 'www.github.com' ? GITHUB_PULL.exec(url.pathname) : null;
  return pull ? githubPull(`${pull[1]}/${pull[2]}`, Number(pull[3])) : href;
}

/** A commit, in any case: 7 to 64 hexadecimal characters, recorded in lowercase. */
function commitOf(value: unknown, name: string): string {
  const commit = typeof value === 'string' ? value.toLowerCase() : '';
  if (!COMMIT_SHA.test(commit)) refuse(`invalid arguments: ${name} (a commit: 7 to 64 hexadecimal characters)`);
  return commit;
}

/**
 * What a close as done records of what shipped: `commit`, and the pull
 * request under `prName`. Either starts the task's delivery at built; they
 * go with a close as done alone.
 */
export function shippedArgs(
  args: Args,
  prName: string,
  resolution: TaskResolution | undefined,
): { readonly commit?: string; readonly pullRequest?: string } {
  const commit = args.commit === undefined ? undefined : commitOf(args.commit, 'commit');
  const pullRequest =
    args[prName] === undefined
      ? undefined
      : (pullRequestUrl(args[prName]) ?? refuse(`invalid arguments: ${prName} (the pull request's http or https URL)`));
  if ((commit !== undefined || pullRequest !== undefined) && (resolution ?? 'done') !== 'done')
    refuse(`invalid arguments: commit and ${prName} record what shipped, so they go with resolution done`);
  return {
    ...(commit === undefined ? {} : { commit }),
    ...(pullRequest === undefined ? {} : { pullRequest }),
  };
}

/**
 * A signal's arguments: the repository, the stage, and the pull requests
 * (URLs, or numbers in the repository) and commits it names, under the
 * names its caller uses for the two lists.
 */
export function signalArgs(args: Args, names: { readonly pullRequests: string; readonly commits: string }) {
  const repository = args.repository;
  if (typeof repository !== 'string' || !REPOSITORY.test(repository))
    refuse('invalid arguments: repository (owner/name, such as example/app)');
  const stage = args.stage;
  if (stage !== 'merged' && stage !== 'live') refuse('invalid arguments: stage (merged or live)');
  const list = (name: string): unknown[] => {
    const value = args[name] ?? [];
    if (!Array.isArray(value) || value.length > SIGNAL_ITEMS)
      refuse(`invalid arguments: ${name} (at most ${SIGNAL_ITEMS})`);
    return value;
  };
  const pullRequests = list(names.pullRequests).map((entry, index) => {
    const at = `${names.pullRequests}[${index}]`;
    const number = typeof entry === 'string' ? /^#?(\d{1,9})$/u.exec(entry)?.[1] : undefined;
    if (number !== undefined) return githubPull(repository, Number(number));
    if (typeof entry === 'number' && Number.isSafeInteger(entry) && entry > 0) return githubPull(repository, entry);
    return (
      pullRequestUrl(entry) ?? refuse(`invalid arguments: ${at} (a pull request's URL, or its number in repository)`)
    );
  });
  const commits = list(names.commits).map((entry, index) => commitOf(entry, `${names.commits}[${index}]`));
  if (pullRequests.length === 0 && commits.length === 0)
    refuse(`invalid arguments: ${names.pullRequests} or ${names.commits} (name at least one)`);
  return { stage, pullRequests: [...new Set(pullRequests)], commits: [...new Set(commits)] } satisfies DeliverySignal;
}

/**
 * What a close as done records of what shipped: the commit and pull request
 * it names, and for one it leaves out, the one its holder recorded in the
 * task's work details, which the close clears. A recorded commit counts only
 * when it is a commit's hexadecimal name.
 */
export function shippedWith(
  given: { readonly commit?: string; readonly pullRequest?: string },
  work: TaskWork,
): { readonly commit?: string; readonly pullRequest?: string } {
  const recorded = work.commit?.toLowerCase();
  const commit = given.commit ?? (recorded !== undefined && COMMIT_SHA.test(recorded) ? recorded : undefined);
  const pullRequest = given.pullRequest ?? (work.pr === undefined ? undefined : (pullRequestUrl(work.pr) ?? undefined));
  return {
    ...(commit === undefined ? {} : { commit }),
    ...(pullRequest === undefined ? {} : { pullRequest }),
  };
}

/** Moves the closed tasks a signal names, in the projects the sender may change. */
export async function reportDelivery(
  context: WriteContext,
  signal: DeliverySignal,
  model?: string,
): Promise<readonly DeliveryMove[]> {
  const { engine, principal } = context;
  const writable = (await engine.listProjects()).filter((project) => mayReach(principal, project.id, 'write'));
  if (writable.length === 0) return [];
  try {
    return await engine.reportDelivery(
      writable.map((project) => project.id),
      signal,
      model === undefined ? { name: principal.name } : { name: principal.name, model },
    );
  } catch (error) {
    if (!(error instanceof TaskRefused)) throw error;
    if (error.refusal === 'invalid') throw new Refused('invalid', `invalid arguments: ${error.message}`);
    throw new Refused(
      'unavailable',
      'unavailable: the tasks this signal moves kept changing; send it again. A repeated signal moves nothing twice.',
      'The tasks this signal moves kept changing. Send it again.',
    );
  }
}

/** The moves as a signal's answer lists them. */
export function movedView(moves: readonly DeliveryMove[]) {
  return moves.map((move) => ({ id: move.taskId, stage: move.stage }));
}
