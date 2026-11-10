/**
 * Work that waits for a merge GitHub already made: a task closed after its
 * pull request merged, whose merge event came before the close, and tasks
 * that waited since before the workspace connected GitHub. The workspace's
 * task store asks GitHub about them itself, as the workspace's GitHub App,
 * a few seconds after a close as done with a pull request and once an owner
 * installs the app (store/index.ts), and records each one merged into its
 * repository's default branch as merged.
 */
import { COMMIT_SHA, type TaskEngine } from '@ntasks/domain';
import { signInSecrets } from './access/config.ts';
import {
  appToken,
  installationRepositories,
  installationSelection,
  installationToken,
  pullRequestState,
  REPOSITORY_PAGES,
} from './access/github-api.ts';
import { githubAppOf, installationsByAccount } from './access/github-app.ts';
import { SCOPES, type Principal } from './auth.ts';
import { reportDelivery } from './delivery.ts';

/**
 * The most requests one check makes to GitHub: installation tokens, the
 * pages of their repositories, then one for each waiting task's pull
 * request. It stays within the 50 requests to other servers that one
 * invocation may make on the free plan.
 */
const REQUESTS = 45;

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

/**
 * Asks GitHub about the workspace's tasks that wait for a merge with a pull
 * request in a repository an installation of its app reaches, and moves each
 * one GitHub merged into the default branch to merged, with its merge commit.
 * Answers how many tasks it moved; nothing without an app or an installation.
 */
export async function checkMergedWork(env: Env, workspaceId: string, engine: TaskEngine): Promise<number> {
  const secrets = signInSecrets(env);
  if (!secrets) return 0;
  const app = await githubAppOf(env.DB, secrets.secret, workspaceId);
  if (app === null) return 0;
  const installations = await installationsByAccount(env.DB, workspaceId);
  if (installations.size === 0) return 0;
  const waiting = await engine.listBoard(null, { statuses: [], stages: ['built'], withoutExternalLinks: true });
  // Newest first: a pull request still open keeps waiting, and must not keep a task closed after it from being asked about.
  const newest = [...waiting].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const pulls = newest.flatMap((task) => {
    const url = task.delivery?.pullRequest ?? '';
    const [, owner = '', name = '', number = ''] = PULL.exec(url) ?? [];
    // GitHub logins ignore case; the task keeps its URL as written.
    const installation = installations.get(owner.toLowerCase());
    return installation === undefined
      ? []
      : [{ url, repository: `${owner}/${name}`, number: Number(number), installation }];
  });
  if (pulls.length === 0) return 0;
  const jwt = await appToken(app.appId, app.privateKey);
  if (jwt === null) return 0;
  // Each installation's token, and the repositories it reaches, so a task in
  // a repository an installation of selected repositories leaves out takes
  // no place among the ones asked about. Installations come in the order of
  // their newest waiting task, and stop where the budget would run out. One
  // on all of its account's repositories reaches every waiting task of that
  // account; one GitHub does not list is left for the next check.
  let requests = 0;
  const reach = new Map<number, { readonly token: string; readonly repositories: ReadonlySet<string> | 'all' }>();
  for (const installation of new Set(pulls.map((pull) => pull.installation))) {
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
  const readable = pulls.flatMap((pull) => {
    const installation = reach.get(pull.installation);
    if (installation === undefined) return [];
    const { repositories } = installation;
    return repositories === 'all' || repositories.has(pull.repository.toLowerCase())
      ? [{ ...pull, token: installation.token }]
      : [];
  });
  const context = { engine, principal: githubSender(workspaceId), now: () => new Date().toISOString() };
  let moved = 0;
  for (const pull of readable.slice(0, Math.max(0, REQUESTS - requests))) {
    const state = await pullRequestState(pull.token, pull.repository, pull.number);
    if (!state?.merged || state.base === null || state.base !== state.defaultBranch) continue;
    const merge = state.mergeCommit?.toLowerCase();
    const commits = merge !== undefined && COMMIT_SHA.test(merge) ? [merge] : [];
    // GitHub's merge time, which tells a deploy that followed the merge from a preview before it.
    const signal = { stage: 'merged' as const, pullRequests: [pull.url], commits };
    moved += (await reportDelivery(context, state.mergedAt === null ? signal : { ...signal, at: state.mergedAt }))
      .length;
  }
  return moved;
}
