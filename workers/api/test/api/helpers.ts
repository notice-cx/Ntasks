// Shared set-up for the API tests: the API as the task store answers it, a
// sender the Worker signed in with the scopes a test gives them, and calls to
// its MCP endpoint and HTTP routes.
import type { TaskEngine } from '@ntasks/domain';
import { serveApi } from '../../src/api.ts';
import { SCOPES, type Authenticator, type Principal, type ProjectAccess } from '../../src/auth.ts';
import { createEngine } from '../../src/engine/index.ts';
import type { Meter } from '../../src/store/sqlite.ts';
import { createWorker } from '../../src/worker.ts';
import { store, storeDatabase } from '../store.ts';

export const WORKSPACE = Object.freeze({ id: 'workspace-test', name: 'Test workspace' });
export const ORIGIN = 'https://ntasks.test';

export const READER: Principal = Object.freeze({
  id: 'principal-reader',
  name: 'agent-a',
  scopes: [SCOPES.read],
  projects: 'all',
});
export const NOBODY: Principal = Object.freeze({ id: 'principal-none', name: 'agent-z', scopes: [], projects: 'all' });

/** A sender who may read and change every project. */
export const WRITER: Principal = Object.freeze({
  id: 'principal-writer',
  name: 'agent-w',
  scopes: [SCOPES.read, SCOPES.write],
  projects: 'all',
});

/** A sender with both scopes, granted these projects, each for reading or for writing too. */
export function granted(grants: Readonly<Record<string, ProjectAccess>>, name = 'agent-g'): Principal {
  return Object.freeze({
    id: `principal-${name}`,
    name,
    scopes: [SCOPES.read, SCOPES.write],
    projects: new Map(Object.entries(grants)),
  });
}

/** A sender granted only these projects, for reading. */
export function grantedOnly(...projectIds: readonly string[]): Principal {
  return Object.freeze({
    id: 'principal-granted',
    name: 'agent-g',
    scopes: [SCOPES.read],
    projects: new Map(projectIds.map((id) => [id, 'read'] as const)),
  });
}

/** Signs every request in as `principal`, or refuses every one when it is null. */
export function signedInAs(principal: Principal | null): Authenticator {
  return {
    authenticate: async () => principal,
    challenge: () => Response.json({ error: 'sign_in_required' }, { status: 401 }),
  };
}

/** The Worker as deployed, but signing every request in as `principal`. */
export function worker(principal: Principal | null) {
  return createWorker({ authenticator: () => signedInAs(principal) });
}

export interface TestApi {
  readonly engine: TaskEngine;
  fetch(request: Request): Promise<Response>;
}

/** The API as the task store answers it for `principal`, on the store's
 * storage, with a clock the test sets and its statements counted in `meter`.
 * `wrap` puts a test's own engine around the store's, to stage a race. */
export function api(
  options: {
    principal?: Principal;
    now?: () => string;
    meter?: Meter;
    engine?: TaskEngine;
    wrap?: (engine: TaskEngine) => TaskEngine;
  } = {},
): TestApi {
  const now = options.now ?? (() => new Date().toISOString());
  const engine = options.engine ?? createEngine(storeDatabase(options.meter), { now });
  const served = options.wrap?.(engine) ?? engine;
  const principal = options.principal ?? READER;
  return {
    engine,
    fetch: (request) =>
      serveApi(request, principal, {
        engine: served,
        workspace: WORKSPACE,
        now,
        backup: (token) => store().backupPage(token),
      }),
  };
}

/** A JSON-RPC reply to a tools/call, with the fields the tests read. */
export interface ToolReply {
  readonly result?: {
    readonly isError?: boolean;
    readonly content: readonly { readonly text: string }[];
    readonly structuredContent?: unknown;
  };
  readonly error?: { readonly code: number; readonly message: string };
}

/** Calls one MCP tool in the initialize era; returns its result, or the
 * sentence it refused with as `refused`. */
export async function callTool<T = Record<string, unknown>>(
  target: TestApi,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ value: T; refused: null } | { value: null; refused: string }> {
  const response = await target.fetch(
    new Request(`${ORIGIN}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  );
  const reply = (await response.json()) as ToolReply;
  if (!reply.result) throw new Error(`${name} failed: ${JSON.stringify(reply.error)}`);
  const text = reply.result.content[0]!.text;
  return reply.result.isError ? { value: null, refused: text } : { value: JSON.parse(text) as T, refused: null };
}

/** Calls a tool that must answer; fails the test with its refusal otherwise. */
export async function read<T = Record<string, unknown>>(
  target: TestApi,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const answer = await callTool<T>(target, name, { workspace: WORKSPACE.id, ...args });
  if (answer.refused !== null) throw new Error(`${name} refused: ${answer.refused}`);
  return answer.value;
}

/** Calls a write tool that must answer; fails the test with its refusal otherwise. */
export const write = read;

/** Calls a tool that must refuse; returns the sentence. */
export async function refusal(target: TestApi, name: string, args: Record<string, unknown>): Promise<string> {
  const answer = await callTool(target, name, args);
  if (answer.refused === null) throw new Error(`${name} answered: ${JSON.stringify(answer.value)}`);
  return answer.refused;
}

/** GETs an HTTP route. */
export async function get(target: TestApi, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await target.fetch(new Request(`${ORIGIN}${path}`));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Sends an HTTP write with a JSON body. */
export async function send(
  target: TestApi,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await target.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
