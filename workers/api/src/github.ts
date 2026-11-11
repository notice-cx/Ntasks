/**
 * The GitHub receiver: POST /api/github/<workspace id>, where the
 * workspace's GitHub App, or a webhook its owner set up by hand, sends its
 * deliveries, so a closed task moves to merged and live without an agent
 * reporting it. A delivery is read only when its X-Hub-Signature-256 is the
 * HMAC-SHA-256 of its body under the app's webhook secret
 * (access/github-app.ts) or the secret saved by hand
 * (access/github-webhook.ts). An app's delivery is read only from an
 * installation an owner of the workspace made: GitHub's installation event
 * names who made it, and the receiver records the installation when that
 * person is an owner. Its event then becomes the signal POST /api/delivery
 * and report_delivery send (delivery.ts), for every project of the workspace:
 *
 * - `pull_request` closed and merged into the default branch: `merged`,
 *   naming the pull request and its merge commit. It first closes, as done,
 *   each task in progress whose work names that pull request, unless it is
 *   an epic or a person's request, is labelled keep-open, waits on an open
 *   request or has open tasks under it (closeMerged in task-writes.ts);
 *   the answer lists the tasks it closed and the ones it kept, with why;
 * - `check_run` completed with success on the default branch, when it is a
 *   deploy: `live`, naming its commit, once every other deploy check on that
 *   commit passed too, which the receiver reads through the app (heldBy);
 * - `deployment_status` success, when it is a deploy: `live`, naming the
 *   deployed commit.
 *
 * A check run is a deploy when its name starts with a hosting provider's
 * deploy prefix, such as `Workers Builds:`; a deployment, when its
 * environment is the production one; and either, when the owner typed its
 * name by hand. The first time a deploy is seen, its name is recorded, and
 * Settings lists it with a switch that turns it off. A deploy also turns on
 * "changes go live by a deploy" for the projects of the tasks it names, once
 * for each project, so an owner who turns it off again keeps it off.
 *
 * A delivery that moves a task also has the workspace's task store ask GitHub
 * a few seconds later about the merged tasks no delivery moved to live
 * (github-check.ts): one whose deploy was reported before its merge, and one
 * whose own build a later merge's deploy replaced.
 *
 * Any other event is answered with why it moves nothing. A task never moves
 * back, and a task a merge closed is no longer in progress, so a delivery
 * that GitHub sends again moves and closes nothing twice.
 * docs/api.md#from-github describes the setup.
 */
import { appToken, checksOf, installationToken, RETRY } from './access/github-api.ts';
import {
  addInstallation,
  deployBranchOf,
  deployedNothing,
  deployOf,
  detectedOf,
  githubAppOf,
  hasInstallation,
  heldBy,
  installationsByAccount,
  isDeployCheck,
  isOwnerOnGitHub,
  recordDetected,
  removeInstallation,
  type DeployNames,
  type GitHubApp,
} from './access/github-app.ts';
import { signInSecrets } from './access/config.ts';
import { fromHex, sameBytes } from './access/crypto.ts';
import { githubWebhookOf } from './access/github-webhook.ts';
import { notConfigured } from './access/verify.ts';
import { listed, type Args } from './args.ts';
import { isTaskId } from '@ntasks/domain';
import { movedView, signalArgs } from './delivery.ts';
import { SIGNAL_ITEMS } from './engine/validate.ts';
import { githubSender } from './github-check.ts';
import { readBoundedBytes } from './http/json-body.ts';
import { json } from './http/respond.ts';
import { Refused } from './refused.ts';
import { workspaceStore } from './store/index.ts';

/** The largest delivery read. GitHub's events that move tasks are a few tens of KB. */
const DELIVERY_BYTES = 1024 * 1024;

const SIGNATURE = /^sha256=([0-9a-fA-F]{64})$/u;

const encoder = new TextEncoder();

/** Whether `expected` is the HMAC-SHA-256 of `body` under `secret`, compared in constant time. */
async function signedWith(secret: string, body: Uint8Array, expected: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return sameBytes(new Uint8Array(await crypto.subtle.sign('HMAC', key, body)), expected);
}

/** The event's JSON, sent as application/json or as the `payload` of a form, GitHub's two content types. */
function payloadOf(request: Request, body: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body);
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  return JSON.parse(
    type === 'application/x-www-form-urlencoded' ? (new URLSearchParams(text).get('payload') ?? '') : text,
  );
}

/** The value at `path` in a payload, or undefined when any step of it is missing. */
function at(payload: unknown, ...path: readonly string[]): unknown {
  let value = payload;
  for (const key of path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** The text at `path` in a payload, or undefined when it is missing or is not text. */
function textAt(payload: unknown, ...path: readonly string[]): string | undefined {
  const value = at(payload, ...path);
  return typeof value === 'string' ? value : undefined;
}

/** The whole number at `path` in a payload, or undefined when it is missing or is not one. */
function numberAt(payload: unknown, ...path: readonly string[]): number | undefined {
  const value = at(payload, ...path);
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** What an event says: the signal it sends, and a deploy name seen for the first time; or why it sends none, as GitHub's list of deliveries shows it. */
export type GitHubEvent =
  | {
      readonly signal: Args;
      /** With a push: its newest commit, which each task it moves records as its merge commit. */
      readonly mergeCommit?: string;
      /** With a push: the tasks its commit messages name on a `Refs:` line. */
      readonly taskIds?: readonly string[];
      readonly newDeploy?: string;
      readonly mergedBy?: string;
      readonly at?: string;
      /** The deploy check run that passed, when the event is a check run: the commit's other deploy checks may hold it. */
      readonly check?: {
        readonly id: number | null;
        readonly name: string;
        readonly commit: string;
        readonly startedAt: string | null;
      };
    }
  | {
      readonly ignored: string;
      /** A deploy that deployed nothing: the store's check reads the merged work waiting on its commit again. */
      readonly recheck?: true;
    };

/** A `Refs:` line of a commit message, which names the tasks the commit is for: `Refs: web-a1b2, web-c3d4`. */
const REFS_LINE = /^refs:[ \t]*(.+)$/gimu;

/** The task ids a commit message names on its `Refs:` lines. */
export function refsOf(message: string): string[] {
  return [...message.matchAll(REFS_LINE)].flatMap(([, list]) =>
    (list ?? '').split(/[\s,]+/u).filter((word) => isTaskId(word)),
  );
}

/** The signal an event sends, given the names that count as deploys. */
export function readEvent(event: string | null, payload: unknown, names: DeployNames): GitHubEvent {
  if (event === 'ping')
    return {
      ignored: 'GitHub reaches Ntasks. A merged pull request, a push to the default branch or a deploy moves tasks.',
    };
  const repository = textAt(payload, 'repository', 'full_name');
  const defaultBranch = textAt(payload, 'repository', 'default_branch');
  if (repository === undefined || defaultBranch === undefined)
    return { ignored: 'an event without its repository and default branch moves no task' };
  const commits = (sha: string | undefined) => (sha === undefined ? [] : [sha]);
  // A deploy with no name, such as a production deployment to an unnamed environment, counts and is not listed.
  const live = (name: string, verdict: 'yes' | 'new', sha: string | undefined): GitHubEvent => ({
    signal: { repository, stage: 'live', commits: commits(sha) },
    ...(verdict === 'new' && name !== '' ? { newDeploy: name } : {}),
  });
  switch (event) {
    case 'pull_request': {
      if (at(payload, 'action') !== 'closed' || at(payload, 'pull_request', 'merged') !== true)
        return { ignored: 'only a merged pull request moves a task' };
      const base = textAt(payload, 'pull_request', 'base', 'ref');
      if (base !== defaultBranch)
        return { ignored: `merged into ${base ?? 'another branch'}, not the default branch, so no task moves` };
      const url = textAt(payload, 'pull_request', 'html_url');
      // GitHub's merge time, not this delivery's arrival: a deploy is told from a preview by it.
      const mergedAt = textAt(payload, 'pull_request', 'merged_at');
      return {
        ...(mergedAt === undefined ? {} : { at: mergedAt }),
        signal: {
          repository,
          stage: 'merged',
          pullRequests: url === undefined ? [] : [url],
          commits: commits(textAt(payload, 'pull_request', 'merge_commit_sha')),
        },
      };
    }
    case 'push': {
      // A push straight to the default branch is that project's merge: its
      // commits are now on GitHub, waiting for a deploy. Its newest commit is
      // what a deploy check then runs on, so each task it moves records that
      // one as its merge commit, and the check moves them all to live.
      if (at(payload, 'deleted') === true) return { ignored: 'a deleted branch moves no task' };
      const ref = textAt(payload, 'ref');
      if (ref !== `refs/heads/${defaultBranch}`)
        return {
          ignored: `pushed to ${ref?.replace(/^refs\/heads\//u, '') ?? 'another branch'}, not the default branch, so no task moves`,
        };
      const listed = at(payload, 'commits');
      const pushed = (Array.isArray(listed) ? listed : []).flatMap((commit) => {
        const id = textAt(commit, 'id');
        return id === undefined ? [] : [{ id: id.toLowerCase(), message: textAt(commit, 'message') ?? '' }];
      });
      const head = textAt(payload, 'after')?.toLowerCase();
      if (pushed.length === 0 || head === undefined) return { ignored: 'a push with no commits moves no task' };
      const taskIds = [...new Set(pushed.flatMap((commit) => refsOf(commit.message)))].slice(0, SIGNAL_ITEMS);
      return {
        signal: { repository, stage: 'merged', commits: pushed.map((commit) => commit.id).slice(-SIGNAL_ITEMS) },
        mergeCommit: head,
        ...(taskIds.length === 0 ? {} : { taskIds }),
      };
    }
    case 'check_run': {
      const completed = at(payload, 'action') === 'completed';
      const conclusion = textAt(payload, 'check_run', 'conclusion')?.toLowerCase() ?? null;
      const name = textAt(payload, 'check_run', 'name') ?? '';
      const verdict = deployOf(name, names, isDeployCheck(name));
      // It may have been the last deploy its commit's tasks waited on (heldBy).
      if (completed && (verdict === 'yes' || verdict === 'new') && deployedNothing(conclusion))
        return { ignored: `${name} deployed nothing, so it moves no task itself`, recheck: true };
      if (!completed || conclusion !== 'success')
        return { ignored: 'only a check run that completed with success moves a task' };
      if (verdict === 'off') return { ignored: `${name} is switched off in Settings, so it moves no task` };
      if (verdict === 'no') return { ignored: `${name || 'this check'} is not a deploy` };
      const branch = textAt(payload, 'check_run', 'check_suite', 'head_branch');
      const kind = deployBranchOf(branch, defaultBranch);
      const sha = textAt(payload, 'check_run', 'head_sha');
      const startedAt = textAt(payload, 'check_run', 'started_at');
      const id = numberAt(payload, 'check_run', 'id') ?? null;
      const check = sha === undefined ? {} : { check: { id, name, commit: sha, startedAt: startedAt ?? null } };
      if (kind === 'default') return { ...live(name, verdict, sha), ...check };
      if (kind === null || startedAt === undefined)
        return { ignored: `a deploy check on ${branch ?? 'another branch'}, not the default branch, moves no task` };
      return { ...live(name, verdict, sha), ...check, mergedBy: startedAt };
    }
    case 'deployment_status': {
      if (at(payload, 'deployment_status', 'state') !== 'success')
        return { ignored: 'only a successful deployment moves a task' };
      const environment = textAt(payload, 'deployment', 'environment') ?? '';
      const production =
        at(payload, 'deployment', 'production_environment') === true || /^production$/iu.test(environment);
      const verdict = deployOf(environment, names, production);
      if (verdict === 'off') return { ignored: `${environment} is switched off in Settings, so it moves no task` };
      if (verdict === 'no')
        return { ignored: `the ${environment || 'unnamed'} environment is not production, so it moves no task` };
      return live(environment, verdict, textAt(payload, 'deployment', 'sha'));
    }
    default:
      return {
        ignored: `Ntasks reads pull_request, push, check_run and deployment_status events, not ${event ?? 'this one'}`,
      };
  }
}

/**
 * The deploy checks of a passing deploy's commit that hold its tasks back
 * (heldBy), read through the workspace's GitHub App with the installation
 * that reaches the repository; RETRY when they could not be read. Without the
 * app or such an installation, Ntasks cannot read the commit's other checks,
 * and each deploy check counts on its own.
 */
async function heldDeploys(
  app: GitHubApp | null,
  installation: { readonly id: number; readonly sentEvent: boolean } | undefined,
  repository: string,
  check: {
    readonly id: number | null;
    readonly name: string;
    readonly commit: string;
    readonly startedAt: string | null;
  },
  names: DeployNames,
): Promise<readonly string[] | typeof RETRY> {
  if (app === null || installation === undefined) return [];
  // The installation that sent the event reaches its repository, so a read
  // through it that fails leaves the commit's deploys unknown. One found by
  // the repository's account, for a webhook set up by hand, may be on other
  // repositories only, and the deploy then counts on its own.
  const unread = installation.sentEvent ? RETRY : [];
  const jwt = await appToken(app.appId, app.privateKey);
  if (jwt === null) return unread;
  const token = await installationToken(jwt, installation.id);
  if (token === null) return RETRY;
  const checks = await checksOf(token, repository, check.commit);
  if (checks === RETRY) return RETRY;
  if (checks === null) return unread;
  return heldBy(checks.runs, names, checks.defaultBranch, check);
}

/**
 * Answers the app's installation event: an installation an owner of the
 * workspace made is recorded, its repositories' events are read from then
 * on, and the work already waiting for a merge is checked on GitHub; one
 * anyone else made is refused. A removed or suspended installation is
 * forgotten.
 */
async function installationEvent(env: Env, workspaceId: string, payload: unknown): Promise<Response> {
  const db = env.DB;
  const installationId = numberAt(payload, 'installation', 'id');
  const account = textAt(payload, 'installation', 'account', 'login');
  if (installationId === undefined || account === undefined)
    return json({ error: 'invalid_request', detail: 'an installation event names its installation' }, 400);
  const action = at(payload, 'action');
  if (action === 'deleted' || action === 'suspend') {
    await removeInstallation(db, workspaceId, installationId);
    return json({ moved: [], ignored: `Ntasks no longer reads events from ${account}` }, 200);
  }
  if (action !== 'created' && action !== 'new_permissions_accepted' && action !== 'unsuspend')
    return json({ moved: [], ignored: `an installation ${String(action)} moves no task` }, 200);
  const sender = numberAt(payload, 'sender', 'id');
  if (sender === undefined || !(await isOwnerOnGitHub(db, workspaceId, String(sender)))) {
    const who = textAt(payload, 'sender', 'login') ?? 'this GitHub account';
    return json(
      {
        error: 'not_an_owner',
        detail: `${who} is not an owner of this workspace in Ntasks, so this installation's events are refused`,
      },
      403,
    );
  }
  await addInstallation(db, workspaceId, {
    installationId,
    account,
    accountType: textAt(payload, 'installation', 'account', 'type') ?? 'User',
    installedBy: String(sender),
  });
  // Work closed before the app was installed may have merged long ago.
  await workspaceStore(env, workspaceId).checkGitHub();
  return json({ moved: [], ignored: `Ntasks reads events from ${account}'s repositories from now on` }, 200);
}

/** Answers one delivery to the receiver of `workspaceId`. */
export async function githubReceiver(request: Request, env: Env, workspaceId: string): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
  const signature = SIGNATURE.exec(request.headers.get('x-hub-signature-256') ?? '')?.[1];
  if (signature === undefined) {
    return json(
      { error: 'signature_required', detail: 'a delivery is signed with the webhook secret in X-Hub-Signature-256' },
      401,
    );
  }
  let body: Uint8Array;
  try {
    body = await readBoundedBytes(request, DELIVERY_BYTES);
  } catch {
    return json({ error: 'invalid_request', detail: `a delivery is at most ${DELIVERY_BYTES / 1024} KB` }, 400);
  }
  const secrets = signInSecrets(env);
  if (!secrets) return notConfigured(env);
  // One answer for an unknown workspace, one with no secret and a wrong
  // signature, so a caller without the secret learns nothing of which it is.
  const expected = fromHex(signature.toLowerCase())!;
  const [app, webhook] = await Promise.all([
    githubAppOf(env.DB, secrets.secret, workspaceId),
    githubWebhookOf(env.DB, secrets.secret, workspaceId),
  ]);
  const fromApp = app !== null && (await signedWith(app.webhookSecret, body, expected));
  if (!fromApp && (webhook === null || !(await signedWith(webhook.secret, body, expected)))) {
    return json(
      {
        error: 'bad_signature',
        detail: "the signature does not match this workspace's GitHub App or the secret saved in Settings",
      },
      401,
    );
  }
  let payload: unknown;
  try {
    payload = payloadOf(request, body);
  } catch {
    return json({ error: 'invalid_request', detail: 'the payload is not JSON' }, 400);
  }
  const name = request.headers.get('x-github-event');
  if (fromApp && name === 'installation') return installationEvent(env, workspaceId, payload);
  if (fromApp && name !== 'ping') {
    const installationId = numberAt(payload, 'installation', 'id');
    if (installationId === undefined || !(await hasInstallation(env.DB, workspaceId, installationId))) {
      return json(
        {
          error: 'unknown_installation',
          detail: 'no owner of this workspace installed the app here, so its events are refused',
        },
        403,
      );
    }
  }
  const detected = await detectedOf(env.DB, workspaceId);
  const names = { typed: webhook?.deployChecks ?? [], detected: detected.checks };
  const event = readEvent(name, payload, names);
  if ('ignored' in event) {
    if (event.recheck === true) await workspaceStore(env, workspaceId).checkGitHub();
    return json({ moved: [], ignored: event.ignored }, 200);
  }
  let signal;
  try {
    signal = {
      ...signalArgs(event.signal, { pullRequests: 'pullRequests', commits: 'commits' }),
      ...(event.mergedBy === undefined ? {} : { mergedBy: event.mergedBy }),
      ...(event.at === undefined ? {} : { at: event.at }),
      ...(event.mergeCommit === undefined ? {} : { mergeCommit: event.mergeCommit }),
      ...(event.taskIds === undefined ? {} : { taskIds: event.taskIds }),
    };
  } catch (error) {
    if (error instanceof Refused) return json({ error: 'invalid_request', detail: error.detail }, 400);
    throw error;
  }
  // Recorded before the move, so a delivery GitHub sends again finds it listed whatever happens after.
  if (event.newDeploy !== undefined) await recordDetected(env.DB, workspaceId, { checks: [event.newDeploy] });
  if (event.check !== undefined) {
    const repository = String(event.signal.repository);
    const installationId = fromApp
      ? numberAt(payload, 'installation', 'id')
      : (await installationsByAccount(env.DB, workspaceId)).get(repository.split('/')[0]!.toLowerCase());
    const installation = installationId === undefined ? undefined : { id: installationId, sentEvent: fromApp };
    const held = await heldDeploys(app, installation, repository, event.check, names);
    if (held === RETRY) {
      // The store's check reads the commit's deploys again, and tries again while GitHub does not answer.
      await workspaceStore(env, workspaceId).checkGitHub();
      return json(
        {
          error: 'unavailable',
          detail: `GitHub did not answer a read of this commit's other deploy checks, so no task moved; Ntasks reads them again shortly`,
        },
        503,
      );
    }
    if (held.length > 0) {
      const which =
        held.length === 1
          ? `${held[0]!}, another deploy of this commit, has`
          : `${listed(held)}, other deploys of this commit, have`;
      return json({ moved: [], ignored: `${which} not passed, so no task moves yet` }, 200);
    }
  }
  const answer = await workspaceStore(env, workspaceId).deliver(signal, githubSender(workspaceId), {
    turnOnDeploys: { except: detected.projects },
  });
  if ('refused' in answer) return json({ error: 'unavailable', detail: answer.refused }, 503);
  try {
    await recordDetected(env.DB, workspaceId, { projects: answer.turnedOn });
  } catch {
    // The tasks moved, so GitHub is told so; a project left unrecorded can be
    // turned on once more by a later deploy, after its owner turned it off.
    console.error('github: the projects a deploy turned on were not recorded', workspaceId);
  }
  return json(
    {
      moved: movedView(answer.moved),
      ...(answer.closed.length === 0 ? {} : { closed: answer.closed }),
      ...(answer.kept.length === 0 ? {} : { kept: answer.kept }),
    },
    200,
  );
}
