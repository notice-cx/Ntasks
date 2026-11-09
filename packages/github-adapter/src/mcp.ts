/**
 * The MCP tools of the protocol's core level (mcp-profile.md 11.3), over
 * Streamable HTTP: one JSON-RPC message per POST, answered whole, with no
 * session. A refused call answers a tool result marked as an error whose
 * first line says what kind of refusal it is (MCP-3).
 */
import {
  bool,
  checkArgs,
  integer,
  list,
  nonEmpty,
  object,
  oneOf,
  schemaOf,
  taskId,
  text,
  type ArgSpec,
  type Args,
} from './args.ts';
import { LINK_TYPES, RESOLUTIONS, STATUSES, TYPES, type Engine, type Sender } from './engine.ts';
import { GitHubError } from './github.ts';
import { Refused } from './refused.ts';

export const REVISIONS = ['2025-06-18', '2025-11-25', '2025-03-26'];

const URL_TEXT: ArgSpec = {
  schema: { type: 'string', format: 'uri', maxLength: 2048 },
  check: (value) =>
    typeof value === 'string' && /^https?:\/\/\S+$/u.test(value) && value.length <= 2048
      ? null
      : 'an http or https URL',
};
const COMMIT: ArgSpec = {
  schema: { type: 'string', pattern: '^[0-9a-f]{7,64}$' },
  check: (value) =>
    typeof value === 'string' && /^[0-9a-f]{7,64}$/u.test(value) ? null : '7 to 64 hexadecimal characters',
};
const DATE: ArgSpec = {
  schema: { type: 'string' },
  check: (value) =>
    value === '' || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value))
      ? null
      : 'YYYY-MM-DD, or "" to clear it',
};
const WORK: Readonly<Record<string, ArgSpec>> = {
  for: nonEmpty(64, true),
  session: nonEmpty(512, true),
  worktree: nonEmpty(512, true),
  branch: nonEmpty(255, true),
  commit: nonEmpty(128, true),
  pr: URL_TEXT,
  next: nonEmpty(512, true),
};
const TASKS = list(taskId, 32);
const LABELS = list(nonEmpty(128, true), 32);
const MARKDOWN = text(8192);

interface Tool {
  readonly description: string;
  readonly args: Readonly<Record<string, ArgSpec>>;
  readonly required?: readonly string[];
  readonly run: (engine: Engine, sender: Sender, args: Args) => Promise<unknown>;
}

const TOOLS: Readonly<Record<string, Tool>> = {
  list_projects: {
    description: 'List the projects you reach: each a GitHub repository, or the issues of one that carry a label.',
    args: {},
    run: async (engine, sender) => ({
      projects: engine.projects(sender).map((project) => ({
        projectId: project.projectId,
        key: project.key,
        name: project.name,
        prefix: project.prefix,
        deploys: false,
      })),
    }),
  },
  list_tasks: {
    description:
      'List tasks most urgent first: every open one and those closed in the last 7 days. ready: true lists ready work.',
    args: {
      project: nonEmpty(255, true),
      ready: bool,
      status: list(oneOf(STATUSES), 5),
      assignee: nonEmpty(255, true),
      closed_days: integer(1, 56),
      limit: integer(1, 200),
      offset: integer(0, 1_000_000),
    },
    run: (engine, sender, args) =>
      engine.list(sender, {
        project: args.project,
        ...(args.ready === undefined ? {} : { ready: args.ready as boolean }),
        ...(args.status === undefined ? {} : { status: args.status as string[] }),
        ...(args.assignee === undefined ? {} : { assignee: args.assignee as string }),
        closedDays: (args.closed_days as number | undefined) ?? 7,
        limit: (args.limit as number | undefined) ?? 50,
        offset: (args.offset as number | undefined) ?? 0,
      }),
  },
  get_task: {
    description: 'Read one task in full, with its comments and proposalVersion.',
    args: { task: taskId, project: nonEmpty(255, true) },
    required: ['task'],
    run: (engine, sender, args) => engine.read(sender, args.task as string),
  },
  get_task_history: {
    description: "Read a task's changes, newest first, each with its actor, model, time and the fields it set.",
    args: { task: taskId, project: nonEmpty(255, true), limit: integer(1, 200) },
    required: ['task'],
    run: (engine, sender, args) =>
      engine.history(sender, args.task as string, (args.limit as number | undefined) ?? 50),
  },
  create_task: {
    description: 'File a task as a new issue. claim: true files it claimed by you.',
    args: {
      project: nonEmpty(255, true),
      title: nonEmpty(512, true),
      description: MARKDOWN,
      acceptance: MARKDOWN,
      notes: MARKDOWN,
      design: MARKDOWN,
      type: oneOf(TYPES.filter((type) => type !== 'gate')),
      priority: integer(0, 4),
      labels: LABELS,
      parent: taskId,
      depends_on: TASKS,
      blocks: TASKS,
      related: TASKS,
      discovered_from: TASKS,
      metadata: object,
      claim: bool,
    },
    required: ['title'],
    run: (engine, sender, args) => engine.create(sender, args),
  },
  claim_task: {
    description: 'Take an open task nobody else holds. Refused when someone else holds it.',
    args: { task: taskId, project: nonEmpty(255, true), ...WORK },
    required: ['task'],
    run: (engine, sender, args) => engine.claim(sender, args),
  },
  update_task: {
    description:
      'Change a task. assignee: "" releases it; another name hands it over, from its holder only. A status on a closed task reopens it.',
    args: {
      task: taskId,
      project: nonEmpty(255, true),
      title: nonEmpty(512, true),
      description: MARKDOWN,
      acceptance: MARKDOWN,
      notes: MARKDOWN,
      design: MARKDOWN,
      status: oneOf(STATUSES.filter((status) => status !== 'closed')),
      priority: integer(0, 4),
      assignee: text(255, true),
      parent: { schema: { type: 'string' }, check: (value) => (value === '' ? null : taskId.check(value)) },
      defer: DATE,
      add_labels: LABELS,
      remove_labels: LABELS,
    },
    required: ['task'],
    run: (engine, sender, args) => {
      const changes = Object.keys(args).filter(
        (name) => !['task', 'project', 'workspace', 'model', 'idempotency_key', 'detail'].includes(name),
      );
      if (changes.length === 0) throw new Refused('invalid', 'invalid arguments: name at least one field to change');
      return engine.update(sender, args);
    },
  },
  comment_on_task: {
    description: 'Comment on a task. Its holder may also record its work details.',
    args: { task: taskId, project: nonEmpty(255, true), text: nonEmpty(4096), ...WORK },
    required: ['task', 'text'],
    run: (engine, sender, args) => engine.comment(sender, args),
  },
  close_task: {
    description: 'Close a task with its reason, and as done with its proof: commit, pr or link.',
    args: {
      task: taskId,
      project: nonEmpty(255, true),
      reason: nonEmpty(2048),
      resolution: oneOf(RESOLUTIONS),
      duplicate_of: taskId,
      commit: COMMIT,
      pr: URL_TEXT,
      link: URL_TEXT,
    },
    required: ['task', 'reason'],
    run: (engine, sender, args) => engine.close(sender, args),
  },
  link_tasks: {
    description: 'Set the one link between two tasks, or remove it with remove: true.',
    args: { task: taskId, to: taskId, project: nonEmpty(255, true), type: oneOf(LINK_TYPES), remove: bool },
    required: ['task', 'to'],
    run: (engine, sender, args) => {
      if ((args.type === undefined) === (args.remove !== true))
        throw new Refused('invalid', 'invalid arguments: type (pass type, or remove: true)');
      return engine.link(sender, args);
    },
  },
  reconcile_task: {
    description:
      'Release a task whose holder stopped: action release, with holder, inactive: true, activity_check and progress.',
    args: {
      task: taskId,
      project: nonEmpty(255, true),
      action: nonEmpty(32, true),
      proposal_version: nonEmpty(64, true),
      holder: nonEmpty(128, true),
      inactive: bool,
      activity_check: nonEmpty(800),
      progress: nonEmpty(1000),
      explanation: nonEmpty(2000),
      evidence: nonEmpty(2000),
    },
    required: ['task', 'action', 'proposal_version'],
    run: (engine, sender, args) => engine.reconcile(sender, args),
  },
};

const INSTRUCTIONS =
  'A Shared Work Protocol server over GitHub issues, at the core level: list_projects, then list_tasks with ready: true for work nothing blocks. Claim before you build; close as done with its proof.';

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

/** The answer to one JSON-RPC message, or null for a notification. */
export async function answer(engine: Engine, sender: Sender, message: Message): Promise<unknown> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
  const error = (code: number, text: string) => ({
    jsonrpc: '2.0',
    id: message.id ?? null,
    error: { code, message: text },
  });
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(-32600, 'Invalid Request');
  if (message.id === undefined) return null;
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<
    string,
    unknown
  >;
  switch (message.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return reply({
        protocolVersion: REVISIONS.includes(asked) ? asked : REVISIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'swp-github', version: '0.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: Object.entries(TOOLS).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: schemaOf(tool.args, tool.required),
        })),
      });
    case 'tools/call': {
      const tool = TOOLS[String(params.name)];
      if (!tool) return error(-32602, `Unknown tool: ${String(params.name)}`);
      try {
        const args = checkArgs(params.arguments ?? {}, tool.args, tool.required);
        const value = await tool.run(engine, sender, args);
        return reply({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
      } catch (thrown) {
        const refusal =
          thrown instanceof Refused
            ? thrown
            : thrown instanceof GitHubError
              ? new Refused('unavailable', `unavailable: ${thrown.message}`)
              : null;
        if (refusal === null) throw thrown;
        return reply({ content: [{ type: 'text', text: refusal.text() }], isError: true });
      }
    }
    default:
      return error(-32601, `Method not found: ${message.method}`);
  }
}
