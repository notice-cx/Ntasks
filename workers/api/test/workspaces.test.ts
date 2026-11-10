// Several workspaces in one Worker: each keeps its projects and tasks in its
// own task store, and a person, an agent and a service each reach only the
// workspaces sign-in gives them, through the HTTP routes, the MCP endpoint,
// a backup and a load.
import { collectBackup, sendLoad, type BackupFile } from '@ntasks/domain';
import { describe, expect, it } from 'vitest';
import { projectChoice } from '../src/access/pages.ts';
import { WORKSPACE_HEADER } from '../src/workspaces.ts';
import { addMember, Browser, call, connectAgent, userIdOf } from './access/client.ts';
import { standInForGitHub } from './access/github.ts';
import { store } from './store.ts';

standInForGitHub();

interface Named {
  readonly id: string;
  readonly name: string;
}

/**
 * The people and workspaces every test here reads. Ana owns One, Ben owns
 * Two, and Cai owns Three and is a member of One. One and Two each hold a
 * project with the prefix alpha and a task in it.
 */
interface World {
  readonly ana: Browser;
  readonly ben: Browser;
  readonly cai: Browser;
  readonly one: Named;
  readonly two: Named;
  readonly three: Named;
  /** The project of One, and of Two. */
  readonly projectOne: string;
  readonly projectTwo: string;
  readonly taskOne: string;
  readonly taskTwo: string;
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** A person's request from their browser, naming a workspace when given one. */
async function as(
  browser: Browser,
  method: string,
  path: string,
  options: { readonly workspace?: string; readonly json?: unknown; readonly key?: string } = {},
): Promise<Answer> {
  const response = await browser.fetch(path, {
    method,
    ...(options.json === undefined ? {} : { json: options.json }),
    headers: {
      ...(options.workspace === undefined ? {} : { [WORKSPACE_HEADER]: options.workspace }),
      ...(options.key === undefined ? {} : { 'idempotency-key': options.key }),
    },
  });
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

/** A request with a bearer token, naming a workspace when given one. */
async function withToken(
  token: string,
  method: string,
  path: string,
  options: { readonly workspace?: string; readonly json?: unknown } = {},
): Promise<Answer> {
  const response = await call(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.json === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.workspace === undefined ? {} : { [WORKSPACE_HEADER]: options.workspace }),
    },
    ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
  });
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

/** One MCP tool call with a bearer token: its value, or the sentence it refused
 * with, without the last line that says whether a retry is safe. */
async function tool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ value?: Record<string, unknown>; refused?: string }> {
  const { body } = await withToken(token, 'POST', '/api/mcp', {
    json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  const result = body.result as { isError?: boolean; content: { text: string }[] } | undefined;
  if (!result) throw new Error(`${name} failed: ${JSON.stringify(body)}`);
  const text = result.content[0]!.text;
  return result.isError
    ? { refused: text.slice(0, text.lastIndexOf('\n')) }
    : { value: JSON.parse(text) as Record<string, unknown> };
}

/** The ids of the projects a sender lists. */
function projectIds(answer: Answer): string[] {
  return (answer.body.projects as { projectId: string }[]).map((project) => project.projectId);
}

/** A person signed in with GitHub, a member of no workspace yet. */
async function person(githubId: number): Promise<Browser> {
  const browser = new Browser({ joinTestWorkspace: false });
  await browser.signInWithGitHub(githubId);
  return browser;
}

async function createWorkspace(browser: Browser, name: string): Promise<Named> {
  const created = await as(browser, 'POST', '/api/workspaces', { json: { name } });
  expect(created.status).toBe(201);
  const { workspaceId } = created.body.workspace as { workspaceId: string };
  return { id: workspaceId, name };
}

async function createProject(browser: Browser, workspace: string, name: string, prefix: string): Promise<string> {
  const created = await as(browser, 'POST', '/api/tasks/projects', { workspace, json: { name, prefix } });
  expect(created.status).toBe(201);
  return (created.body.project as { projectId: string }).projectId;
}

async function createTask(browser: Browser, workspace: string, projectId: string, title: string): Promise<string> {
  const created = await as(browser, 'POST', '/api/tasks', { workspace, json: { projectId, title } });
  expect(created.status).toBe(200);
  return created.body.id as string;
}

/** A service credential made by a workspace's owner; returns its token. */
async function service(browser: Browser, workspace: string, body: Record<string, unknown>): Promise<string> {
  const created = await as(browser, 'POST', '/api/access/services', { workspace, json: body });
  expect(created.status).toBe(201);
  return (created.body.service as { token: string }).token;
}

async function build(): Promise<World> {
  const ana = await person(1002);
  const ben = await person(1003);
  const cai = await person(1004);
  const one = await createWorkspace(ana, 'One');
  const two = await createWorkspace(ben, 'Two');
  const three = await createWorkspace(cai, 'Three');
  await addMember(one, (await userIdOf(1004))!, 'member');
  // The same prefix in both: each workspace's store keeps its own projects.
  const projectOne = await createProject(ana, one.id, 'Alpha', 'alpha');
  const projectTwo = await createProject(ben, two.id, 'Alpha', 'alpha');
  const taskOne = await createTask(ana, one.id, projectOne, 'A task of One');
  const taskTwo = await createTask(ben, two.id, projectTwo, 'A task of Two');
  return { ana, ben, cai, one, two, three, projectOne, projectTwo, taskOne, taskTwo };
}

// Tests in a file share their storage, so the world is built once, by the
// first test that asks for it, while that test's GitHub stand-in answers.
let built: Promise<World> | undefined;
function world(): Promise<World> {
  built ??= build();
  return built;
}

describe('a person', () => {
  it('is listed only the workspaces they belong to, with their role in each', async () => {
    const { ana, ben, cai, one, two, three } = await world();
    expect((await as(ana, 'GET', '/api/workspaces')).body).toEqual({
      workspaces: [{ workspaceId: one.id, name: 'One', role: 'owner' }],
    });
    expect((await as(ben, 'GET', '/api/workspaces')).body).toEqual({
      workspaces: [{ workspaceId: two.id, name: 'Two', role: 'owner' }],
    });
    expect((await as(cai, 'GET', '/api/workspaces')).body).toEqual({
      workspaces: [
        { workspaceId: one.id, name: 'One', role: 'member' },
        { workspaceId: three.id, name: 'Three', role: 'owner' },
      ],
    });
  });

  it('is listed their workspaces and who they are whatever workspace header they send', async () => {
    const { cai, two } = await world();
    // A workspace a client kept from before, which this person no longer reaches.
    const stale = { workspace: two.id };
    expect(await as(cai, 'GET', '/api/workspaces', stale)).toEqual(await as(cai, 'GET', '/api/workspaces'));
    expect(await as(cai, 'GET', '/api/access/me', stale)).toEqual({
      status: 200,
      body: { kind: 'person', name: 'Person 1004', deploymentAdmin: true, projects: 'all', timeZone: null },
    });
  });

  it("reaches their own workspace's projects and tasks, and no other's", async () => {
    const { ana, ben, one, two, projectOne, projectTwo, taskOne, taskTwo } = await world();
    // Each reaches one workspace, so each may leave the header out.
    expect(projectIds(await as(ana, 'GET', '/api/tasks/projects'))).toEqual([projectOne]);
    expect(projectIds(await as(ben, 'GET', '/api/tasks/projects'))).toEqual([projectTwo]);
    const board = await as(ana, 'GET', `/api/tasks?project=${projectOne}`);
    expect((board.body.tasks as { id: string }[]).map((task) => task.id)).toEqual([taskOne]);
    // Two's project is not in One's store.
    expect((await as(ana, 'GET', `/api/tasks/${taskTwo}?project=${projectTwo}`)).status).toBe(404);
    expect((await as(ana, 'GET', `/api/tasks/${taskOne}?project=${projectOne}`, { workspace: one.id })).status).toBe(
      200,
    );

    // A workspace they do not belong to answers as one that does not exist.
    const elsewhere = await as(ana, 'GET', '/api/tasks/projects', { workspace: two.id });
    const nowhere = await as(ana, 'GET', '/api/tasks/projects', { workspace: crypto.randomUUID() });
    expect(elsewhere).toEqual({
      status: 404,
      body: { error: 'not_found', detail: 'no such workspace; GET /api/workspaces lists yours' },
    });
    expect(nowhere).toEqual(elsewhere);
  });

  it('who reaches several workspaces names one, or is refused with workspace_required', async () => {
    const { cai, one, two, three, projectOne } = await world();
    const unnamed = await as(cai, 'GET', '/api/tasks/projects');
    expect(unnamed).toEqual({
      status: 400,
      body: {
        error: 'workspace_required',
        detail: `you reach several workspaces; name one in the ${WORKSPACE_HEADER} header. GET /api/workspaces lists them`,
      },
    });
    expect(projectIds(await as(cai, 'GET', '/api/tasks/projects', { workspace: one.id }))).toEqual([projectOne]);
    expect((await as(cai, 'GET', '/api/tasks/projects', { workspace: three.id })).status).toBe(200);
    expect((await as(cai, 'GET', '/api/tasks/projects', { workspace: two.id })).status).toBe(404);
  });
});

describe('creating a project', () => {
  it("is an owner's act: a member is refused, and nothing is made", async () => {
    const { cai, one, three } = await world();
    const before = projectIds(await as(cai, 'GET', '/api/tasks/projects', { workspace: one.id }));
    const refused = await as(cai, 'POST', '/api/tasks/projects', {
      workspace: one.id,
      json: { name: 'Beta', prefix: 'beta' },
    });
    expect(refused).toEqual({
      status: 403,
      body: { error: 'insufficient_scope', detail: 'only an owner of this workspace may do this' },
    });
    expect(projectIds(await as(cai, 'GET', '/api/tasks/projects', { workspace: one.id }))).toEqual(before);

    const created = await as(cai, 'POST', '/api/tasks/projects', {
      workspace: three.id,
      json: { name: 'Gamma', prefix: 'gamma' },
    });
    expect(created.status).toBe(201);
    const project = created.body.project as { projectId: string };
    expect(created.body).toEqual({
      project: { projectId: project.projectId, logicalKey: 'gamma', displayName: 'Gamma', prefix: 'gamma' },
    });
    expect(projectIds(await as(cai, 'GET', '/api/tasks/projects', { workspace: three.id }))).toContain(
      project.projectId,
    );
  });

  it('names the field a refusal is about', async () => {
    const { ana } = await world();
    const post = (json: unknown) => as(ana, 'POST', '/api/tasks/projects', { json });
    expect(await post({ name: 'Again', prefix: 'alpha' })).toEqual({
      status: 409,
      body: { error: 'project_exists', detail: 'another project in this workspace uses this prefix', field: 'prefix' },
    });
    expect(await post({ name: 'Bad prefix', prefix: 'Not-OK' })).toMatchObject({
      status: 400,
      body: { error: 'invalid_request', field: 'prefix' },
    });
    expect(await post({ name: ' ', prefix: 'blank' })).toMatchObject({
      status: 400,
      body: { error: 'invalid_request', field: 'name' },
    });
  });

  it('answers a retry sent with its idempotency key with the project it made', async () => {
    const { cai, three } = await world();
    const post = (json: unknown, key?: string) =>
      as(cai, 'POST', '/api/tasks/projects', { workspace: three.id, json, ...(key === undefined ? {} : { key }) });
    const json = { name: 'Retried', prefix: 'retried' };
    const first = await post(json, 'project-key-1');
    expect(first.status).toBe(201);
    expect(await post(json, 'project-key-1')).toEqual({ status: 201, body: { ...first.body, replayed: true } });
    // Without a key, or with another name, the prefix is taken.
    expect((await post(json)).status).toBe(409);
    expect(await post({ ...json, name: 'Other' }, 'project-key-2')).toMatchObject({
      status: 409,
      body: { field: 'prefix' },
    });
  });
});

describe('creating a workspace', () => {
  it('is refused to anyone but a deployment admin, and refuses a bad name or a taken id', async () => {
    const { ana, one, projectOne } = await world();
    const token = await service(ana, one.id, {
      name: 'not-an-admin',
      grants: [{ projectId: projectOne, access: 'read' }],
    });
    expect(await withToken(token, 'POST', '/api/workspaces', { json: { name: 'Mine' } })).toEqual({
      status: 403,
      body: { error: 'admin_only', detail: 'only a deployment admin may create a workspace' },
    });
    expect(await as(ana, 'POST', '/api/workspaces', { json: { name: '' } })).toMatchObject({
      status: 400,
      body: { field: 'name' },
    });
    expect(await as(ana, 'POST', '/api/workspaces', { json: { name: 'Taken', workspaceId: one.id } })).toMatchObject({
      status: 409,
      body: { error: 'workspace_exists', field: 'workspaceId' },
    });
    expect(await as(ana, 'POST', '/api/workspaces', { json: { name: 'Odd', workspaceId: 'one' } })).toMatchObject({
      status: 400,
      body: { field: 'workspaceId' },
    });
    // Nothing above made a workspace.
    expect((await as(ana, 'GET', '/api/workspaces')).body.workspaces).toHaveLength(1);
  });
});

describe('renaming a workspace', () => {
  // These routes count against sign-in's limit for each address, so each test
  // signs its people in again from browsers of their own, and the world's
  // browsers keep their budget for the tests after these.
  const [ANA, BEN, CAI] = [1002, 1003, 1004];

  /** A rename sent from a person's browser. */
  const rename = (browser: Browser, json: Record<string, unknown>) => as(browser, 'PATCH', '/api/workspaces', { json });

  it('shows the new name in the workspace list and to agents, and keeps the store it names', async () => {
    const { one, three } = await world();
    const cai = await person(CAI);
    const reader = await service(cai, three.id, { name: 'rename-reader', backup: true });
    expect(await rename(cai, { workspaceId: three.id, name: '  Three, renamed  ' })).toEqual({
      status: 200,
      body: { workspace: { workspaceId: three.id, name: 'Three, renamed', role: 'owner' } },
    });
    expect((await as(cai, 'GET', '/api/workspaces')).body).toEqual({
      workspaces: [
        { workspaceId: one.id, name: 'One', role: 'member' },
        { workspaceId: three.id, name: 'Three, renamed', role: 'owner' },
      ],
    });
    expect((await tool(reader, 'list_workspaces')).value?.workspaces).toEqual([
      expect.objectContaining({ workspaceId: three.id, name: 'Three, renamed' }),
    ]);
    expect((await as(cai, 'GET', '/api/tasks/projects', { workspace: three.id })).status).toBe(200);
  });

  it("is an owner's act: a member, an agent and a service are refused, and nothing changes", async () => {
    const { one, projectOne } = await world();
    const [ana, cai] = [await person(ANA), await person(CAI)];
    const before = await as(cai, 'GET', '/api/workspaces');
    const refused = {
      status: 403,
      body: { error: 'insufficient_scope', detail: 'only an owner of this workspace may do this' },
    };
    expect(await rename(cai, { workspaceId: one.id, name: 'Taken over' })).toEqual(refused);
    const { tokens } = await connectAgent(ana, [projectChoice(one.id, projectOne)]);
    const writer = await service(ana, one.id, {
      name: 'not-an-owner',
      grants: [{ projectId: projectOne, access: 'write' }],
    });
    for (const token of [tokens.access_token, writer]) {
      expect(
        await withToken(token, 'PATCH', '/api/workspaces', { json: { workspaceId: one.id, name: 'Taken over' } }),
      ).toEqual(refused);
    }
    expect(await as(cai, 'GET', '/api/workspaces')).toEqual(before);
    expect((await as(ana, 'GET', '/api/workspaces')).body.workspaces).toEqual([
      { workspaceId: one.id, name: 'One', role: 'owner' },
    ]);
  });

  it('refuses each name that creating a workspace refuses, with the same answer, and changes nothing', async () => {
    const { one } = await world();
    const ana = await person(ANA);
    for (const name of ['', '   ', 'Two\nlines', 'x'.repeat(129), 42, undefined]) {
      const renamed = await rename(ana, { workspaceId: one.id, name });
      expect(renamed).toMatchObject({ status: 400, body: { error: 'invalid_request', field: 'name' } });
      expect(renamed).toEqual(await as(ana, 'POST', '/api/workspaces', { json: { name } }));
    }
    expect((await as(ana, 'GET', '/api/workspaces')).body.workspaces).toEqual([
      { workspaceId: one.id, name: 'One', role: 'owner' },
    ]);
  });

  it('answers a workspace the sender does not reach as one that does not exist', async () => {
    const { two } = await world();
    const [ana, ben] = [await person(ANA), await person(BEN)];
    const elsewhere = await rename(ana, { workspaceId: two.id, name: 'Mine now' });
    expect(elsewhere).toEqual({
      status: 404,
      body: { error: 'not_found', detail: 'no such workspace; GET /api/workspaces lists yours' },
    });
    expect(await rename(ana, { workspaceId: crypto.randomUUID(), name: 'Mine now' })).toEqual(elsewhere);
    expect((await as(ben, 'GET', '/api/workspaces')).body).toEqual({
      workspaces: [{ workspaceId: two.id, name: 'Two', role: 'owner' }],
    });
  });
});

describe('an agent', () => {
  it('reaches only the workspaces of the projects it was granted, over MCP and HTTP', async () => {
    const { cai, one, two, three, projectOne, projectTwo, taskTwo } = await world();
    const { tokens } = await connectAgent(cai, [projectChoice(one.id, projectOne)]);
    const token = tokens.access_token;

    expect((await tool(token, 'list_workspaces')).value?.workspaces).toEqual([
      { workspaceId: one.id, name: 'One', role: 'operator', status: 'active', access: ['tasks:read', 'tasks:write'] },
    ]);
    const listed = await tool(token, 'list_projects', { workspace: one.id });
    expect((listed.value?.projects as { projectId: string }[]).map((project) => project.projectId)).toEqual([
      projectOne,
    ]);
    // It reaches One alone, so a call that names no workspace acts there.
    expect(await tool(token, 'list_projects')).toEqual(listed);
    // Three is its person's, but the agent was granted nothing there; Two is not its person's.
    for (const workspace of [three.id, two.id]) {
      expect(await tool(token, 'list_projects', { workspace })).toEqual({
        refused: `refused: workspace ${workspace} is not one of yours; list_workspaces lists yours.`,
      });
    }
    expect(await tool(token, 'get_task', { workspace: one.id, project: projectTwo, task: taskTwo })).toEqual({
      refused: `refused: project ${projectTwo} names no project in this workspace; list_projects lists each one's projectId, key and prefix.`,
    });

    expect(projectIds(await withToken(token, 'GET', '/api/tasks/projects'))).toEqual([projectOne]);
    expect((await withToken(token, 'GET', '/api/tasks/projects', { workspace: three.id })).status).toBe(404);
    expect((await withToken(token, 'GET', '/api/workspaces')).body).toEqual({
      workspaces: [{ workspaceId: one.id, name: 'One', role: null }],
    });
  });
});

describe('a service', () => {
  it("reaches only its credential's workspace, and files into that workspace's store", async () => {
    const { ana, ben, one, two, projectOne, projectTwo } = await world();
    // The same name in two workspaces: each keeps its own credentials.
    const first = await service(ana, one.id, {
      name: 'noticeos',
      grants: [{ projectId: projectOne, access: 'write' }],
    });
    const second = await service(ben, two.id, {
      name: 'noticeos',
      grants: [{ projectId: projectTwo, access: 'write' }],
    });

    expect(projectIds(await withToken(first, 'GET', '/api/tasks/projects'))).toEqual([projectOne]);
    expect(projectIds(await withToken(first, 'GET', '/api/tasks/projects', { workspace: one.id }))).toEqual([
      projectOne,
    ]);
    expect((await withToken(first, 'GET', '/api/tasks/projects', { workspace: two.id })).status).toBe(404);
    expect((await tool(first, 'list_workspaces')).value?.workspaces).toEqual([
      { workspaceId: one.id, name: 'One', role: 'operator', status: 'active', access: ['tasks:read', 'tasks:write'] },
    ]);

    // One idempotency key in both workspaces files two tasks, each in its own store.
    const key = 'same-key-in-both';
    const filedOne = await tool(first, 'create_task', {
      workspace: one.id,
      project: projectOne,
      title: 'Filed in One',
      idempotency_key: key,
    });
    const filedTwo = await tool(second, 'create_task', {
      workspace: two.id,
      project: projectTwo,
      title: 'Filed in Two',
      idempotency_key: key,
    });
    expect(filedOne.value?.replayed).toBe(false);
    expect(filedTwo.value?.replayed).toBe(false);
    expect(
      await tool(first, 'create_task', {
        workspace: two.id,
        project: projectTwo,
        title: 'Elsewhere',
        idempotency_key: key,
      }),
    ).toEqual({ refused: `refused: workspace ${two.id} is not one of yours; list_workspaces lists yours.` });

    const titles = async (token: string, workspace: string, project: string) =>
      ((await tool(token, 'list_tasks', { workspace, project })).value?.tasks as { title: string }[]).map(
        (task) => task.title,
      );
    expect((await titles(first, one.id, projectOne)).sort()).toEqual(['A task of One', 'Filed in One']);
    expect((await titles(second, two.id, projectTwo)).sort()).toEqual(['A task of Two', 'Filed in Two']);
    expect((await store(one.id).projects()).map((project) => project.id)).toEqual([projectOne]);
    expect((await store(two.id).projects()).map((project) => project.id)).toEqual([projectTwo]);

    // It creates no project and no workspace, and an owner manages only their own workspace's credentials.
    expect(
      (await withToken(first, 'POST', '/api/tasks/projects', { json: { name: 'Delta', prefix: 'delta' } })).status,
    ).toBe(403);
    const anaServices = (await as(ana, 'GET', '/api/access/services')).body.services as { id: string; name: string }[];
    const benServices = (await as(ben, 'GET', '/api/access/services')).body.services as { id: string; name: string }[];
    expect(anaServices.some((listed) => benServices.some((other) => other.id === listed.id))).toBe(false);
    const benNoticeos = benServices.find((listed) => listed.name === 'noticeos')!;
    expect((await as(ana, 'POST', `/api/access/services/${benNoticeos.id}/revoke`)).status).toBe(404);
    expect((await withToken(second, 'GET', '/api/tasks/projects')).status).toBe(200);
  });
});

/** Every page of a backup read through the Worker with a bearer token. */
async function backupWith(token: string): Promise<BackupFile> {
  const { file } = await collectBackup(async (page) => {
    const answer = await withToken(token, 'GET', page === null ? '/api/backup' : `/api/backup?page=${page}`);
    if (answer.status !== 200) throw new Error(JSON.stringify(answer));
    return answer.body;
  });
  return file;
}

describe('a backup', () => {
  it("holds its workspace's rows and none of another's", async () => {
    const { ana, cai, one, projectOne, projectTwo, taskOne, taskTwo } = await world();
    const token = await service(ana, one.id, { name: 'backup-one', backup: true });
    const file = await backupWith(token);
    expect(file.tables.projects.map((row) => row.id)).toEqual([projectOne]);
    expect(file.tables.tasks.map((row) => row.id)).toContain(taskOne);
    const text = JSON.stringify(file);
    for (const other of [projectTwo, taskTwo, 'Filed in Two', 'A task of Two']) expect(text).not.toContain(other);

    // An owner backs up their workspace; a member may not.
    expect((await as(ana, 'GET', '/api/backup')).status).toBe(200);
    expect(await as(cai, 'GET', '/api/backup', { workspace: one.id })).toEqual({
      status: 403,
      body: { error: 'insufficient_scope', detail: 'this route needs tasks:backup' },
    });
  });
});

describe('a load', () => {
  it("lands only in the sender's workspace, which a deployment admin made with a chosen id", async () => {
    const { ana, one, two, projectOne, projectTwo } = await world();
    const four = { id: crypto.randomUUID(), name: 'Four' };
    expect(await as(ana, 'POST', '/api/workspaces', { json: { name: four.name, workspaceId: four.id } })).toEqual({
      status: 201,
      body: { workspace: { workspaceId: four.id, name: 'Four', role: 'owner' } },
    });
    // Ana now reaches One and Four, so she names the one she manages.
    expect((await as(ana, 'GET', '/api/access/services')).status).toBe(400);
    const restore = await service(ana, four.id, { name: 'load-four', restore: true });
    const backup = await backupWith(await service(ana, one.id, { name: 'backup-for-four', backup: true }));

    const post = async (path: string, body: unknown) => withToken(restore, 'POST', path, { json: body });
    const loaded = await sendLoad(backup.tables, backup.migrations, post);
    expect(loaded.rows).toBeGreaterThan(0);

    expect((await store(four.id).projects()).map((project) => project.id)).toEqual([projectOne]);
    expect((await store(two.id).projects()).map((project) => project.id)).toEqual([projectTwo]);
    expect((await store(one.id).projects()).map((project) => project.id)).toEqual([projectOne]);
    // The restore credential reaches Four alone.
    expect(
      (await withToken(restore, 'POST', '/api/restore', { workspace: two.id, json: { migrations: [] } })).status,
    ).toBe(404);
  });
});
