// The public workspace: a request with no credential that names it reads it
// as a visitor, and every change a visitor sends is refused with the store
// left as it was. Every other request without a credential is still refused
// with the challenge that sends an MCP client to sign in.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_HEADER } from '../src/workspaces.ts';
import { Browser, call } from './access/client.ts';
import { standInForGitHub } from './access/github.ts';

standInForGitHub();

/** A deployment's bindings with its public workspace setting, which the Worker's Env leaves out as an optional secret. */
type Bindings = Env & { readonly PUBLIC_WORKSPACE_ID?: string | undefined };

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface World {
  readonly owner: Browser;
  readonly demo: string;
  readonly other: string;
  readonly projectId: string;
  readonly taskId: string;
  /** The bindings of a deployment whose public workspace is `demo`. */
  readonly bindings: Bindings;
}

async function as(browser: Browser, method: string, path: string, workspace: string, json?: unknown): Promise<Answer> {
  const response = await browser.fetch(path, {
    method,
    ...(json === undefined ? {} : { json }),
    headers: { [WORKSPACE_HEADER]: workspace },
  });
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

async function build(): Promise<World> {
  const owner = new Browser({ joinTestWorkspace: false });
  await owner.signInWithGitHub(1002);
  const workspace = async (name: string) => {
    const created = await owner.fetch('/api/workspaces', { method: 'POST', json: { name } });
    expect(created.status).toBe(201);
    return (await created.json<{ workspace: { workspaceId: string } }>()).workspace.workspaceId;
  };
  const demo = await workspace('Demo');
  const other = await workspace('Private');
  const project = await as(owner, 'POST', '/api/tasks/projects', demo, { name: 'Recipes', prefix: 'rcp' });
  expect(project.status).toBe(201);
  const projectId = (project.body.project as { projectId: string }).projectId;
  const task = await as(owner, 'POST', '/api/tasks', demo, { projectId, title: 'Fix the recipe card' });
  expect(task.status).toBe(200);
  const privateProject = await as(owner, 'POST', '/api/tasks/projects', other, { name: 'Ledger', prefix: 'ldg' });
  expect(privateProject.status).toBe(201);
  return {
    owner,
    demo,
    other,
    projectId,
    taskId: task.body.id as string,
    bindings: { ...env, PUBLIC_WORKSPACE_ID: demo },
  };
}

// Tests in a file share their storage, so the world is built once.
let built: Promise<World> | undefined;
function world(): Promise<World> {
  built ??= build();
  return built;
}

/** A request with no credential, naming `workspace` when given one, to a deployment with `bindings`. */
async function visit(
  bindings: Bindings,
  method: string,
  path: string,
  options: { readonly workspace?: string; readonly json?: unknown; readonly headers?: Record<string, string> } = {},
): Promise<Answer & { readonly response: Response }> {
  const response = await call(
    path,
    {
      method,
      headers: {
        ...(options.workspace === undefined ? {} : { [WORKSPACE_HEADER]: options.workspace }),
        ...(options.json === undefined
          ? {}
          : { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }),
        ...options.headers,
      },
      ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
    },
    undefined,
    bindings,
  );
  const text = await response.clone().text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, response };
}

/** One MCP tool call by a visitor: its value, or the sentence it refused with. */
async function visitorTool(
  bindings: Bindings,
  workspace: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ value?: Record<string, unknown>; refused?: string }> {
  const { body } = await visit(bindings, 'POST', '/api/mcp', {
    workspace,
    json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
  });
  const result = body.result as { isError?: boolean; content: { text: string }[] } | undefined;
  if (!result) throw new Error(`${name} failed: ${JSON.stringify(body)}`);
  const text = result.content[0]!.text;
  return result.isError ? { refused: text } : { value: JSON.parse(text) as Record<string, unknown> };
}

describe('a visitor to the public workspace', () => {
  it('reads its projects, boards and tasks without a credential', async () => {
    const { bindings, demo, projectId, taskId } = await world();
    const projects = await visit(bindings, 'GET', '/api/tasks/projects', { workspace: demo });
    expect(projects.status).toBe(200);
    expect((projects.body.projects as { projectId: string }[]).map((project) => project.projectId)).toEqual([
      projectId,
    ]);
    const board = await visit(bindings, 'GET', `/api/tasks?project=${projectId}`, { workspace: demo });
    expect((board.body.tasks as { id: string }[]).map((task) => task.id)).toEqual([taskId]);
    const task = await visit(bindings, 'GET', `/api/tasks/${taskId}?project=${projectId}`, { workspace: demo });
    expect(task.body.task).toMatchObject({ id: taskId, title: 'Fix the recipe card' });
    const capabilities = await visit(bindings, 'GET', '/api/tasks/capabilities', { workspace: demo });
    expect(capabilities.body).toMatchObject({ writable: false, operations: [] });
  });

  it('reads it over MCP, as a viewer who may only read', async () => {
    const { bindings, demo, taskId } = await world();
    const listed = await visitorTool(bindings, demo, 'list_workspaces');
    expect(listed.value?.workspaces).toEqual([
      { workspaceId: demo, name: 'Demo', role: 'viewer', status: 'active', access: ['tasks:read'] },
    ]);
    const read = await visitorTool(bindings, demo, 'get_task', { task: taskId });
    expect(read.value).toMatchObject({ task: { id: taskId } });
  });

  it('is refused every change, and the store keeps what it held', async () => {
    const { owner, bindings, demo, projectId, taskId } = await world();
    const before = await as(owner, 'GET', `/api/tasks/${taskId}?project=${projectId}`, demo);
    const writes: [string, string, unknown][] = [
      ['POST', '/api/tasks', { projectId, title: 'A visitor task' }],
      ['PATCH', `/api/tasks/${taskId}`, { projectId, claim: true }],
      ['POST', `/api/tasks/${taskId}/comments`, { projectId, text: 'hello' }],
      ['POST', `/api/tasks/${taskId}/close`, { projectId, reason: 'done' }],
      ['POST', '/api/tasks/projects', { name: 'Visitor project', prefix: 'vst' }],
    ];
    for (const [method, path, json] of writes) {
      const answer = await visit(bindings, method, path, { workspace: demo, json });
      expect([method, path, answer.status]).toEqual([method, path, 403]);
      expect(answer.body.error).toBe('insufficient_scope');
    }
    for (const [name, args] of [
      ['create_task', { title: 'A visitor task', project: projectId }],
      ['claim_task', { task: taskId }],
      ['comment_on_task', { task: taskId, text: 'hello' }],
      ['close_task', { task: taskId, reason: 'done' }],
    ] as const) {
      const answer = await visitorTool(bindings, demo, name, args);
      expect(answer.refused).toMatch(/^refused: this call needs tasks:write/u);
    }
    expect((await visit(bindings, 'GET', '/api/backup', { workspace: demo })).status).toBe(403);
    const after = await as(owner, 'GET', `/api/tasks/${taskId}?project=${projectId}`, demo);
    expect(after.body.task).toEqual(before.body.task);
    expect(after.body.comments).toEqual([]);
    const board = await as(owner, 'GET', `/api/tasks?project=${projectId}`, demo);
    expect((board.body.tasks as { id: string }[]).map((task) => task.id)).toEqual([taskId]);
    const projects = await as(owner, 'GET', '/api/tasks/projects', demo);
    expect((projects.body.projects as unknown[]).length).toBe(1);
  });
});

describe('a request with no credential', () => {
  it('is challenged to sign in when it names another workspace, or none', async () => {
    const { bindings, other } = await world();
    for (const workspace of [other, undefined]) {
      const answer = await visit(bindings, 'GET', '/api/tasks/projects', workspace === undefined ? {} : { workspace });
      expect(answer.status).toBe(401);
      expect(answer.response.headers.get('www-authenticate')).toMatch(/^Bearer resource_metadata=/u);
    }
  });

  it('is challenged when the deployment has no public workspace, or names one with a malformed id', async () => {
    const { demo } = await world();
    for (const setting of [undefined, demo.toUpperCase(), `${demo} extra`]) {
      const bindings: Bindings = { ...env, PUBLIC_WORKSPACE_ID: setting };
      const answer = await visit(bindings, 'GET', '/api/tasks/projects', { workspace: demo });
      expect([setting, answer.status]).toEqual([setting, 401]);
    }
  });

  it('is refused, not read as a visitor, when it carries a credential that does not sign in', async () => {
    const { bindings, demo } = await world();
    const answer = await visit(bindings, 'GET', '/api/tasks/projects', {
      workspace: demo,
      headers: { authorization: 'Bearer not-a-token' },
    });
    expect(answer.status).toBe(401);
    expect(answer.response.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });
});
