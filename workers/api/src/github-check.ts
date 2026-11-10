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
import { appToken, installationToken, pullRequestState } from './access/github-api.ts';
import { githubAppOf, installationsByAccount } from './access/github-app.ts';
import { SCOPES, type Principal } from './auth.ts';
import { reportDelivery } from './delivery.ts';

/**
 * The most waiting tasks one check asks GitHub about, each one request:
 * with the installation tokens, it stays within the 50 requests to other
 * servers that one invocation may make on the free plan.
 */
const CHECKED = 40;

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
  const tokens = new Map<number, Promise<string | null>>();
  const context = { engine, principal: githubSender(workspaceId), now: () => new Date().toISOString() };
  let moved = 0;
  for (const pull of pulls.slice(0, CHECKED)) {
    let token = tokens.get(pull.installation);
    if (token === undefined) {
      token = installationToken(jwt, pull.installation);
      tokens.set(pull.installation, token);
    }
    const access = await token;
    if (access === null) continue;
    const state = await pullRequestState(access, pull.repository, pull.number);
    if (!state?.merged || state.base === null || state.base !== state.defaultBranch) continue;
    const merge = state.mergeCommit?.toLowerCase();
    const commits = merge !== undefined && COMMIT_SHA.test(merge) ? [merge] : [];
    moved += (await reportDelivery(context, { stage: 'merged', pullRequests: [pull.url], commits })).length;
  }
  return moved;
}
