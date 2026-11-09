// GitHub's deliveries through the Worker (src/github.ts): a signed
// pull_request, check_run or deployment_status event moves the closed tasks
// it names as POST /api/delivery would, and an unsigned or forged one is
// refused. The workspace's owner saves the secret and the deploy checks in
// Settings (POST /api/access/github).
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { Task } from '@ntasks/domain';
import { describe, expect, it } from 'vitest';
import { hex, randomSecret } from '../../src/access/crypto.ts';
import type { TaskStore } from '../../src/store/index.ts';
import { WORKSPACE_HEADER } from '../../src/workspaces.ts';
import { store, TEST_WORKSPACE } from '../store.ts';
import { addMember, Browser, call, connectAgent, createProject, ORIGIN, OWNER_GITHUB_ID, userIdOf } from './client.ts';
import { standInForGitHub } from './github.ts';

standInForGitHub();

const SECRET = randomSecret();
const DEPLOY_CHECK = 'Workers Builds: app';
const REPOSITORY = 'example/app';
const encoder = new TextEncoder();

type Body = Record<string, unknown>;

/** Sends `json` from the owner's browser, in the workspace `workspaceId` names, the test workspace by default. */
async function asOwner(
  owner: Browser,
  method: string,
  path: string,
  json?: Body,
  workspaceId = TEST_WORKSPACE.id,
): Promise<{ status: number; body: Body }> {
  const response = await owner.fetch(path, {
    method,
    ...(json === undefined ? {} : { json }),
    headers: { [WORKSPACE_HEADER]: workspaceId },
  });
  return { status: response.status, body: await response.json<Body>() };
}

/** The test workspace's owner, signed in, with the webhook's secret and deploy checks saved. */
async function ownerWithWebhook(): Promise<Browser> {
  const owner = new Browser();
  await owner.signInAsOwner();
  const saved = await asOwner(owner, 'POST', '/api/access/github', {
    secret: SECRET,
    deployChecks: [DEPLOY_CHECK, 'production'],
  });
  expect(saved.status).toBe(200);
  return owner;
}

/** A project of the test workspace whose changes go live by a deploy. */
async function deployingProject(): Promise<string> {
  const projectId = await createProject('Hooks');
  await runInDurableObject(store(), (instance: TaskStore) => instance.tasks.setProjectDeploys(projectId, true));
  return projectId;
}

/** A task closed as done with this proof, through the API as the owner. */
async function closedWith(owner: Browser, projectId: string, proof: Body): Promise<string> {
  const created = await asOwner(owner, 'POST', '/api/tasks', { projectId, title: 'Ship it' });
  expect(created.status).toBe(200);
  const id = created.body.id as string;
  const closed = await asOwner(owner, 'POST', `/api/tasks/${id}/close`, { projectId, reason: 'Shipped.', ...proof });
  expect(closed.status).toBe(200);
  return id;
}

/** The task as the store holds it, read in the store itself. */
async function taskOf(projectId: string, id: string): Promise<Task> {
  const task = await runInDurableObject(store(), (instance: TaskStore) => instance.tasks.getTask(projectId, id));
  if (!task) throw new Error(`no task ${id}`);
  return task;
}

/** A commit's hexadecimal name, a new one each time. */
function newCommit(): string {
  return hex(crypto.getRandomValues(new Uint8Array(20)));
}

/** A pull request number no other test uses. */
function newNumber(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
}

/** A delivery's `repository`, whose default branch is main. */
function repository(fullName = REPOSITORY) {
  return { full_name: fullName, default_branch: 'main' };
}

/** A `pull_request` delivery for a pull request merged into `base`, main unless named. */
function mergedPullRequest(number: number, mergeCommit: string, options: { repo?: string; base?: string } = {}) {
  const repo = options.repo ?? REPOSITORY;
  return {
    action: 'closed',
    number,
    pull_request: {
      number,
      html_url: `https://github.com/${repo}/pull/${number}`,
      merged: true,
      merge_commit_sha: mergeCommit,
      base: { ref: options.base ?? 'main' },
    },
    repository: repository(repo),
  };
}

/** A completed `check_run` delivery, a success on main unless the options say otherwise. */
function checkRun(name: string, sha: string, options: { branch?: string; conclusion?: string } = {}) {
  return {
    action: 'completed',
    check_run: {
      name,
      head_sha: sha,
      status: 'completed',
      conclusion: options.conclusion ?? 'success',
      check_suite: { head_branch: options.branch ?? 'main' },
    },
    repository: repository(),
  };
}

/** A `deployment_status` delivery for a deployment of `sha` to `environment`. */
function deploymentStatus(environment: string, sha: string, state = 'success') {
  return { deployment_status: { state }, deployment: { environment, sha }, repository: repository() };
}

/** X-Hub-Signature-256 of `body` under `secret`, as GitHub signs a delivery. */
async function signatureOf(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return `sha256=${hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body))))}`;
}

interface Delivery {
  /** The secret to sign with; null sends no signature. */
  readonly secret?: string | null;
  readonly signature?: string;
  readonly workspaceId?: string;
  readonly id?: string;
  readonly contentType?: string;
}

/** Sends one delivery to the receiver, signed as GitHub signs it, and reads the answer. */
async function deliver(
  event: string,
  payload: unknown,
  options: Delivery = {},
): Promise<{ status: number; body: Body; version: string | null }> {
  const json = JSON.stringify(payload);
  const form = options.contentType === 'application/x-www-form-urlencoded';
  const body = form ? new URLSearchParams({ payload: json }).toString() : json;
  const secret = options.secret === undefined ? SECRET : options.secret;
  const signature = options.signature ?? (secret === null ? undefined : await signatureOf(secret, body));
  const response = await call(`/api/github/${options.workspaceId ?? TEST_WORKSPACE.id}`, {
    method: 'POST',
    headers: {
      'content-type': options.contentType ?? 'application/json',
      'user-agent': 'GitHub-Hookshot/0000000',
      'x-github-event': event,
      'x-github-delivery': options.id ?? crypto.randomUUID(),
      ...(signature === undefined ? {} : { 'x-hub-signature-256': signature }),
    },
    body,
  });
  return {
    status: response.status,
    body: await response.json<Body>(),
    version: response.headers.get('x-ntasks-api-version'),
  };
}

describe('the GitHub receiver', () => {
  it('refuses a delivery that is unsigned, forged or for a workspace without the secret, and moves nothing', async () => {
    const owner = await ownerWithWebhook();
    const projectId = await deployingProject();
    const number = newNumber();
    const id = await closedWith(owner, projectId, { pullRequest: `https://github.com/${REPOSITORY}/pull/${number}` });
    const event = mergedPullRequest(number, newCommit());
    const signed = JSON.stringify(event);

    expect(await deliver('pull_request', event, { secret: null })).toMatchObject({
      status: 401,
      body: { error: 'signature_required' },
    });
    const sha1 = `sha1=${'0'.repeat(40)}`;
    expect(await deliver('pull_request', event, { signature: sha1 })).toMatchObject({
      status: 401,
      body: { error: 'signature_required' },
    });
    for (const forged of [
      { secret: randomSecret() },
      { signature: await signatureOf(SECRET, `${signed} `) },
      { workspaceId: crypto.randomUUID() },
    ]) {
      expect(await deliver('pull_request', event, forged)).toMatchObject({
        status: 401,
        body: { error: 'bad_signature' },
      });
    }
    expect((await call(`/api/github/${TEST_WORKSPACE.id}`)).status).toBe(405);
    expect((await taskOf(projectId, id)).delivery).toMatchObject({ stage: 'built', mergeCommit: null });
  });

  it('moves a task to merged when its pull request merges, recording the merge commit and GitHub as the actor', async () => {
    const owner = await ownerWithWebhook();
    const projectId = await deployingProject();
    const number = newNumber();
    const id = await closedWith(owner, projectId, {
      commit: newCommit(),
      pullRequest: `https://github.com/Example/App/pull/${number}`,
    });
    const merge = newCommit();

    const answer = await deliver('pull_request', mergedPullRequest(number, merge));
    expect(answer).toEqual({ status: 200, body: { moved: [{ id, stage: 'merged' }] }, version: expect.any(String) });
    const task = await taskOf(projectId, id);
    expect(task.delivery).toMatchObject({ stage: 'merged', mergeCommit: merge });
    const [latest] = await runInDurableObject(store(), (instance: TaskStore) =>
      instance.tasks.listHistory(projectId, id, { limit: 1 }),
    );
    expect(latest).toMatchObject({ actor: 'service:GitHub', version: task.version });
  });

  it('moves a merged task to live when a deploy check passes on the default branch, and for nothing else', async () => {
    const owner = await ownerWithWebhook();
    const projectId = await deployingProject();
    const number = newNumber();
    const id = await closedWith(owner, projectId, { pullRequest: `https://github.com/${REPOSITORY}/pull/${number}` });
    const merge = newCommit();
    await deliver('pull_request', mergedPullRequest(number, merge));

    for (const [run, reason] of [
      [checkRun(DEPLOY_CHECK, merge, { branch: 'preview' }), /default branch/u],
      [checkRun('Lint', merge), /not among this workspace's deploy checks/u],
      [checkRun(DEPLOY_CHECK, merge, { conclusion: 'failure' }), /completed with success/u],
      [{ ...checkRun(DEPLOY_CHECK, merge), action: 'created' }, /completed with success/u],
    ] as const) {
      const answer = await deliver('check_run', run);
      expect(answer.status).toBe(200);
      expect(answer.body.moved).toEqual([]);
      expect(answer.body.ignored).toMatch(reason);
    }
    expect((await taskOf(projectId, id)).delivery?.stage).toBe('merged');

    expect(await deliver('check_run', checkRun(DEPLOY_CHECK, merge))).toMatchObject({
      status: 200,
      body: { moved: [{ id, stage: 'live' }] },
    });
    expect((await taskOf(projectId, id)).delivery?.stage).toBe('live');
  });

  it('moves a task to live when a deployment to an environment named among the deploy checks succeeds', async () => {
    const owner = await ownerWithWebhook();
    const projectId = await deployingProject();
    const commit = newCommit();
    const id = await closedWith(owner, projectId, { commit });

    for (const status of [deploymentStatus('preview', commit), deploymentStatus('production', commit, 'failure')]) {
      expect((await deliver('deployment_status', status)).body.moved).toEqual([]);
    }
    expect((await taskOf(projectId, id)).delivery?.stage).toBe('built');
    expect((await deliver('deployment_status', deploymentStatus('production', commit))).body).toEqual({
      moved: [{ id, stage: 'live' }],
    });
  });

  it('leaves a task alone when a pull request with its number merges in another repository', async () => {
    const owner = await ownerWithWebhook();
    const projectId = await deployingProject();
    const number = newNumber();
    const id = await closedWith(owner, projectId, { pullRequest: `https://github.com/${REPOSITORY}/pull/${number}` });

    const elsewhere = await deliver('pull_request', mergedPullRequest(number, newCommit(), { repo: 'example/other' }));
    expect(elsewhere).toMatchObject({ status: 200, body: { moved: [] } });
    expect((await taskOf(projectId, id)).delivery).toMatchObject({ stage: 'built', mergeCommit: null });
  });

  it('moves nothing when GitHub sends the same delivery again', async () => {
    const owner = await ownerWithWebhook();
    const projectId = await deployingProject();
    const number = newNumber();
    const id = await closedWith(owner, projectId, { pullRequest: `https://github.com/${REPOSITORY}/pull/${number}` });
    const event = mergedPullRequest(number, newCommit());
    const delivery = crypto.randomUUID();

    expect((await deliver('pull_request', event, { id: delivery })).body).toEqual({ moved: [{ id, stage: 'merged' }] });
    const version = (await taskOf(projectId, id)).version;
    expect(await deliver('pull_request', event, { id: delivery })).toMatchObject({
      status: 200,
      body: { moved: [] },
    });
    expect((await taskOf(projectId, id)).version).toBe(version);
  });

  it('never moves a task back a stage', async () => {
    const owner = await ownerWithWebhook();
    const projectId = await deployingProject();
    const number = newNumber();
    const commit = newCommit();
    const id = await closedWith(owner, projectId, {
      commit,
      pullRequest: `https://github.com/${REPOSITORY}/pull/${number}`,
    });
    expect((await deliver('check_run', checkRun(DEPLOY_CHECK, commit))).body).toEqual({
      moved: [{ id, stage: 'live' }],
    });

    expect((await deliver('pull_request', mergedPullRequest(number, newCommit()))).body).toEqual({ moved: [] });
    expect((await taskOf(projectId, id)).delivery).toMatchObject({ stage: 'live', mergeCommit: null });
  });

  it('reads a delivery sent as a form, as GitHub sends one by default', async () => {
    const owner = await ownerWithWebhook();
    const projectId = await deployingProject();
    const number = newNumber();
    const id = await closedWith(owner, projectId, { pullRequest: `https://github.com/${REPOSITORY}/pull/${number}` });

    const answer = await deliver('pull_request', mergedPullRequest(number, newCommit()), {
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(answer).toMatchObject({ status: 200, body: { moved: [{ id, stage: 'merged' }] } });
  });

  it('answers a ping, a pull request closed without merging or merged elsewhere, and other events, moving nothing', async () => {
    const owner = await ownerWithWebhook();
    const projectId = await deployingProject();
    const number = newNumber();
    const id = await closedWith(owner, projectId, { pullRequest: `https://github.com/${REPOSITORY}/pull/${number}` });
    const unmerged = mergedPullRequest(number, newCommit());
    unmerged.pull_request.merged = false;

    for (const [event, payload, reason] of [
      ['ping', { zen: 'Keep it logically awesome.', hook_id: 1 }, /reaches Ntasks/u],
      ['pull_request', unmerged, /only a merged pull request/u],
      ['pull_request', mergedPullRequest(number, newCommit(), { base: 'release' }), /release, not the default branch/u],
      ['push', { ref: 'refs/heads/main', repository: repository() }, /not push/u],
    ] as const) {
      const answer = await deliver(event, payload);
      expect(answer.status).toBe(200);
      expect(answer.body.moved).toEqual([]);
      expect(answer.body.ignored).toMatch(reason);
    }
    expect((await taskOf(projectId, id)).delivery?.stage).toBe('built');
  });
});

describe('the GitHub webhook in Settings', () => {
  const OTHER = Object.freeze({ id: '3e8b1f60-2a4c-4d7e-8f19-6c0a2b4d6e81', name: 'Webhook workspace' });

  /** The owner, signed in and an owner of OTHER too, where these tests save their settings. */
  async function owner(): Promise<Browser> {
    const browser = new Browser();
    await browser.signInAsOwner();
    await addMember(OTHER, (await userIdOf(OWNER_GITHUB_ID))!, 'owner');
    return browser;
  }

  it('shows an owner where GitHub sends and whether a secret is saved, never the secret itself', async () => {
    const browser = await owner();
    const github = (path: string, json?: Body) => asOwner(browser, json ? 'POST' : 'GET', path, json, OTHER.id);
    const url = `${ORIGIN}/api/github/${OTHER.id}`;

    expect(await github('/api/access/github')).toEqual({
      status: 200,
      body: { github: { url, secretSaved: false, deployChecks: [], updatedAt: null } },
    });
    expect(await github('/api/access/github', { deployChecks: ['production'] })).toMatchObject({
      status: 400,
      body: { error: 'invalid_request', field: 'secret' },
    });

    const secret = randomSecret();
    const saved = await github('/api/access/github', { secret, deployChecks: [' Workers Builds: app ', 'production'] });
    expect(saved).toEqual({
      status: 200,
      body: {
        github: {
          url,
          secretSaved: true,
          deployChecks: ['Workers Builds: app', 'production'],
          updatedAt: expect.any(String),
        },
      },
    });
    expect(JSON.stringify(saved.body)).not.toContain(secret);
    const stored = await env.DB.prepare('SELECT secret FROM access_github_webhooks WHERE workspace_id = ?')
      .bind(OTHER.id)
      .first<{ secret: string }>();
    expect(stored?.secret).toBeTruthy();
    expect(stored?.secret).not.toContain(secret);

    // Deploy checks change alone, and the secret stays.
    expect((await github('/api/access/github', { deployChecks: ['production', 'production'] })).body).toMatchObject({
      github: { secretSaved: true, deployChecks: ['production'] },
    });
    const ping = await deliver('ping', { hook_id: 2 }, { secret, workspaceId: OTHER.id });
    expect(ping.status).toBe(200);

    expect(await github('/api/access/github/remove', {})).toEqual({ status: 200, body: { removed: true } });
    expect((await github('/api/access/github')).body).toMatchObject({ github: { secretSaved: false } });
    expect(await deliver('ping', { hook_id: 2 }, { secret, workspaceId: OTHER.id })).toMatchObject({
      status: 401,
      body: { error: 'bad_signature' },
    });
    expect(await github('/api/access/github/remove', {})).toMatchObject({ status: 404, body: { error: 'not_found' } });
  });

  it('refuses a malformed secret or list of deploy checks', async () => {
    const browser = await owner();
    for (const [body, field] of [
      [{ secret: 'too-short' }, 'secret'],
      [{ secret: `${randomSecret()} with spaces` }, 'secret'],
      [{ secret: 42 }, 'secret'],
      [{ secret: randomSecret(), deployChecks: 'production' }, 'deployChecks'],
      [{ secret: randomSecret(), deployChecks: [''] }, 'deployChecks'],
      [{ secret: randomSecret(), deployChecks: Array.from({ length: 21 }, (_, i) => `check ${i}`) }, 'deployChecks'],
      [{ secret: randomSecret(), events: ['push'] }, undefined],
      [{}, undefined],
    ] as const) {
      const answer = await asOwner(browser, 'POST', '/api/access/github', body, OTHER.id);
      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ error: 'invalid_request' });
      expect(answer.body.field).toBe(field);
    }
  });

  it('is for the workspace’s owners alone, in their own browser', async () => {
    const member = new Browser({ joinTestWorkspace: false });
    await member.signInWithGitHub(1003);
    await addMember(TEST_WORKSPACE, (await userIdOf(1003))!, 'member');
    for (const [method, path] of [
      ['GET', '/api/access/github'],
      ['POST', '/api/access/github'],
      ['POST', '/api/access/github/remove'],
    ] as const) {
      const json = method === 'POST' ? { secret: randomSecret() } : undefined;
      expect(await asOwner(member, method, path, json)).toMatchObject({ status: 403, body: { error: 'owner_only' } });
    }

    const browser = await owner();
    const { tokens } = await connectAgent(browser, [await createProject('Agent')]);
    const asAgent = await call('/api/access/github', {
      headers: { authorization: `Bearer ${tokens.access_token}`, [WORKSPACE_HEADER]: TEST_WORKSPACE.id },
    });
    expect(asAgent.status).toBe(403);
  });
});
