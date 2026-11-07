/**
 * The MCP endpoint's server: the task tools, the workspace every tool but
 * list_workspaces and get_task_guide names, and the scope each tool needs.
 * The Worker answers the endpoint with the sender's workspaces from its
 * sign-in: tools/list, list_workspaces and get_task_guide itself, and every
 * other tool call in the store of the workspace its `workspace` argument
 * names (`runTaskTool`), with the sender scoped to that workspace.
 */
import { SCOPES } from '../auth.ts';
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

export const SERVER_INFO = Object.freeze({ name: 'ntasks', version: '0.1.0' });

/** The largest MCP message: a create_tasks call filing many long tasks fits. */
const MCP_BYTES = 256 * 1024;

const WORKSPACE = Object.freeze({ type: 'string', description: 'The workspaceId from list_workspaces.' });

/** Every tool but list_workspaces and get_task_guide names its workspace. */
function inWorkspace(tool: TaskTool): McpTool {
  const input = tool.inputSchema as { properties?: Record<string, unknown>; required?: readonly string[] };
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    annotations: tool.annotations,
    inputSchema: Object.freeze({
      ...input,
      properties: { workspace: WORKSPACE, ...input.properties },
      required: ['workspace', ...(input.required ?? [])],
    }),
  });
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

/** What the sender may do: the scopes this endpoint knows, of those it holds. */
function accessOf(scopes: readonly string[]): string[] {
  return Object.values(SCOPES).filter((scope) => scopes.includes(scope));
}

/** The sender's role in NoticeOS's words: a workspace's owner, or by what it may do there. */
function roleOf(reach: WorkspaceReach, access: readonly string[]): 'owner' | 'operator' | 'viewer' {
  if (reach.role === 'owner') return 'owner';
  return access.includes(SCOPES.write) ? 'operator' : 'viewer';
}

/** The endpoint's server for a sender who reaches `workspaces`, running each task tool through `run`. */
export function taskServer(workspaces: readonly WorkspaceReach[], run: RunTool): McpServer {
  return Object.freeze({
    info: SERVER_INFO,
    instructions: taskInstructions(OFFERED),
    tools: MCP_TOOLS,
    async call(name: string, args: Record<string, unknown>) {
      if (name === TASK_GUIDE_TOOL) {
        if (Object.keys(args).length > 0) throw new McpToolError(`invalid arguments: ${TASK_GUIDE_TOOL} takes none`);
        return taskGuide(OFFERED);
      }
      if (name === 'list_workspaces') {
        if (Object.keys(args).length > 0) throw new McpToolError('invalid arguments: list_workspaces takes none');
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
      if (typeof named !== 'string' || !named)
        throw new McpToolError('invalid arguments: workspace (a workspaceId from list_workspaces)');
      // A workspace the sender does not reach is answered as one that does not exist.
      const reach = workspaces.find((candidate) => candidate.workspace.id === named);
      if (!reach)
        throw new McpToolError(`refused: workspace ${named} is not one of yours; list_workspaces lists yours.`);
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
): Promise<Response> {
  if (new URL(request.url).search)
    return json({ error: 'invalid_request', detail: 'the MCP endpoint takes no query' }, 400);
  return serveMcp(request, taskServer(workspaces, run), { maxBytes: MCP_BYTES });
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
      refused:
        `refused: this call needs ${tool.scope} in workspace ${workspace.id} (${workspace.name}), ` +
        `where you have ${access.join(', ') || 'no access'}; list_workspaces shows what you may do in each.`,
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
    reply = await tool.run(context, read.args);
  } catch (error) {
    if (error instanceof Refused || error instanceof McpToolError) {
      throw new McpToolError(line === null ? error.message : `${line}. ${error.message}`);
    }
    throw error;
  }
  return line === null ? reply : { staleClient: line, ...(reply as Record<string, unknown>) };
}
