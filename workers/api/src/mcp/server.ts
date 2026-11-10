/**
 * The MCP endpoint's server: the task tools, the workspace every tool but
 * list_workspaces and get_task_guide acts in, and the scope each tool needs.
 * The Worker answers the endpoint with the sender's workspaces from its
 * sign-in: tools/list, list_workspaces and get_task_guide itself, and every
 * other tool call in the store of the workspace its `workspace` argument
 * names, or of the sender's only workspace when it names none
 * (`runTaskTool`), with the sender scoped to that workspace.
 *
 * An argument a tool's schema does not name is refused before the tool runs,
 * naming the argument the sender most likely meant. Every refusal ends with
 * the task the call named, when the refusal does not name it, and whether
 * the change may have been written.
 */
import { isTaskId, type HeldTask } from '@ntasks/domain';
import { listed, suggestion, unknownArguments, type Args } from '../args.ts';
import { reachable, SCOPES } from '../auth.ts';
import type { Reader } from '../lookup.ts';
import { json } from '../http/respond.ts';
import { Refused } from '../refused.ts';
import type { WorkspaceReach } from '../workspaces.ts';
import type { McpServer, McpTool } from './protocol.ts';
import { McpToolError, serveMcp } from './protocol.ts';
import { READ, READ_TOOLS, schema, type TaskTool, type ToolContext } from './read-tools.ts';
import { TASK_GUIDE_TOOL, taskGuide, taskInstructions } from './guide.ts';
import { objectsFromText, staleClientLine, WRITE_TOOLS } from './write-tools.ts';
import { FIELD_TOOLS } from './field-tools.ts';
import { GET_AGENT_STATS, RECONCILE_TASK } from './owner-tools.ts';
import { REPORT_DELIVERY } from './delivery-tools.ts';

// The ntasks release PR raises the version on the marked line.
export const SERVER_INFO = Object.freeze({ name: 'ntasks', version: '0.1.0' }); // x-release-please-version

/** The largest MCP message: a create_tasks call filing many long tasks fits. */
const MCP_BYTES = 256 * 1024;

const WORKSPACE = Object.freeze({
  type: 'string',
  description: 'The workspaceId from list_workspaces. Left out when you reach only one workspace, the call acts in it.',
});

/**
 * A refusal as the agent reads it: the sentence that says what to fix, then
 * on its own line the task the call named, when the sentence does not name
 * it, and whether a retry is safe. Only a refusal of kind unavailable says
 * the change may have been written.
 */
function refusalOf(message: string, unsure: boolean, task: unknown): string {
  const named = isTaskId(task) && !message.includes(task) ? `Task ${task}. ` : '';
  const retry = unsure
    ? 'The change may have been written; read the task before retrying.'
    : 'Nothing was written; retrying is safe.';
  return `${message}\n${named}${retry}`;
}

/** The properties of a tool's input schema, as far as checking arguments needs them. */
interface ArgumentSchema {
  readonly properties?: Readonly<Record<string, ArgumentSchema>>;
  readonly items?: ArgumentSchema;
}

/** The arguments `args` holds that `schemaOf` does not name, at the top and
 * in each object of an array of objects, each with the one most likely meant. */
function unknownOf(
  schemaOf: ArgumentSchema,
  args: Args,
  at = '',
): { readonly path: string; readonly meant: string | null }[] {
  const properties = schemaOf.properties ?? {};
  const allowed = Object.keys(properties);
  const found = Object.keys(args)
    .filter((name) => !allowed.includes(name))
    .map((name) => ({ path: `${at}${name}`, meant: suggestion(name, allowed) }));
  for (const [name, property] of Object.entries(properties)) {
    const value = args[name];
    if (!property.items?.properties || !Array.isArray(value)) continue;
    value.forEach((entry: unknown, index) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry))
        found.push(...unknownOf(property.items!, entry as Args, `${at}${name}[${index}].`));
    });
  }
  return found;
}

/** Every tool but list_workspaces and get_task_guide acts in a workspace,
 * which a sender who reaches only one need not name. */
function inWorkspace(tool: TaskTool): McpTool {
  const input = tool.inputSchema as { properties?: Record<string, unknown> };
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    annotations: tool.annotations,
    inputSchema: Object.freeze({ ...input, properties: { workspace: WORKSPACE, ...input.properties } }),
  });
}

/** How many workspaces a refusal lists before pointing to list_workspaces. */
const LISTED_WORKSPACES = 10;

/** The workspace a call acts in: the one it names, else the sender's only one. */
function workspaceOf(
  workspaces: readonly WorkspaceReach[],
  named: unknown,
  rest: Args,
): WorkspaceReach | { readonly refused: string } {
  if (named === undefined) {
    const meant = Object.keys(rest).find((other) => suggestion(other, ['workspace']) !== null);
    if (meant !== undefined) return { refused: unknownArguments([{ path: meant, meant: 'workspace' }]) };
    if (workspaces.length === 1) return workspaces[0]!;
    if (workspaces.length === 0) return { refused: 'refused: you reach no workspace; list_workspaces lists yours.' };
    const names = workspaces
      .slice(0, LISTED_WORKSPACES)
      .map((reach) => `${reach.workspace.id} (${reach.workspace.name})`);
    const more = workspaces.length - names.length;
    return {
      refused:
        `invalid arguments: workspace (required: you reach ${workspaces.length} workspaces; name one by its workspaceId: ` +
        `${more > 0 ? `${names.join(', ')} and ${more} more, which list_workspaces lists` : listed(names)})`,
    };
  }
  if (typeof named !== 'string' || !named)
    return { refused: 'invalid arguments: workspace (a workspaceId from list_workspaces)' };
  // A workspace the sender does not reach is answered as one that does not exist.
  return (
    workspaces.find((candidate) => candidate.workspace.id === named) ?? {
      refused: `refused: workspace ${named} is not one of yours; list_workspaces lists yours.`,
    }
  );
}

const LIST_WORKSPACES: McpTool = Object.freeze({
  name: 'list_workspaces',
  description: 'List the workspaces you can use here, with your role and what this connection may do in each.',
  inputSchema: schema({}),
  annotations: READ,
});

const GET_TASK_GUIDE: McpTool = Object.freeze({
  name: TASK_GUIDE_TOOL,
  description:
    'The rules for working with Ntasks tasks, as Markdown with a version: the workflow from list_workspaces to close_task, ' +
    'how to write and close a task, and when a person decides. Read it before task work.',
  inputSchema: schema({}),
  annotations: READ,
});

/** The tools in the order tools/list returns them: NoticeOS's, in its order, then Ntasks' own. */
const TASK_TOOLS: readonly TaskTool[] = [
  RECONCILE_TASK,
  ...READ_TOOLS.filter((tool) => tool.name === 'list_projects'),
  GET_AGENT_STATS,
  ...READ_TOOLS.filter((tool) => tool.name !== 'list_projects'),
  ...WRITE_TOOLS,
  REPORT_DELIVERY,
  ...FIELD_TOOLS,
];
export const MCP_TOOLS: readonly McpTool[] = Object.freeze([
  LIST_WORKSPACES,
  GET_TASK_GUIDE,
  ...TASK_TOOLS.map(inWorkspace),
]);
/** The names of the tools this endpoint offers, which the guide is told. */
const OFFERED: readonly string[] = Object.freeze(MCP_TOOLS.map((tool) => tool.name));

/** What one task tool call answered in its workspace's store: its value, or
 * the sentence it refused with. A fault is thrown instead. */
export type ToolAnswer =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly refused: string };

/** Runs a task tool in one workspace's store; `args` no longer holds the workspace. */
export type RunTool = (reach: WorkspaceReach, name: string, args: Record<string, unknown>) => Promise<ToolAnswer>;

/** The open tasks the sender holds in one workspace's store (heldBy). */
export type ReadHeld = (reach: WorkspaceReach) => Promise<readonly HeldTask[]>;

/** How long a connecting client waits, in all, for the stores to say what its sender holds. */
export const HELD_WAIT_MS = 1500;

/** The open tasks a sender holds in the projects it reads, through one indexed read of the store. */
export async function heldBy({ engine, principal }: Reader): Promise<readonly HeldTask[]> {
  if (!principal.scopes.includes(SCOPES.read)) return [];
  const reached = new Set(reachable(principal, await engine.listProjects()).map((project) => project.id));
  return (await engine.listHeld(principal.name)).filter((task) => reached.has(task.projectId));
}

/** What the sender may do: the scopes this endpoint knows, of those it holds. */
function accessOf(scopes: readonly string[]): string[] {
  return Object.values(SCOPES).filter((scope) => scopes.includes(scope));
}

/** The sender's role in NoticeOS's words: a workspace's owner, or by what it may do there. */
function roleOf(reach: WorkspaceReach, access: readonly string[]): 'owner' | 'operator' | 'viewer' {
  if (reach.role === 'owner') return 'owner';
  return access.includes(SCOPES.write) ? 'operator' : 'viewer';
}

/** The endpoint's server for a sender who reaches `workspaces`, running each
 * task tool through `run`, and telling a client that connects the tasks its
 * sender holds, read through `held`. */
export function taskServer(
  workspaces: readonly WorkspaceReach[],
  run: RunTool,
  held: ReadHeld = async () => [],
  wait = HELD_WAIT_MS,
): McpServer {
  return Object.freeze({
    info: SERVER_INFO,
    instructions: taskInstructions(OFFERED),
    async connecting() {
      // The handshake answers by the deadline whatever the stores do: a store
      // that fails or has not answered by then leaves its tasks out.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), wait);
      });
      const each = await Promise.all(
        workspaces.map(async (reach) => {
          const read = held(reach).then(
            (tasks) => tasks.map((task) => ({ ...task, workspaceId: reach.workspace.id })),
            () => {
              console.error('held tasks unread');
              return null;
            },
          );
          return Promise.race([read, deadline]);
        }),
      );
      clearTimeout(timer);
      return taskInstructions(
        OFFERED,
        each.flatMap((tasks) => tasks ?? []),
        workspaces.length > 1,
      );
    },
    tools: MCP_TOOLS,
    async call(name: string, args: Record<string, unknown>) {
      const refused = (message: string) => new McpToolError(refusalOf(message, false, args.task));
      if (name === TASK_GUIDE_TOOL) {
        if (Object.keys(args).length > 0) throw refused(`invalid arguments: ${TASK_GUIDE_TOOL} takes none`);
        return taskGuide(OFFERED);
      }
      if (name === 'list_workspaces') {
        if (Object.keys(args).length > 0) throw refused('invalid arguments: list_workspaces takes none');
        return {
          // The guide's version, so an agent that read the guide reads it again only when it changed.
          guideVersion: (await taskGuide(OFFERED)).version,
          workspaces: workspaces.map((reach) => {
            const access = accessOf(reach.scopes);
            return {
              workspaceId: reach.workspace.id,
              name: reach.workspace.name,
              role: roleOf(reach, access),
              status: 'active',
              access,
            };
          }),
        };
      }
      const { workspace: named, ...rest } = args;
      const reach = workspaceOf(workspaces, named, rest);
      if ('refused' in reach) throw refused(reach.refused);
      const answer = await run(reach, name, rest);
      if (!answer.ok) throw new McpToolError(answer.refused);
      return answer.value;
    },
  });
}

/** Answers one request to the MCP endpoint from a sender who reaches `workspaces`. */
export async function serveTaskMcp(
  request: Request,
  workspaces: readonly WorkspaceReach[],
  run: RunTool,
  held?: ReadHeld,
): Promise<Response> {
  if (new URL(request.url).search)
    return json({ error: 'invalid_request', detail: 'the MCP endpoint takes no query' }, 400);
  return serveMcp(request, taskServer(workspaces, run, held), { maxBytes: MCP_BYTES });
}

/**
 * Runs one task tool in a workspace's store, for a sender scoped to that
 * workspace: the scope check, then the tool, its refusals becoming the
 * sentences the model reads.
 */
export async function runTaskTool(
  context: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  const { workspace, principal } = context;
  const tool = TASK_TOOLS.find((candidate) => candidate.name === name);
  // The Worker sends only the tools the endpoint lists, other than the two it answers.
  if (!tool) throw new Error(`unlisted tool ${name}`);
  if (!principal.scopes.includes(tool.scope)) {
    const access = accessOf(principal.scopes);
    return {
      ok: false,
      refused: refusalOf(
        `refused: this call needs ${tool.scope} in workspace ${workspace.id} (${workspace.name}), ` +
          `where you have ${access.join(', ') || 'no access'}; list_workspaces shows what you may do in each.`,
        false,
        args.task,
      ),
    };
  }
  try {
    return { ok: true, value: await runTool(tool, context, args) };
  } catch (error) {
    if (error instanceof McpToolError) return { ok: false, refused: error.message };
    throw error;
  }
}

/**
 * Runs a tool, its refusals becoming answers the model reads. An object
 * argument that arrived as text is read as JSON, and the reply or refusal
 * then opens by saying the client's copy of the tools is out of date.
 */
async function runTool(tool: TaskTool, context: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const read = objectsFromText(tool.inputSchema, args);
  const sent = [...read.text, ...read.unread];
  const line = sent.length === 0 ? null : staleClientLine(sent, (await taskGuide(OFFERED)).version);
  let reply: unknown;
  try {
    const unknown = unknownOf(tool.inputSchema as ArgumentSchema, read.args);
    if (unknown.length > 0) throw new McpToolError(unknownArguments(unknown));
    reply = await tool.run(context, read.args);
  } catch (error) {
    if (error instanceof Refused || error instanceof McpToolError) {
      const message = line === null ? error.message : `${line}. ${error.message}`;
      const unsure = error instanceof Refused && error.kind === 'unavailable';
      throw new McpToolError(refusalOf(message, unsure, args.task));
    }
    throw error;
  }
  return line === null ? reply : { staleClient: line, ...(reply as Record<string, unknown>) };
}
