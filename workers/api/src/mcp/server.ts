/**
 * The MCP endpoint's server: the task tools, the workspace every tool but
 * list_workspaces names, and the scope each tool needs. One is built for each
 * request, around the sender that request signed in as.
 */
import { SCOPES, type Principal } from '../auth.ts';
import { Refused } from '../refused.ts';
import type { McpServer, McpTool } from './protocol.ts';
import { McpToolError } from './protocol.ts';
import { READ, READ_TOOLS, schema, type TaskTool, type ToolContext } from './read-tools.ts';
import { TASK_GUIDE_TOOL, taskGuide, taskInstructions } from './guide.ts';
import { objectsFromText, staleClientLine, WRITE_TOOLS } from './write-tools.ts';
import { FIELD_TOOLS } from './field-tools.ts';
import { GET_AGENT_STATS, RECONCILE_TASK } from './owner-tools.ts';

export const SERVER_INFO = Object.freeze({ name: 'ntasks', version: '0.1.0' });

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
  ...FIELD_TOOLS,
];
export const MCP_TOOLS: readonly McpTool[] = Object.freeze([
  LIST_WORKSPACES,
  GET_TASK_GUIDE,
  ...TASK_TOOLS.map(inWorkspace),
]);
/** The names of the tools this endpoint offers, which the guide is told. */
const OFFERED: readonly string[] = Object.freeze(MCP_TOOLS.map((tool) => tool.name));

/** What the sender may do: the scopes this endpoint knows, of those it holds. */
function accessOf(principal: Principal): string[] {
  return Object.values(SCOPES).filter((scope) => principal.scopes.includes(scope));
}

export function taskServer(context: ToolContext): McpServer {
  const { workspace, principal } = context;
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
        const access = accessOf(principal);
        return {
          // The guide's version, so an agent that read the guide reads it again only when it changed.
          guideVersion: (await taskGuide(OFFERED)).version,
          workspaces: [
            {
              workspaceId: workspace.id,
              name: workspace.name,
              role: access.includes(SCOPES.write) ? 'operator' : 'viewer',
              status: 'active',
              access,
            },
          ],
        };
      }
      const { workspace: named, ...rest } = args;
      if (typeof named !== 'string' || !named)
        throw new McpToolError('invalid arguments: workspace (a workspaceId from list_workspaces)');
      if (named !== workspace.id)
        throw new McpToolError(`refused: workspace ${named} is not one of yours; list_workspaces lists yours.`);
      const tool = TASK_TOOLS.find((candidate) => candidate.name === name);
      // serveMcp calls only the tools this server lists.
      if (!tool) throw new Error(`unlisted tool ${name}`);
      if (!principal.scopes.includes(tool.scope)) {
        const access = accessOf(principal);
        throw new McpToolError(
          `refused: this call needs ${tool.scope} in workspace ${workspace.id} (${workspace.name}), ` +
            `where you have ${access.join(', ') || 'no access'}; list_workspaces shows what you may do in each.`,
        );
      }
      return runTool(tool, context, rest);
    },
  });
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
