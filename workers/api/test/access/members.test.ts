// A workspace's members and invitations: an owner invites a GitHub login,
// the account that holds it signs in and becomes a member, and an owner
// removes members. GitHub accounts 1001 to 1004 are deployment admins
// (vitest.config.ts); the people they invite are 2101 and up.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { projectChoice } from '../../src/access/pages.ts';
import { WORKSPACE_HEADER } from '../../src/workspaces.ts';
import { Browser, call, connectAgent, meWithToken, userIdOf } from './client.ts';
import { standInForGitHub } from './github.ts';

standInForGitHub();

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** A person's request from their browser in a workspace, as the web app sends it. */
async function as(
  browser: Browser,
  method: string,
  path: string,
  options: { readonly workspace?: string; readonly json?: unknown } = {},
): Promise<Answer> {
  const response = await browser.fetch(path, {
    method,
    ...(options.json === undefined ? {} : { json: options.json }),
    headers: options.workspace === undefined ? {} : { [WORKSPACE_HEADER]: options.workspace },
  });
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

/** GET with an agent's bearer token in a workspace. */
async function withToken(token: string, path: string, workspace: string): Promise<Answer> {
  const response = await call(path, { headers: { authorization: `Bearer ${token}`, [WORKSPACE_HEADER]: workspace } });
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

/** A GitHub account signed in from a fresh browser, and where sign-in sent it. */
async function signIn(githubId: number, login?: string): Promise<{ browser: Browser; landed: URL }> {
  const browser = new Browser({ joinTestWorkspace: false });
  const landed = await browser.signInWithGitHub(githubId, undefined, login);
  return { browser, landed };
}

/** A deployment admin signed in, and a new workspace they own. */
async function adminWithWorkspace(githubId: number, name: string): Promise<{ owner: Browser; workspace: string }> {
  const { browser: owner } = await signIn(githubId);
  return { owner, workspace: await createWorkspace(owner, name) };
}

async function createWorkspace(owner: Browser, name: string): Promise<string> {
  const created = await as(owner, 'POST', '/api/workspaces', { json: { name } });
  expect(created.status).toBe(201);
  return (created.body.workspace as { workspaceId: string }).workspaceId;
}

function invite(owner: Browser, workspace: string, githubLogin: string, role = 'member'): Promise<Answer> {
  return as(owner, 'POST', '/api/access/invitations', { workspace, json: { githubLogin, role } });
}

/** Invites a login, which must succeed, and returns the invitation's id. */
async function invited(owner: Browser, workspace: string, githubLogin: string, role = 'member'): Promise<string> {
  const answer = await invite(owner, workspace, githubLogin, role);
  expect(answer.status).toBe(201);
  return (answer.body.invitation as { invitationId: string }).invitationId;
}

/** Signs in a GitHub account that must be admitted, and returns its browser. */
async function admitted(githubId: number, login?: string): Promise<Browser> {
  const { browser, landed } = await signIn(githubId, login);
  expect(landed.pathname).toBe('/');
  return browser;
}

function members(owner: Browser, workspace: string): Promise<Answer> {
  return as(owner, 'GET', '/api/access/members', { workspace });
}

function remove(owner: Browser, workspace: string, userId: string): Promise<Answer> {
  return as(owner, 'POST', `/api/access/members/${userId}/remove`, { workspace, json: {} });
}

async function idOf(githubId: number): Promise<string> {
  const userId = await userIdOf(githubId);
  if (userId === null) throw new Error(`GitHub account ${githubId} has not signed in`);
  return userId;
}

/** The workspaces a person's session reaches, with their role in each. */
async function workspacesOf(browser: Browser): Promise<unknown> {
  return (await as(browser, 'GET', '/api/workspaces')).body.workspaces;
}

describe('an invitation', () => {
  it('lets the account holding the login sign in, matched without case, and makes it a member', async () => {
    const { owner, workspace } = await adminWithWorkspace(1001, 'Invited');
    const answer = await invite(owner, workspace, ' @Person-2101 ');
    expect(answer.status).toBe(201);
    const invitation = answer.body.invitation as { invitationId: string; createdAt: string };
    expect(invitation).toEqual({
      invitationId: invitation.invitationId,
      githubLogin: 'Person-2101',
      role: 'member',
      createdAt: invitation.createdAt,
    });
    const ownerId = await idOf(1001);
    expect((await members(owner, workspace)).body).toEqual({
      members: [{ userId: ownerId, name: 'Person 1001', githubLogin: null, role: 'owner' }],
      invitations: [invitation],
    });

    const person = await admitted(2101);
    const personId = await idOf(2101);
    expect(await workspacesOf(person)).toEqual([{ workspaceId: workspace, name: 'Invited', role: 'member' }]);
    expect((await as(person, 'GET', '/api/tasks/projects')).status).toBe(200);
    expect((await as(person, 'GET', '/api/access/me')).body).toMatchObject({ kind: 'person', deploymentAdmin: false });
    expect((await members(owner, workspace)).body).toEqual({
      members: [
        { userId: ownerId, name: 'Person 1001', githubLogin: null, role: 'owner' },
        { userId: personId, name: 'Person 2101', githubLogin: 'Person-2101', role: 'member' },
      ],
      invitations: [],
    });
    const row = await env.DB.prepare('SELECT accepted_by, accepted_at FROM workspace_invitations WHERE id = ?')
      .bind(invitation.invitationId)
      .first<{ accepted_by: string; accepted_at: string | null }>();
    expect(row?.accepted_by).toBe(personId);
    expect(row?.accepted_at).not.toBeNull();
  });

  it('binds the membership to the account, so a rename keeps it and the old login admits no one', async () => {
    const { owner, workspace } = await adminWithWorkspace(1002, 'Renamed');
    await invited(owner, workspace, 'person-2102');
    await admitted(2102);

    const renamed = await admitted(2102, 'renamed-2102');
    expect(await workspacesOf(renamed)).toEqual([{ workspaceId: workspace, name: 'Renamed', role: 'member' }]);
    const taker = await signIn(2103, 'person-2102');
    expect(taker.landed.searchParams.get('error')).toBe('not_invited');
  });

  it('names the field a refusal is about, and refuses a second open invitation for a login', async () => {
    const { owner, workspace } = await adminWithWorkspace(1003, 'Refusals');
    for (const githubLogin of ['', 'two words', '-leading-hyphen', 'x'.repeat(40)]) {
      expect(await invite(owner, workspace, githubLogin)).toMatchObject({
        status: 400,
        body: { error: 'invalid_request', field: 'githubLogin' },
      });
    }
    expect(await invite(owner, workspace, 'person-2104', 'admin')).toEqual({
      status: 400,
      body: { error: 'invalid_request', detail: 'role is owner or member', field: 'role' },
    });
    expect(
      await as(owner, 'POST', '/api/access/invitations', {
        workspace,
        json: { githubLogin: 'person-2104', email: 'person@example.com' },
      }),
    ).toEqual({
      status: 400,
      body: { error: 'invalid_request', detail: 'unknown email; send githubLogin and role' },
    });

    await invited(owner, workspace, 'person-2104');
    expect(await invite(owner, workspace, 'PERSON-2104', 'owner')).toEqual({
      status: 409,
      body: {
        error: 'invitation_exists',
        detail: 'PERSON-2104 already has an open invitation to this workspace',
        field: 'githubLogin',
      },
    });
    expect((await members(owner, workspace)).body.invitations).toHaveLength(1);
  });
});

describe('a revoked invitation', () => {
  it('admits nobody', async () => {
    const { owner, workspace } = await adminWithWorkspace(1004, 'Revoked');
    const invitationId = await invited(owner, workspace, 'person-2105');
    const revoke = () => as(owner, 'POST', `/api/access/invitations/${invitationId}/revoke`, { workspace, json: {} });

    expect(await revoke()).toEqual({ status: 200, body: { revoked: true } });
    expect((await members(owner, workspace)).body.invitations).toEqual([]);
    const refused = await signIn(2105);
    expect(refused.landed.pathname).toBe('/sign-in');
    expect(refused.landed.searchParams.get('error')).toBe('not_invited');
    expect(await userIdOf(2105)).toBeNull();
    expect(await revoke()).toEqual({
      status: 404,
      body: { error: 'not_found', detail: 'no such open invitation in this workspace' },
    });
  });
});

describe('removing a member', () => {
  it('cuts their session and their agents off from that workspace, and leaves their other ones', async () => {
    const { owner, workspace: left } = await adminWithWorkspace(1001, 'Left');
    const kept = await createWorkspace(owner, 'Kept');
    const project = async (workspace: string, prefix: string) => {
      const created = await as(owner, 'POST', '/api/tasks/projects', { workspace, json: { name: prefix, prefix } });
      expect(created.status).toBe(201);
      return (created.body.project as { projectId: string }).projectId;
    };
    const leftProject = await project(left, 'left');
    const keptProject = await project(kept, 'kept');
    await invited(owner, left, 'person-2106');
    await invited(owner, kept, 'person-2106');
    const person = await admitted(2106);
    const personId = await idOf(2106);
    const { tokens } = await connectAgent(person, [projectChoice(left, leftProject), projectChoice(kept, keptProject)]);
    const agent = tokens.access_token;
    const projectsOf = (answer: Answer) => (answer.body.projects as { projectId: string }[]).map((p) => p.projectId);
    expect(projectsOf(await as(person, 'GET', '/api/tasks/projects', { workspace: left }))).toEqual([leftProject]);
    expect(projectsOf(await withToken(agent, '/api/tasks/projects', left))).toEqual([leftProject]);

    expect(await remove(owner, left, personId)).toEqual({ status: 200, body: { removed: true } });

    expect((await as(person, 'GET', '/api/tasks/projects', { workspace: left })).status).toBe(404);
    expect((await withToken(agent, '/api/tasks/projects', left)).status).toBe(404);
    expect(await workspacesOf(person)).toEqual([{ workspaceId: kept, name: 'Kept', role: 'member' }]);
    expect(projectsOf(await as(person, 'GET', '/api/tasks/projects', { workspace: kept }))).toEqual([keptProject]);
    expect(projectsOf(await withToken(agent, '/api/tasks/projects', kept))).toEqual([keptProject]);
    const grants = await env.DB.prepare(
      'SELECT workspace_id FROM access_agent_grants WHERE user_id = ? ORDER BY workspace_id',
    )
      .bind(personId)
      .all<{ workspace_id: string }>();
    expect(grants.results.map((row) => row.workspace_id)).toEqual([kept]);
    expect(await remove(owner, left, personId)).toEqual({
      status: 404,
      body: { error: 'not_found', detail: 'no such member of this workspace' },
    });

    // Removed from every workspace, they and their agents are signed out, and may not sign in again.
    expect((await remove(owner, kept, personId)).status).toBe(200);
    expect((await as(person, 'GET', '/api/access/me')).status).toBe(401);
    expect((await meWithToken(agent)).status).toBe(401);
    expect((await signIn(2106)).landed.searchParams.get('error')).toBe('not_invited');
  });
});

describe('the last owner of a workspace', () => {
  it('cannot be removed, and an owner invited in their place can remove them', async () => {
    const { owner, workspace } = await adminWithWorkspace(1002, 'Owners');
    const ownerId = await idOf(1002);
    const lastOwner = {
      status: 409,
      body: { error: 'last_owner', detail: "this is the workspace's last owner, and a workspace keeps at least one" },
    };
    expect(await remove(owner, workspace, ownerId)).toEqual(lastOwner);

    // A member invited again as owner becomes one at their next sign-in.
    await invited(owner, workspace, 'person-2107');
    await admitted(2107);
    await invited(owner, workspace, 'person-2107', 'owner');
    const second = await admitted(2107);
    expect(await workspacesOf(second)).toEqual([{ workspaceId: workspace, name: 'Owners', role: 'owner' }]);

    expect(await remove(second, workspace, ownerId)).toEqual({ status: 200, body: { removed: true } });
    expect(await remove(second, workspace, await idOf(2107))).toEqual(lastOwner);
    expect((await members(second, workspace)).body.members).toEqual([
      { userId: await idOf(2107), name: 'Person 2107', githubLogin: 'person-2107', role: 'owner' },
    ]);
  });
});

describe('a member', () => {
  it('cannot manage members, invitations or service credentials', async () => {
    const { owner, workspace } = await adminWithWorkspace(1003, 'Managed');
    await invited(owner, workspace, 'person-2108');
    const openInvitation = await invited(owner, workspace, 'person-2109');
    const member = await admitted(2108);
    const ownerId = await idOf(1003);
    const membersOnly = {
      status: 403,
      body: { error: 'owner_only', detail: 'only an owner of this workspace may manage its members and invitations' },
    };
    const credentialsOnly = {
      status: 403,
      body: { error: 'owner_only', detail: 'only an owner of this workspace may manage its service credentials' },
    };
    const send = (method: string, path: string, json?: unknown) =>
      as(member, method, path, { workspace, ...(json === undefined ? {} : { json }) });

    expect(await send('GET', '/api/access/members')).toEqual(membersOnly);
    expect(await send('POST', '/api/access/invitations', { githubLogin: 'person-2110', role: 'owner' })).toEqual(
      membersOnly,
    );
    expect(await send('POST', `/api/access/invitations/${openInvitation}/revoke`, {})).toEqual(membersOnly);
    expect(await send('POST', `/api/access/members/${ownerId}/remove`, {})).toEqual(membersOnly);
    expect(await send('GET', '/api/access/services')).toEqual(credentialsOnly);
    expect(await send('POST', '/api/access/services', { name: 'mine', backup: true })).toEqual(credentialsOnly);

    // Nothing changed: the owner, the member and the open invitation are all still there.
    const listed = (await members(owner, workspace)).body as {
      members: { userId: string }[];
      invitations: { invitationId: string; githubLogin: string }[];
    };
    expect(listed.members.map((row) => row.userId)).toContain(ownerId);
    expect(listed.invitations.map((row) => row.githubLogin)).toEqual(['person-2109']);
    expect((await as(owner, 'GET', '/api/access/services', { workspace })).body).toEqual({ services: [] });
  });
});
