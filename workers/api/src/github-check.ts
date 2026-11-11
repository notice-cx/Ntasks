/**
 * Work that waits on GitHub after its signal moved nothing: a task closed
 * after its pull request merged, whose merge event came before the close;
 * tasks that waited since before the workspace connected GitHub; a task in
 * progress whose merge event never came, which closes as that event would
 * have closed it (closeMerged in task-writes.ts); a merged task whose deploy
 * GitHub reported before its merge; and a merged task whose own build a
 * later merge's deploy replaced. The workspace's task store asks GitHub
 * about them itself, as the workspace's GitHub App, a few seconds
 * after a close as done with a pull request or a delivery that moved a task,
 * and once an owner installs the app (store/index.ts). It records each pull
 * request merged into its repository's default branch as merged, then each
 * merged task GitHub shows deployed as live.
 */
import { COMMIT_SHA, type DeliverySignal, type Task, type TaskEngine } from '@ntasks/domain';
import { signInSecrets } from './access/config.ts';
import {
  appToken,
  checksOf,
  inHistoryOf,
  installationRepositories,
  installationSelection,
  installationToken,
  pullRequestState,
  REPOSITORY_PAGES,
  RETRY,
} from './access/github-api.ts';
import {
  deployBranchOf,
  deployOf,
  detectedOf,
  githubAppOf,
  heldBy,
  installationsByAccount,
  isDeployCheck,
  recordDetected,
  type DeployNames,
} from './access/github-app.ts';
import { githubWebhookOf } from './access/github-webhook.ts';
import { SCOPES, type Principal } from './auth.ts';
import { pullRequestUrl, reportDelivery } from './delivery.ts';
import { closeMerged, neverClosedByMerge, type WriteContext } from './task-writes.ts';

/**
 * The most requests one check makes to GitHub: installation tokens, the
 * pages of their repositories, then one for each waiting task's pull
 * request, then one or two for each merged task's deploy. It stays within
 * the 50 requests to other servers that one invocation may make on the free
 * plan.
 */
const REQUESTS = 45;

/** What a check did: how many tasks it moved, and whether GitHub missed a read that another try may answer. */
export interface GitHubCheck {
  readonly moved: number;
  readonly retry: boolean;
}

const NOTHING: GitHubCheck = { moved: 0, retry: false };

const DAY_MS = 86_400_000;
/**
 * How long after its merge a task at merged is looked for among deploys. A
 * deploy follows its merge within minutes; a task merged before this that is
 * still at merged, such as one of a repository that does not deploy, is left
 * as it is.
 */
const DEPLOY_WINDOW_MS = DAY_MS;
/** How far back the closes read for deploys reach: a task can close well before its pull request merges. */
const CLOSED_LOOKBACK_MS = 28 * DAY_MS;

/** A GitHub pull request's URL, as a task's delivery records it. */
const PULL = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d{1,9})$/u;

/** The sender GitHub's word acts as: a service that may change every project of the workspace. */
export function githubSender(workspaceId: string): Principal {
  return Object.freeze({
    id: `github:${workspaceId}`,
    name: 'service:GitHub',
    scopes: [SCOPES.read, SCOPES.write],
    projects: 'all',
  });
}

/** A repository on GitHub, and the installation of the workspace's app that reaches its owner. */
interface Reached {
  /** owner/name, in lowercase: GitHub's names ignore case. */
  readonly repository: string;
  readonly installation: number;
}

/** A task's pull request on GitHub, and the installation that reaches its repository. */
interface Pull extends Reached {
  readonly url: string;
  readonly number: number;
}

/**
 * The pull request a task waits on, when it is on GitHub and an installation
 * reaches its owner: the one a task closed with, or for a task in progress,
 * the one its work names.
 */
function pullOf(task: Task, installations: ReadonlyMap<string, number>): Pull | null {
  const named = task.status === 'in_progress' && task.work.pr !== undefined ? pullRequestUrl(task.work.pr) : null;
  const url = named ?? task.delivery?.pullRequest ?? '';
  const [, owner = '', name = '', number = ''] = PULL.exec(url) ?? [];
  const installation = installations.get(owner.toLowerCase());
  return installation === undefined
    ? null
    : { url, repository: `${owner}/${name}`.toLowerCase(), number: Number(number), installation };
}

/**
 * The repository a task's change reached, when an installation reaches its
 * owner: its pull request's, or for a task closed with only a commit, the one
 * its merge's signal named, such as a push's.
 */
function reachedOf(task: Task, installations: ReadonlyMap<string, number>): Reached | null {
  const pull = pullOf(task, installations);
  if (pull !== null) return pull;
  const repository = task.delivery?.repository?.toLowerCase();
  const installation = installations.get(repository?.split('/')[0] ?? '');
  return repository === undefined || installation === undefined ? null : { repository, installation };
}

/** A merged change of a project that deploys: its repository, its merge commit, and when it merged and went live. */
interface Change extends Reached {
  readonly mergeCommit: string;
  readonly mergedAt: string;
  readonly liveAt: string | null;
}

/**
 * The changes of the projects that deploy, newest merge first: the merged
 * ones that merged within DEPLOY_WINDOW_MS, which wait for a deploy, and the
 * live ones, whose deploys show which commits are live.
 */
async function changesOf(
  engine: TaskEngine,
  installations: ReadonlyMap<string, number>,
  now: number,
): Promise<{ readonly waiting: readonly Change[]; readonly live: readonly Change[] }> {
  const closedSince = new Date(now - CLOSED_LOOKBACK_MS).toISOString();
  const mergedSince = new Date(now - DEPLOY_WINDOW_MS).toISOString();
  const deploying = (await engine.listProjects()).filter((project) => project.deploys);
  const tasks: Task[] = [];
  for (const project of deploying) {
    tasks.push(
      ...(await engine.listBoard(project.id, {
        statuses: [],
        stages: ['merged', 'live'],
        closedSince,
        withoutExternalLinks: true,
      })),
    );
  }
  const changes = tasks.flatMap((task): Change[] => {
    const reached = reachedOf(task, installations);
    const { mergeCommit = null, mergedAt = null, liveAt = null } = task.delivery ?? {};
    if (reached === null || mergeCommit === null || !COMMIT_SHA.test(mergeCommit) || mergedAt === null) return [];
    const { repository, installation } = reached;
    return [
      { repository, installation, mergeCommit, mergedAt, liveAt: task.delivery?.stage === 'live' ? liveAt : null },
    ];
  });
  changes.sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : a.mergedAt > b.mergedAt ? -1 : 0));
  // Tasks closed with one pull request share its merge commit, and one signal moves them all.
  const seen = new Set<string>();
  const waiting = changes.filter((change) => {
    const key = `${change.repository} ${change.mergeCommit}`;
    if (change.liveAt !== null || change.mergedAt < mergedSince || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { waiting, live: changes.filter((change) => change.liveAt !== null) };
}

/** An installation's token, and the repositories it reaches. */
interface Reach {
  readonly token: string;
  readonly repositories: ReadonlySet<string> | 'all';
}

/**
 * Asks GitHub about the workspace's work that waits on it, in repositories an
 * installation of its app reaches: each task waiting for a merge of its pull
 * request moves to merged once GitHub merged it into the default branch, with
 * its merge commit, and a task in progress whose work names such a pull
 * request first closes as a merge event closes it; then each merged task of
 * a project that deploys moves to live once GitHub shows it deployed.
 * Answers how many tasks it moved, and
 * whether a read of a merged task's deploy may be answered on another try;
 * nothing without an app or an installation.
 */
export async function checkGitHubWork(env: Env, workspaceId: string, engine: TaskEngine): Promise<GitHubCheck> {
  const secrets = signInSecrets(env);
  if (!secrets) return NOTHING;
  const app = await githubAppOf(env.DB, secrets.secret, workspaceId);
  if (app === null) return NOTHING;
  const installations = await installationsByAccount(env.DB, workspaceId);
  if (installations.size === 0) return NOTHING;
  // Closed work waiting for its merge, and work in progress whose merge GitHub's event, missed in an outage or
  // sent before the app was installed, never closed.
  const waiting = [
    ...(await engine.listBoard(null, { statuses: [], stages: ['built'], withoutExternalLinks: true })),
    // Work no merge closes, such as a task labelled keep-open, is left out: asked about on every check, enough of
    // it would take the whole budget from the work after it.
    ...(await engine.listBoard(null, { statuses: ['in_progress'], withoutExternalLinks: true })).filter(
      (task) => neverClosedByMerge(task) === null,
    ),
  ];
  // Newest first: a pull request still open keeps waiting, and must not keep a task closed after it from being asked about.
  const newest = waiting.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  // Each pull request once, however many tasks name it: one signal answers them all.
  const pulls = [
    ...new Map(newest.flatMap((task) => pullOf(task, installations) ?? []).map((pull) => [pull.url, pull])).values(),
  ];
  let changes = await changesOf(engine, installations, Date.now());
  if (pulls.length === 0 && changes.waiting.length === 0) return NOTHING;
  const jwt = await appToken(app.appId, app.privateKey);
  if (jwt === null) return NOTHING;
  // Each installation's token, and the repositories it reaches, so a task in
  // a repository an installation of selected repositories leaves out takes
  // no place among the ones asked about. Installations come in the order of
  // their newest waiting task, merges before deploys, and stop where the
  // budget would run out. One on all of its account's repositories reaches
  // every waiting task of that account; one GitHub does not list is left for
  // the next check.
  let requests = 0;
  const reach = new Map<number, Reach>();
  for (const installation of new Set([...pulls, ...changes.waiting].map((pull) => pull.installation))) {
    if (requests + 2 + REPOSITORY_PAGES >= REQUESTS) break;
    const selection = await installationSelection(jwt, installation);
    const token = selection === null ? null : await installationToken(jwt, installation);
    requests += selection === null ? 1 : 2;
    if (token === null) continue;
    if (selection === 'all') {
      reach.set(installation, { token, repositories: 'all' });
      continue;
    }
    const listed = await installationRepositories(token);
    requests += listed.requests;
    if (listed.repositories !== null) reach.set(installation, { token, repositories: listed.repositories });
  }
  const tokenOf = (reached: Reached): string | null => {
    const found = reach.get(reached.installation);
    if (found === undefined) return null;
    return found.repositories === 'all' || found.repositories.has(reached.repository) ? found.token : null;
  };
  const context = { engine, principal: githubSender(workspaceId), now: () => new Date().toISOString() };
  // Merged tasks waiting for a deploy keep two requests each, up to half of
  // what is left, so pull requests still open cannot take all of it.
  const reserved = Math.min(2 * changes.waiting.length, Math.floor((REQUESTS - requests) / 2));
  let merged = 0;
  for (const pull of pulls) {
    const token = tokenOf(pull);
    if (token === null) continue;
    if (requests >= REQUESTS - reserved) break;
    requests += 1;
    const state = await pullRequestState(token, pull.repository, pull.number);
    if (!state?.merged || state.base === null || state.base !== state.defaultBranch) continue;
    const merge = state.mergeCommit?.toLowerCase();
    const commits = merge !== undefined && COMMIT_SHA.test(merge) ? [merge] : [];
    // GitHub's merge time, which tells a deploy that followed the merge from a preview before it.
    const signal = { stage: 'merged' as const, pullRequests: [pull.url], commits };
    // As a merge event would: first the work in progress the merge finishes closes, then the closed tasks move.
    merged += (await closeMerged(context, signal)).closed.length;
    merged += (await reportDelivery(context, state.mergedAt === null ? signal : { ...signal, at: state.mergedAt }))
      .length;
  }
  // A task that just merged may have deployed before Ntasks heard of its merge.
  if (merged > 0) changes = await changesOf(engine, installations, Date.now());
  const deployed = await moveDeployed(env, secrets.secret, workspaceId, context, changes, tokenOf, REQUESTS - requests);
  return { moved: merged + deployed.moved, retry: deployed.retry };
}

/**
 * Moves to live each merged change GitHub shows deployed, newest merge
 * first, making at most `budget` requests. A change is deployed when a later
 * merge in its repository is live and has it in its history, as when the
 * host built only the last of several merges in a row; or else when a deploy
 * check on its merge commit passed on the default branch or the merge
 * queue's and started at or after its merge, as when GitHub reported the
 * deploy before the merge, and no other deploy check on it is still running
 * or failed (heldBy). Answers how many tasks it moved, and whether a
 * read may be answered on another try.
 */
async function moveDeployed(
  env: Env,
  secret: string,
  workspaceId: string,
  context: WriteContext,
  changes: { readonly waiting: readonly Change[]; readonly live: readonly Change[] },
  tokenOf: (reached: Reached) => string | null,
  budget: number,
): Promise<GitHubCheck> {
  let requests = 0;
  let names: DeployNames | null = null;
  let moved = 0;
  let retry = false;
  const live = async (signal: Omit<DeliverySignal, 'stage' | 'pullRequests'>) => {
    moved += (await reportDelivery(context, { stage: 'live', pullRequests: [], ...signal })).length;
  };
  for (const change of changes.waiting) {
    const token = tokenOf(change);
    if (token === null) continue;
    // The live changes come newest merge first: the first one merged since this one has the longest history.
    const later = changes.live.find(
      (shipped) =>
        shipped.repository === change.repository &&
        shipped.mergeCommit !== change.mergeCommit &&
        shipped.mergedAt >= change.mergedAt,
    );
    if (later !== undefined) {
      if (requests >= budget) break;
      requests += 1;
      const shipped = await inHistoryOf(token, change.repository, later.mergeCommit, change.mergeCommit);
      if (shipped === RETRY) retry = true;
      if (shipped === true) {
        // Live when the later merge went live, the deploy that shipped both.
        await live({ commits: [change.mergeCommit], ...(later.liveAt === null ? {} : { at: later.liveAt }) });
        continue;
      }
    }
    if (requests >= budget) break;
    requests += 1;
    const checks = await checksOf(token, change.repository, change.mergeCommit);
    if (checks === RETRY) retry = true;
    if (checks === RETRY || checks === null || checks.runs.length === 0) continue;
    if (names === null) names = await deployNamesOf(env, secret, workspaceId);
    const known = names;
    const deploys = checks.runs.flatMap((run) => {
      // On the default branch or the merge queue's, as a delivery of it counts it; a preview elsewhere moves nothing.
      if (run.conclusion !== 'success' || run.startedAt === null) return [];
      if (deployBranchOf(run.branch, checks.defaultBranch) === null) return [];
      const verdict = deployOf(run.name, known, isDeployCheck(run.name));
      return verdict === 'yes' || verdict === 'new' ? [{ ...run, startedAt: run.startedAt, verdict }] : [];
    });
    if (deploys.length === 0) continue;
    // Listed in Settings as a delivery of it would list it, with its switch.
    const fresh = [...new Set(deploys.filter((run) => run.verdict === 'new').map((run) => run.name))];
    if (fresh.length > 0) await recordDetected(env.DB, workspaceId, { checks: fresh });
    // Another deploy of the commit is still running or failed, as the receiver would find for a delivery.
    if (heldBy(checks.runs, known, checks.defaultBranch).length > 0) continue;
    // The deploy that started last: one that started before the merge was a
    // preview of it, which the move leaves at merged, as a delivery would.
    const last = deploys.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
    await live({
      commits: [change.mergeCommit],
      mergedBy: last.startedAt,
      ...(last.completedAt === null ? {} : { at: last.completedAt }),
    });
  }
  return { moved, retry };
}

/** The names that count as deploys, as the receiver reads them for a delivery (github.ts). */
async function deployNamesOf(env: Env, secret: string, workspaceId: string): Promise<DeployNames> {
  const [webhook, detected] = await Promise.all([
    githubWebhookOf(env.DB, secret, workspaceId),
    detectedOf(env.DB, workspaceId),
  ]);
  return { typed: webhook?.deployChecks ?? [], detected: detected.checks };
}
