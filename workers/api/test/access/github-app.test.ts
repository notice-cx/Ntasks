// Connect GitHub through the Worker, from a fresh workspace: the owner makes
// the workspace's GitHub App through GitHub's manifest flow, installs it, and
// the installation's events move a closed task to merged and then live with
// no deploy check typed and no project ticked. Events from an installation
// no owner made are refused.
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { Task } from '@ntasks/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { hex } from '../../src/access/crypto.ts';
import type { TaskStore } from '../../src/store/index.ts';
import { WORKSPACE_HEADER } from '../../src/workspaces.ts';
import { store, TEST_WORKSPACE } from '../store.ts';
import { addMember, Browser, call, createProject, ORIGIN, OWNER_GITHUB_ID, userIdOf } from './client.ts';
import { convertedWebhookSecret, manifestCodeFor, standInForGitHub } from './github.ts';

const github = standInForGitHub();

// A close or a delivery sets the store's check for a few seconds later. Left
// set, it could run once the stand-in no longer answers for GitHub.
afterEach(async () => {
  await runInDurableObject(store(), (_instance: TaskStore, state) => state.storage.deleteAlarm());
});

const APP_SECRET = convertedWebhookSecret(OWNER_GITHUB_ID);
const SLUG = `ntasks-${OWNER_GITHUB_ID}`;
const REPOSITORY = 'example/site';
const encoder = new TextEncoder();

type Body = Record<string, unknown>;

/** Sends `json` from `browser` in the test workspace and reads the answer. */
async function inWorkspace(browser: Browser, method: string, path: string, json?: Body) {
  const response = await browser.fetch(path, {
    method,
    ...(json === undefined ? {} : { json }),
    headers: { [WORKSPACE_HEADER]: TEST_WORKSPACE.id },
  });
  return { status: response.status, body: await response.json<Body>() };
}

/** Presses Connect GitHub as `owner`: the action and manifest the browser posts to GitHub, and GitHub's state. */
async function connect(owner: Browser) {
  const started = await inWorkspace(owner, 'POST', '/api/access/github/app', {});
  expect(started.status).toBe(200);
  const action = new URL(started.body.action as string);
  return {
    action,
    manifest: JSON.parse(started.body.manifest as string) as Body,
    state: action.searchParams.get('state')!,
  };
}

/** GitHub's return to Ntasks once the person pressed Create GitHub App. */
function returnFromGitHub(browser: Browser, code: string, state: string): Promise<Response> {
  return browser.fetch(`/api/access/github/app/created?code=${code}&state=${encodeURIComponent(state)}`);
}

/** The owner, signed in, with the workspace's app made through the manifest flow. */
async function connected(): Promise<Browser> {
  const owner = new Browser();
  await owner.signInAsOwner();
  const { state } = await connect(owner);
  expect((await returnFromGitHub(owner, manifestCodeFor(OWNER_GITHUB_ID), state)).status).toBe(302);
  return owner;
}

/** X-Hub-Signature-256 of `body` under `secret`, as GitHub signs a delivery. */
async function signatureOf(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return `sha256=${hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body))))}`;
}

/** Sends one delivery from the app, signed with its webhook secret, and reads the answer. */
async function deliver(event: string, payload: Body, secret = APP_SECRET): Promise<{ status: number; body: Body }> {
  const body = JSON.stringify(payload);
  const response = await call(`/api/github/${TEST_WORKSPACE.id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': crypto.randomUUID(),
      'x-hub-signature-256': await signatureOf(secret, body),
    },
    body,
  });
  return { status: response.status, body: await response.json<Body>() };
}

/** GitHub's installation event: `sender` installed the app on `account` as installation `id`. */
function installation(id: number, action: string, sender: number, account = 'example') {
  return {
    action,
    installation: { id, account: { login: account, type: 'Organization' } },
    sender: { id: sender, login: `person-${sender}` },
  };
}

/** An installation id no other test uses. */
function newInstallation(): number {
  return 1 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000_000);
}

/** A commit's hexadecimal name, a new one each time. */
function newCommit(): string {
  return hex(crypto.getRandomValues(new Uint8Array(20)));
}

/** A delivery's repository, whose default branch is main. */
const repository = { full_name: REPOSITORY, default_branch: 'main' };

/** A merged pull request's event, from installation `id`. */
function merged(id: number, number: number, mergeCommit: string) {
  return {
    action: 'closed',
    installation: { id },
    pull_request: {
      html_url: `https://github.com/${REPOSITORY}/pull/${number}`,
      merged: true,
      merge_commit_sha: mergeCommit,
      base: { ref: 'main' },
    },
    repository,
  };
}

/** A check run that passed on main, from installation `id`. */
function passed(id: number, name: string, sha: string, branch = 'main', startedAt = new Date().toISOString()) {
  return {
    action: 'completed',
    installation: { id },
    check_run: {
      name,
      head_sha: sha,
      conclusion: 'success',
      started_at: startedAt,
      check_suite: { head_branch: branch },
    },
    repository,
  };
}

/** A task of `projectId` closed with this pull request; answers its id. */
async function closedWithPullRequest(
  owner: Browser,
  projectId: string,
  number: number,
  repo = REPOSITORY,
): Promise<string> {
  const created = await inWorkspace(owner, 'POST', '/api/tasks', { projectId, title: 'Ship the page' });
  const id = created.body.id as string;
  const pullRequest = `https://github.com/${repo}/pull/${number}`;
  expect(
    (await inWorkspace(owner, 'POST', `/api/tasks/${id}/close`, { projectId, reason: 'Done.', pullRequest })).status,
  ).toBe(200);
  return id;
}

/** A project of the test workspace that does not deploy yet, and one task closed in it with this pull request. */
async function taskWithPullRequest(
  owner: Browser,
  number: number,
  repo = REPOSITORY,
): Promise<{ projectId: string; id: string }> {
  const projectId = await createProject('Site');
  return { projectId, id: await closedWithPullRequest(owner, projectId, number, repo) };
}

/** A project whose changes go live by a deploy, as an earlier deploy or its owner turned it on. */
async function deployingProject(owner: Browser): Promise<string> {
  const projectId = await createProject('Site');
  expect((await inWorkspace(owner, 'PATCH', '/api/tasks/projects', { projectId, deploys: true })).status).toBe(200);
  return projectId;
}

/** A merged pull request's event that names GitHub's merge time. */
function mergedAt(id: number, number: number, mergeCommit: string, at: string) {
  const event = merged(id, number, mergeCommit);
  return { ...event, pull_request: { ...event.pull_request, merged_at: at } };
}

/** The time `ms` milliseconds before now, as GitHub writes one. */
function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

async function taskOf(projectId: string, id: string): Promise<Task> {
  const task = await runInDurableObject(store(), (instance: TaskStore) => instance.tasks.getTask(projectId, id));
  if (!task) throw new Error(`no task ${id}`);
  return task;
}

async function deploys(projectId: string): Promise<boolean | undefined> {
  const projects = await runInDurableObject(store(), (instance: TaskStore) => instance.tasks.listProjects());
  return projects.find((project) => project.id === projectId)?.deploys;
}

describe('Connect GitHub', () => {
  it('makes the app from a manifest, stores its credentials encrypted and sends the owner on to install it', async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const before = await inWorkspace(owner, 'GET', '/api/access/github');
    expect(before.body).toMatchObject({ github: { app: null, installations: [], detected: [] } });

    const { action, manifest, state } = await connect(owner);
    expect(`${action.origin}${action.pathname}`).toBe('https://github.com/settings/apps/new');
    expect(manifest).toMatchObject({
      url: ORIGIN,
      hook_attributes: { url: `${ORIGIN}/api/github/${TEST_WORKSPACE.id}`, active: true },
      redirect_url: `${ORIGIN}/api/access/github/app/created`,
      setup_url: `${ORIGIN}/tasks/settings/github`,
      public: true,
      default_permissions: { metadata: 'read', pull_requests: 'read', checks: 'read', deployments: 'read' },
      default_events: ['pull_request', 'check_run', 'deployment_status'],
    });
    expect((manifest.name as string).length).toBeLessThanOrEqual(34);

    const back = await returnFromGitHub(owner, manifestCodeFor(OWNER_GITHUB_ID), state);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe(
      `https://github.com/apps/${SLUG}/installations/new/permissions?target_id=${OWNER_GITHUB_ID}`,
    );
    const stored = await env.DB.prepare(
      'SELECT app_id, slug, credentials FROM access_github_apps WHERE workspace_id = ?',
    )
      .bind(TEST_WORKSPACE.id)
      .first<{ app_id: number; slug: string; credentials: string }>();
    expect(stored).toMatchObject({ app_id: 9000 + OWNER_GITHUB_ID, slug: SLUG });
    expect(stored?.credentials).not.toContain(APP_SECRET);
    expect(stored?.credentials).not.toContain('PRIVATE KEY');
    expect((await inWorkspace(owner, 'GET', '/api/access/github')).body).toMatchObject({
      github: {
        app: {
          slug: SLUG,
          url: `https://github.com/apps/${SLUG}`,
          installUrl: `https://github.com/apps/${SLUG}/installations/new`,
          accountInstallUrl: `https://github.com/apps/${SLUG}/installations/new/permissions?target_id=${OWNER_GITHUB_ID}`,
        },
        installations: [],
      },
    });
  });

  it('sends the browser back to Settings and stores nothing for a state from elsewhere or a code GitHub refuses', async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    await inWorkspace(owner, 'POST', '/api/access/github/app/remove', {});
    const { state } = await connect(owner);
    const other = new Browser();
    await other.signInAsOwner();
    for (const [browser, code, given] of [
      [other, manifestCodeFor(OWNER_GITHUB_ID), state],
      [owner, manifestCodeFor(OWNER_GITHUB_ID), `${state}x`],
      [owner, 'not-a-manifest-code', state],
    ] as const) {
      const back = await returnFromGitHub(browser, code, given);
      expect(back.status).toBe(302);
      expect(back.headers.get('location')).toBe(`${ORIGIN}/tasks/settings/github?github=retry`);
    }
    expect((await inWorkspace(owner, 'GET', '/api/access/github')).body).toMatchObject({ github: { app: null } });
  });

  it('is for the workspace’s owners alone', async () => {
    const member = new Browser({ joinTestWorkspace: false });
    await member.signInWithGitHub(1003);
    await addMember(TEST_WORKSPACE, (await userIdOf(1003))!, 'member');
    for (const path of ['/api/access/github/app', '/api/access/github/app/remove', '/api/access/github/checks']) {
      expect(await inWorkspace(member, 'POST', path, {})).toMatchObject({ status: 403, body: { error: 'owner_only' } });
    }
  });
});

describe('the app’s deliveries', () => {
  it('reads an installation an owner made and refuses one anyone else made', async () => {
    const owner = await connected();
    const mine = newInstallation();
    const theirs = newInstallation();
    expect(await deliver('installation', installation(mine, 'created', OWNER_GITHUB_ID, 'example'))).toMatchObject({
      status: 200,
      body: { moved: [], ignored: expect.stringMatching(/example's repositories/u) },
    });
    expect(await deliver('installation', installation(theirs, 'created', 4242, 'stranger'))).toMatchObject({
      status: 403,
      body: { error: 'not_an_owner' },
    });
    expect((await inWorkspace(owner, 'GET', '/api/access/github')).body).toMatchObject({
      github: { installations: [{ installationId: mine, account: 'example', accountType: 'Organization' }] },
    });

    const { projectId, id } = await taskWithPullRequest(owner, 31);
    expect(await deliver('pull_request', merged(theirs, 31, newCommit()))).toMatchObject({
      status: 403,
      body: { error: 'unknown_installation' },
    });
    expect((await taskOf(projectId, id)).delivery?.stage).toBe('built');

    expect(await deliver('installation', installation(mine, 'deleted', OWNER_GITHUB_ID))).toMatchObject({
      status: 200,
    });
    expect(await deliver('pull_request', merged(mine, 31, newCommit()))).toMatchObject({
      status: 403,
      body: { error: 'unknown_installation' },
    });
  });

  it('moves a task to merged and then live, detecting the deploy check and turning the project on', async () => {
    const owner = await connected();
    const mine = newInstallation();
    await deliver('installation', installation(mine, 'created', OWNER_GITHUB_ID));
    const { projectId, id } = await taskWithPullRequest(owner, 32);
    expect(await deploys(projectId)).toBe(false);
    const merge = newCommit();

    expect((await deliver('pull_request', merged(mine, 32, merge))).body).toEqual({ moved: [{ id, stage: 'merged' }] });
    expect((await deliver('check_run', passed(mine, 'Lint', merge))).body).toMatchObject({
      moved: [],
      ignored: 'Lint is not a deploy',
    });
    expect((await deliver('check_run', passed(mine, 'Workers Builds: site', merge))).body).toEqual({
      moved: [{ id, stage: 'live' }],
    });
    expect(await deploys(projectId)).toBe(true);
    expect((await inWorkspace(owner, 'GET', '/api/access/github')).body).toMatchObject({
      github: {
        detected: expect.arrayContaining([{ name: 'Workers Builds: site', on: true, seenAt: expect.any(String) }]),
      },
    });
  });

  it('counts a deploy of a commit the merge queue landed, and not a preview of it', async () => {
    const owner = await connected();
    const mine = newInstallation();
    await deliver('installation', installation(mine, 'created', OWNER_GITHUB_ID));
    const { projectId, id } = await taskWithPullRequest(owner, 38);
    const merge = newCommit();
    // GitHub merged two minutes before its event reached Ntasks; the merge time is GitHub's.
    const mergedAt = new Date(Date.now() - 120_000).toISOString();
    const event = merged(mine, 38, merge);
    await deliver('pull_request', { ...event, pull_request: { ...event.pull_request, merged_at: mergedAt } });
    expect((await taskOf(projectId, id)).delivery?.mergedAt).toBe(mergedAt);
    const queue = 'gh-readonly-queue/main/pr-38-0123abc';
    const beforeMerge = new Date(Date.now() - 180_000).toISOString();
    const afterMerge = new Date(Date.now() - 60_000).toISOString();

    // GitHub names a commit's check suite for the branch first pushed with it: the queue's, for a queued merge.
    const otherQueue = passed(
      mine,
      'Workers Builds: site',
      merge,
      'gh-readonly-queue/release/pr-38-0123abc',
      afterMerge,
    );
    expect((await deliver('check_run', otherQueue)).body).toMatchObject({
      moved: [],
      ignored: expect.stringMatching(/not the default branch/u),
    });
    // A build of the queue's branch that started before the merge was a preview, which ships nothing.
    expect((await deliver('check_run', passed(mine, 'Workers Builds: site', merge, queue, beforeMerge))).body).toEqual({
      moved: [],
    });
    expect((await taskOf(projectId, id)).delivery?.stage).toBe('merged');
    // One that started after GitHub's merge counts, even before Ntasks heard of the merge.
    expect((await deliver('check_run', passed(mine, 'Workers Builds: site', merge, queue, afterMerge))).body).toEqual({
      moved: [{ id, stage: 'live' }],
    });
    expect((await taskOf(projectId, id)).delivery?.stage).toBe('live');
  });

  it('counts a queue deploy that started in the same second as the merge', async () => {
    const owner = await connected();
    const mine = newInstallation();
    await deliver('installation', installation(mine, 'created', OWNER_GITHUB_ID));
    const { projectId, id } = await taskWithPullRequest(owner, 39);
    const merge = newCommit();
    // GitHub gives both times to the second. A merge queue merges only once its checks pass on the
    // queue's branch, which takes minutes, so a preview there starts well before the merge, never in its second.
    const second = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000).toISOString().replace('.000Z', 'Z');
    const event = merged(mine, 39, merge);
    await deliver('pull_request', { ...event, pull_request: { ...event.pull_request, merged_at: second } });
    const queue = 'gh-readonly-queue/main/pr-39-0123abc';
    expect((await deliver('check_run', passed(mine, 'Workers Builds: site', merge, queue, second))).body).toEqual({
      moved: [{ id, stage: 'live' }],
    });
    expect((await taskOf(projectId, id)).delivery?.stage).toBe('live');
  });

  it('keeps a project off once its owner turns it off, and a deploy check off once switched off', async () => {
    const owner = await connected();
    const mine = newInstallation();
    await deliver('installation', installation(mine, 'created', OWNER_GITHUB_ID));
    const first = await taskWithPullRequest(owner, 33);
    const merge = newCommit();
    await deliver('pull_request', merged(mine, 33, merge));
    await deliver('check_run', passed(mine, 'Workers Builds: docs', merge));
    expect(await deploys(first.projectId)).toBe(true);

    // The owner turns the project off again: a later deploy leaves it off, and its task at merged.
    expect(
      (await inWorkspace(owner, 'PATCH', '/api/tasks/projects', { projectId: first.projectId, deploys: false })).status,
    ).toBe(200);
    const created = await inWorkspace(owner, 'POST', '/api/tasks', { projectId: first.projectId, title: 'Again' });
    const again = created.body.id as string;
    const pullRequest = `https://github.com/${REPOSITORY}/pull/34`;
    await inWorkspace(owner, 'POST', `/api/tasks/${again}/close`, {
      projectId: first.projectId,
      reason: 'Done.',
      pullRequest,
    });
    const second = newCommit();
    await deliver('pull_request', merged(mine, 34, second));
    await deliver('check_run', passed(mine, 'Workers Builds: docs', second));
    expect(await deploys(first.projectId)).toBe(false);
    expect((await taskOf(first.projectId, again)).delivery?.stage).toBe('merged');

    // A switched-off check moves nothing.
    const off = await inWorkspace(owner, 'POST', '/api/access/github/checks', {
      name: 'Workers Builds: docs',
      on: false,
    });
    expect(off.body).toMatchObject({
      github: {
        detected: expect.arrayContaining([expect.objectContaining({ name: 'Workers Builds: docs', on: false })]),
      },
    });
    const third = await taskWithPullRequest(owner, 35);
    const merge3 = newCommit();
    await deliver('pull_request', merged(mine, 35, merge3));
    expect((await deliver('check_run', passed(mine, 'Workers Builds: docs', merge3))).body).toMatchObject({
      moved: [],
      ignored: expect.stringMatching(/switched off in Settings/u),
    });
    expect((await taskOf(third.projectId, third.id)).delivery?.stage).toBe('merged');
    expect(
      await inWorkspace(owner, 'POST', '/api/access/github/checks', { name: 'Never seen', on: false }),
    ).toMatchObject({ status: 404, body: { field: 'name' } });
  });

  it('counts a successful deployment to production as a deploy, and one to preview as none', async () => {
    const owner = await connected();
    const mine = newInstallation();
    await deliver('installation', installation(mine, 'created', OWNER_GITHUB_ID));
    const { projectId, id } = await taskWithPullRequest(owner, 36);
    const merge = newCommit();
    await deliver('pull_request', merged(mine, 36, merge));
    const deployment = (environment: string, production: boolean) => ({
      installation: { id: mine },
      deployment_status: { state: 'success' },
      deployment: { environment, sha: merge, production_environment: production },
      repository,
    });
    expect((await deliver('deployment_status', deployment('Preview', false))).body).toMatchObject({ moved: [] });
    expect((await deliver('deployment_status', deployment('web', true))).body).toEqual({
      moved: [{ id, stage: 'live' }],
    });
    expect((await taskOf(projectId, id)).delivery?.stage).toBe('live');
  });

  it('counts a production deployment to an unnamed environment, and lists no name for it', async () => {
    const owner = await connected();
    const mine = newInstallation();
    await deliver('installation', installation(mine, 'created', OWNER_GITHUB_ID));
    const { projectId, id } = await taskWithPullRequest(owner, 37);
    const merge = newCommit();
    await deliver('pull_request', merged(mine, 37, merge));
    const unnamed = {
      installation: { id: mine },
      deployment_status: { state: 'success' },
      deployment: { sha: merge, production_environment: true },
      repository,
    };
    expect(await deliver('deployment_status', unnamed)).toEqual({
      status: 200,
      body: { moved: [{ id, stage: 'live' }] },
    });
    expect((await taskOf(projectId, id)).delivery?.stage).toBe('live');
    const { body } = await inWorkspace(owner, 'GET', '/api/access/github');
    expect((body.github as { detected: { name: string }[] }).detected.map((check) => check.name)).not.toContain('');
  });

  it('refuses the app’s deliveries once the owner disconnects it', async () => {
    const owner = await connected();
    expect(await deliver('ping', { zen: 'Speak like a human.', hook_id: 1 })).toMatchObject({ status: 200 });
    expect(await inWorkspace(owner, 'POST', '/api/access/github/app/remove', {})).toEqual({
      status: 200,
      body: { removed: true },
    });
    expect(await deliver('ping', { zen: 'Speak like a human.', hook_id: 1 })).toMatchObject({
      status: 401,
      body: { error: 'bad_signature' },
    });
  });
});

describe('work waiting for a merge GitHub already made', () => {
  it('records merged shortly after a close names a pull request that already merged', async () => {
    const owner = await connected();
    const mine = newInstallation();
    await deliver('installation', installation(mine, 'created', OWNER_GITHUB_ID, 'example'));
    // The installation's own check: nothing of this test waits yet.
    await runDurableObjectAlarm(store());
    const merge = newCommit();
    const mergedAt = new Date(Date.now() - 300_000).toISOString();
    github.pulls.set(`${REPOSITORY}#50`, { merged: true, mergeCommit: merge, base: 'main', mergedAt });

    const { projectId, id } = await taskWithPullRequest(owner, 50);
    expect((await taskOf(projectId, id)).delivery?.stage).toBe('built');
    expect(await runDurableObjectAlarm(store())).toBe(true);
    // Merged as GitHub merged it, five minutes before the check asked.
    expect((await taskOf(projectId, id)).delivery).toMatchObject({ stage: 'merged', mergeCommit: merge, mergedAt });
    expect(github.installationTokens).toContain(mine);
  });

  it('moves work closed before the app was installed once an owner installs it, and only work merged into main', async () => {
    const owner = await connected();
    const merged = await taskWithPullRequest(owner, 51);
    const open = await taskWithPullRequest(owner, 52);
    const elsewhere = await taskWithPullRequest(owner, 53);
    github.pulls.set(`${REPOSITORY}#51`, { merged: true, mergeCommit: newCommit(), base: 'main' });
    github.pulls.set(`${REPOSITORY}#52`, { merged: false, mergeCommit: null, base: 'main' });
    github.pulls.set(`${REPOSITORY}#53`, { merged: true, mergeCommit: newCommit(), base: 'release' });
    // The closes' check finds no installation to ask through.
    await runDurableObjectAlarm(store());
    expect((await taskOf(merged.projectId, merged.id)).delivery?.stage).toBe('built');

    await deliver('installation', installation(newInstallation(), 'created', OWNER_GITHUB_ID, 'example'));
    expect(await runDurableObjectAlarm(store())).toBe(true);
    expect((await taskOf(merged.projectId, merged.id)).delivery?.stage).toBe('merged');
    expect((await taskOf(open.projectId, open.id)).delivery?.stage).toBe('built');
    expect((await taskOf(elsewhere.projectId, elsewhere.id)).delivery?.stage).toBe('built');
  });

  it('asks only about repositories an installation of selected repositories reaches', async () => {
    const owner = await connected();
    const left = 'example/private';
    const selected = await taskWithPullRequest(owner, 60);
    const leftOut = await taskWithPullRequest(owner, 61, left);
    github.pulls.set(`${REPOSITORY}#60`, { merged: true, mergeCommit: newCommit(), base: 'main' });
    github.pulls.set(`${left}#61`, { merged: true, mergeCommit: newCommit(), base: 'main' });
    // The closes' check finds no installation to ask through.
    await runDurableObjectAlarm(store());

    const mine = newInstallation();
    github.repositories.set(mine, [REPOSITORY]);
    await deliver('installation', installation(mine, 'created', OWNER_GITHUB_ID, 'example'));
    expect(await runDurableObjectAlarm(store())).toBe(true);
    expect((await taskOf(selected.projectId, selected.id)).delivery?.stage).toBe('merged');
    expect((await taskOf(leftOut.projectId, leftOut.id)).delivery?.stage).toBe('built');
    expect(github.pullReads).toContain(`${REPOSITORY}#60`);
    expect(github.pullReads).not.toContain(`${left}#61`);
  });

  it('lists the selected repositories of an installation across pages', async () => {
    const owner = await connected();
    const outside = 'example/elsewhere';
    const listed = await taskWithPullRequest(owner, 70);
    const notListed = await taskWithPullRequest(owner, 71, outside);
    github.pulls.set(`${REPOSITORY}#70`, { merged: true, mergeCommit: newCommit(), base: 'main' });
    github.pulls.set(`${outside}#71`, { merged: true, mergeCommit: newCommit(), base: 'main' });
    await runDurableObjectAlarm(store());

    // 150 selected repositories, the task's on the second page of 100.
    const mine = newInstallation();
    github.repositories.set(mine, [...Array.from({ length: 149 }, (_, i) => `example/repo-${i}`), REPOSITORY]);
    await deliver('installation', installation(mine, 'created', OWNER_GITHUB_ID, 'example'));
    expect(await runDurableObjectAlarm(store())).toBe(true);
    expect((await taskOf(listed.projectId, listed.id)).delivery?.stage).toBe('merged');
    expect((await taskOf(notListed.projectId, notListed.id)).delivery?.stage).toBe('built');
    expect(github.pullReads).not.toContain(`${outside}#71`);
  });
});

describe('merged work a deploy shipped that no delivery named', () => {
  it('moves both merges to live when the host built only the second', async () => {
    const owner = await connected();
    const mine = newInstallation();
    await deliver('installation', installation(mine, 'created', OWNER_GITHUB_ID));
    const projectId = await createProject('Site');
    const first = await closedWithPullRequest(owner, projectId, 80);
    const second = await closedWithPullRequest(owner, projectId, 81);
    const a = newCommit();
    const b = newCommit();
    github.histories.set(b, [a]);
    await deliver('pull_request', merged(mine, 80, a));
    await deliver('pull_request', merged(mine, 81, b));

    // The deploy names only the commit it built.
    expect((await deliver('check_run', passed(mine, 'Workers Builds: site', b))).body).toEqual({
      moved: [{ id: second, stage: 'live' }],
    });
    expect((await taskOf(projectId, first)).delivery?.stage).toBe('merged');
    // The store's check finds the first merge in the deployed commit's history.
    expect(await runDurableObjectAlarm(store())).toBe(true);
    const shipped = (await taskOf(projectId, second)).delivery;
    expect((await taskOf(projectId, first)).delivery).toMatchObject({ stage: 'live', liveAt: shipped?.liveAt });
    expect(github.apiRequests).toContain(`GET /repos/${REPOSITORY}/compare/${b}...${a}`);
  });

  it('leaves at merged a merge that is not in the deployed commit’s history', async () => {
    const owner = await connected();
    const mine = newInstallation();
    await deliver('installation', installation(mine, 'created', OWNER_GITHUB_ID));
    const projectId = await createProject('Site');
    const elsewhere = await closedWithPullRequest(owner, projectId, 82);
    const deployed = await closedWithPullRequest(owner, projectId, 83);
    const c = newCommit();
    const b = newCommit();
    await deliver('pull_request', merged(mine, 82, c));
    await deliver('pull_request', merged(mine, 83, b));
    await deliver('check_run', passed(mine, 'Workers Builds: site', b));

    expect(await runDurableObjectAlarm(store())).toBe(true);
    expect((await taskOf(projectId, deployed)).delivery?.stage).toBe('live');
    expect((await taskOf(projectId, elsewhere)).delivery?.stage).toBe('merged');
    // Its own merge commit has no deploy check either.
    expect(github.apiRequests).toContain(`GET /repos/${REPOSITORY}/compare/${b}...${c}`);
    expect(github.checkReads).toContain(c);
  });

  it('moves a task to live when its deploy was reported before its merge', async () => {
    const owner = await connected();
    const mine = newInstallation();
    await deliver('installation', installation(mine, 'created', OWNER_GITHUB_ID));
    const projectId = await deployingProject(owner);
    const id = await closedWithPullRequest(owner, projectId, 84);
    const merge = newCommit();
    const startedAt = ago(90_000);
    const completedAt = ago(60_000);

    // No task names the deploy's commit until the merge event records it.
    expect((await deliver('check_run', passed(mine, 'Workers Builds: site', merge, 'main', startedAt))).body).toEqual({
      moved: [],
    });
    github.checkRuns.set(merge, [
      { name: 'Lint', conclusion: 'success', startedAt, completedAt },
      { name: 'Workers Builds: site', conclusion: 'success', startedAt, completedAt },
    ]);
    expect((await deliver('pull_request', mergedAt(mine, 84, merge, ago(120_000)))).body).toEqual({
      moved: [{ id, stage: 'merged' }],
    });
    expect(await runDurableObjectAlarm(store())).toBe(true);
    // Live when the deploy completed.
    expect((await taskOf(projectId, id)).delivery).toMatchObject({ stage: 'live', liveAt: completedAt });
  });

  it('leaves at merged a task whose only deploy check started before its merge', async () => {
    const owner = await connected();
    const mine = newInstallation();
    await deliver('installation', installation(mine, 'created', OWNER_GITHUB_ID));
    const projectId = await deployingProject(owner);
    const id = await closedWithPullRequest(owner, projectId, 85);
    const merge = newCommit();
    // A preview of the merge queue's branch, before the merge, and a check that is not a deploy, after it.
    github.checkRuns.set(merge, [
      {
        name: 'Workers Builds: site',
        conclusion: 'success',
        startedAt: ago(180_000),
        completedAt: ago(150_000),
        branch: `gh-readonly-queue/main/pr-85-${merge}`,
      },
      { name: 'Lint', conclusion: 'success', startedAt: ago(60_000), completedAt: ago(30_000) },
    ]);
    await deliver('pull_request', mergedAt(mine, 85, merge, ago(120_000)));

    expect(await runDurableObjectAlarm(store())).toBe(true);
    expect((await taskOf(projectId, id)).delivery?.stage).toBe('merged');
    expect(github.checkReads).toContain(merge);
  });

  it('counts a deploy check on the merge queue’s branch after the merge, and not one on another branch', async () => {
    const owner = await connected();
    const mine = newInstallation();
    await deliver('installation', installation(mine, 'created', OWNER_GITHUB_ID));
    const projectId = await deployingProject(owner);
    const queued = await closedWithPullRequest(owner, projectId, 86);
    const previewed = await closedWithPullRequest(owner, projectId, 87);
    const landed = newCommit();
    const branched = newCommit();
    const deploy = { name: 'Workers Builds: site', conclusion: 'success' as const };
    const completedAt = ago(30_000);
    github.checkRuns.set(landed, [
      { ...deploy, startedAt: ago(60_000), completedAt, branch: `gh-readonly-queue/main/pr-86-${landed}` },
    ]);
    // A preview build of a branch pushed at the merge commit, which a delivery of it would not count either.
    github.checkRuns.set(branched, [{ ...deploy, startedAt: ago(60_000), completedAt, branch: 'preview' }]);
    await deliver('pull_request', mergedAt(mine, 86, landed, ago(120_000)));
    await deliver('pull_request', mergedAt(mine, 87, branched, ago(110_000)));

    expect(await runDurableObjectAlarm(store())).toBe(true);
    expect((await taskOf(projectId, queued)).delivery).toMatchObject({ stage: 'live', liveAt: completedAt });
    expect((await taskOf(projectId, previewed)).delivery?.stage).toBe('merged');
    expect(github.checkReads).toEqual(expect.arrayContaining([landed, branched]));
  });

  it('keeps requests for a merged task’s deploy when open pull requests could take them all', async () => {
    const owner = await connected();
    const mine = newInstallation();
    await deliver('installation', installation(mine, 'created', OWNER_GITHUB_ID));
    const projectId = await deployingProject(owner);
    // More tasks waiting on open pull requests than one check reads.
    for (let number = 150; number < 195; number += 1) await closedWithPullRequest(owner, projectId, number);
    const id = await closedWithPullRequest(owner, projectId, 200);
    const merge = newCommit();
    const completedAt = ago(30_000);
    github.checkRuns.set(merge, [
      { name: 'Workers Builds: site', conclusion: 'success', startedAt: ago(60_000), completedAt },
    ]);
    await deliver('pull_request', mergedAt(mine, 200, merge, ago(120_000)));
    github.apiRequests.length = 0;

    expect(await runDurableObjectAlarm(store())).toBe(true);
    expect((await taskOf(projectId, id)).delivery).toMatchObject({ stage: 'live', liveAt: completedAt });
    expect(github.apiRequests.length).toBeLessThanOrEqual(45);
  });

  it('runs the check again when GitHub fails to answer for a merged task’s deploy', async () => {
    const owner = await connected();
    const mine = newInstallation();
    await deliver('installation', installation(mine, 'created', OWNER_GITHUB_ID));
    const projectId = await deployingProject(owner);
    const id = await closedWithPullRequest(owner, projectId, 88);
    const merge = newCommit();
    const completedAt = ago(30_000);
    github.checkRuns.set(merge, [
      { name: 'Workers Builds: site', conclusion: 'success', startedAt: ago(60_000), completedAt },
    ]);
    github.checkOutages.add(merge);
    await deliver('pull_request', mergedAt(mine, 88, merge, ago(120_000)));

    // Thrown, so the platform runs the alarm again.
    await expect(runDurableObjectAlarm(store())).rejects.toThrow(/runs again/u);
    expect((await taskOf(projectId, id)).delivery?.stage).toBe('merged');
    github.checkOutages.clear();
    await runInDurableObject(store(), (instance: TaskStore) => instance.alarm());
    expect((await taskOf(projectId, id)).delivery).toMatchObject({ stage: 'live', liveAt: completedAt });
  });

  it('asks GitHub at most 45 times in one check', async () => {
    const owner = await connected();
    const mine = newInstallation();
    await deliver('installation', installation(mine, 'created', OWNER_GITHUB_ID));
    const projectId = await deployingProject(owner);
    // Each merge takes two requests: whether the later live merge has it, then its own check runs.
    const waiting: string[] = [];
    for (let number = 100; number < 124; number += 1) {
      waiting.push(await closedWithPullRequest(owner, projectId, number));
      await deliver('pull_request', merged(mine, number, newCommit()));
    }
    await closedWithPullRequest(owner, projectId, 124);
    const last = newCommit();
    await deliver('pull_request', merged(mine, 124, last));
    await deliver('check_run', passed(mine, 'Workers Builds: site', last));
    github.apiRequests.length = 0;

    expect(await runDurableObjectAlarm(store())).toBe(true);
    expect(github.apiRequests.length).toBe(45);
    for (const id of waiting) expect((await taskOf(projectId, id)).delivery?.stage).toBe('merged');
  });
});
