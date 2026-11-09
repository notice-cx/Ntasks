/**
 * The GitHub receiver: POST /api/github/<workspace id>, where a workspace's
 * GitHub webhook sends its deliveries, so a closed task moves to merged and
 * live without an agent reporting it. A delivery is read only when its
 * X-Hub-Signature-256 is the HMAC-SHA-256 of its body under the secret the
 * workspace's owner saved (access/github-webhook.ts). Its event then becomes
 * the signal POST /api/delivery and report_delivery send (delivery.ts), for
 * every project of the workspace:
 *
 * - `pull_request` closed and merged into the default branch: `merged`,
 *   naming the pull request and its merge commit;
 * - `check_run` completed with success on the default branch, whose name is
 *   one of the workspace's deploy checks: `live`, naming its commit;
 * - `deployment_status` success, for an environment named among the deploy
 *   checks: `live`, naming the deployed commit.
 *
 * Any other event is answered with why it moves nothing. A task never moves
 * back, so a delivery that GitHub sends again moves nothing twice.
 * docs/api.md#from-a-github-webhook describes the setup.
 */
import { signInSecrets } from './access/config.ts';
import { fromHex, sameBytes } from './access/crypto.ts';
import { githubWebhookOf } from './access/github-webhook.ts';
import { notConfigured } from './access/verify.ts';
import type { Args } from './args.ts';
import { SCOPES, type Principal } from './auth.ts';
import { movedView, signalArgs } from './delivery.ts';
import { readBoundedBytes } from './http/json-body.ts';
import { json } from './http/respond.ts';
import { Refused } from './refused.ts';
import { workspaceStore } from './store/index.ts';

/** The largest delivery read. GitHub's events that move tasks are a few tens of KB. */
const DELIVERY_BYTES = 1024 * 1024;

const SIGNATURE = /^sha256=([0-9a-fA-F]{64})$/u;

const encoder = new TextEncoder();

/** The sender a verified delivery acts as: a service that may change every project of the workspace. */
function githubSender(workspaceId: string): Principal {
  return Object.freeze({
    id: `github:${workspaceId}`,
    name: 'service:GitHub',
    scopes: [SCOPES.read, SCOPES.write],
    projects: 'all',
  });
}

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

/** What an event says: the signal it sends, or why it sends none, as GitHub's list of deliveries shows it. */
export type GitHubEvent = { readonly signal: Args } | { readonly ignored: string };

/** The signal an event sends, given the workspace's deploy checks. */
export function readEvent(event: string | null, payload: unknown, deployChecks: readonly string[]): GitHubEvent {
  if (event === 'ping') return { ignored: 'GitHub reaches Ntasks. A merged pull request or a deploy moves tasks.' };
  const repository = textAt(payload, 'repository', 'full_name');
  const defaultBranch = textAt(payload, 'repository', 'default_branch');
  if (repository === undefined || defaultBranch === undefined)
    return { ignored: 'an event without its repository and default branch moves no task' };
  const commits = (sha: string | undefined) => (sha === undefined ? [] : [sha]);
  switch (event) {
    case 'pull_request': {
      if (at(payload, 'action') !== 'closed' || at(payload, 'pull_request', 'merged') !== true)
        return { ignored: 'only a merged pull request moves a task' };
      const base = textAt(payload, 'pull_request', 'base', 'ref');
      if (base !== defaultBranch)
        return { ignored: `merged into ${base ?? 'another branch'}, not the default branch, so no task moves` };
      const url = textAt(payload, 'pull_request', 'html_url');
      return {
        signal: {
          repository,
          stage: 'merged',
          pullRequests: url === undefined ? [] : [url],
          commits: commits(textAt(payload, 'pull_request', 'merge_commit_sha')),
        },
      };
    }
    case 'check_run': {
      if (at(payload, 'action') !== 'completed' || at(payload, 'check_run', 'conclusion') !== 'success')
        return { ignored: 'only a check run that completed with success moves a task' };
      const name = textAt(payload, 'check_run', 'name');
      if (name === undefined || !deployChecks.includes(name))
        return { ignored: `${name ?? 'this check'} is not among this workspace's deploy checks` };
      const branch = textAt(payload, 'check_run', 'check_suite', 'head_branch');
      if (branch !== defaultBranch)
        return { ignored: `a deploy check on ${branch ?? 'another branch'}, not the default branch, moves no task` };
      return { signal: { repository, stage: 'live', commits: commits(textAt(payload, 'check_run', 'head_sha')) } };
    }
    case 'deployment_status': {
      if (at(payload, 'deployment_status', 'state') !== 'success')
        return { ignored: 'only a successful deployment moves a task' };
      const environment = textAt(payload, 'deployment', 'environment');
      if (environment === undefined || !deployChecks.includes(environment))
        return { ignored: `the ${environment ?? 'unnamed'} environment is not among this workspace's deploy checks` };
      return { signal: { repository, stage: 'live', commits: commits(textAt(payload, 'deployment', 'sha')) } };
    }
    default:
      return {
        ignored: `Ntasks reads pull_request, check_run and deployment_status events, not ${event ?? 'this one'}`,
      };
  }
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
  // One answer for an unknown workspace, one with no webhook and a wrong
  // signature, so a caller without the secret learns nothing of which it is.
  const webhook = await githubWebhookOf(env.DB, secrets.secret, workspaceId);
  if (webhook === null || !(await signedWith(webhook.secret, body, fromHex(signature.toLowerCase())!))) {
    return json(
      {
        error: 'bad_signature',
        detail: "the signature does not match the secret saved in this workspace's Settings, or none is saved",
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
  const event = readEvent(request.headers.get('x-github-event'), payload, webhook.deployChecks);
  if ('ignored' in event) return json({ moved: [], ignored: event.ignored }, 200);
  let signal;
  try {
    signal = signalArgs(event.signal, { pullRequests: 'pullRequests', commits: 'commits' });
  } catch (error) {
    if (error instanceof Refused) return json({ error: 'invalid_request', detail: error.detail }, 400);
    throw error;
  }
  const answer = await workspaceStore(env, workspaceId).deliver(signal, githubSender(workspaceId));
  if ('refused' in answer) return json({ error: 'unavailable', detail: answer.refused }, 503);
  return json({ moved: movedView(answer.moved) }, 200);
}
