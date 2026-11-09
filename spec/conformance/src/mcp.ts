/**
 * The operations over the MCP tool profile (mcp-profile.md): each is one
 * tool call, with the tool's arguments as section 11.3 names them. A
 * person's own decisions have no MCP tool, so `decide` is not offered.
 */
import {
  NotOffered,
  type Api,
  type HistoryEvent,
  type Outcome,
  type ParentContext,
  type Project,
  type Refusal,
  type RefusalKind,
  type Role,
  type Task,
  type TaskRead,
  type Written,
} from './api.ts';
import { addressOf, type Target } from './target.ts';
import { McpConnection, McpError, type ToolResult, type Trace } from './transport.ts';

const REFUSAL_KINDS: readonly [string, RefusalKind][] = [
  ['invalid arguments:', 'invalid'],
  ['refused:', 'refused'],
  ['conflict:', 'conflict'],
  ['unavailable:', 'unavailable'],
];

/** Drops arguments left undefined, so a call sends only what a check names. */
const defined = (args: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));

export function mcpApi(target: Target, role: Role, trace?: Trace): Api {
  const sender = target.senders[role];
  if (!sender) throw new Error(`the target names no ${role}`);
  const binding = target.bindings.mcp;
  if (!binding) throw new Error('the target offers no MCP binding');
  const endpoint = addressOf(target, binding.path);
  let connection: Promise<McpConnection> | null = null;
  const connected = () => (connection ??= new McpConnection(endpoint, sender.headers, trace).initialize());
  const workspace = target.workspace === undefined ? {} : { workspace: target.workspace };

  const call = async (tool: string, args: Record<string, unknown>): Promise<Outcome<unknown>> => {
    let result: ToolResult;
    try {
      result = await (await connected()).callTool(tool, defined({ ...workspace, ...args }));
    } catch (error) {
      if (!(error instanceof McpError)) throw error;
      return { ok: false, refusal: { kind: 'other', text: error.message, wellFormed: false } };
    }
    if (!result.isError) return { ok: true, value: result.value };
    const first = result.text.split('\n')[0] ?? '';
    const kind = REFUSAL_KINDS.find(([start]) => first.startsWith(start))?.[1] ?? 'other';
    return { ok: false, refusal: { kind, text: result.text, wellFormed: true } satisfies Refusal };
  };

  const map = async <T>(outcome: Promise<Outcome<unknown>>, read: (value: never) => T): Promise<Outcome<T>> => {
    const answered = await outcome;
    return answered.ok ? { ok: true, value: read(answered.value as never) } : answered;
  };

  const written = (value: Record<string, unknown>): Written => ({
    id: String(value.id ?? value.task ?? ''),
    version: typeof value.version === 'number' ? value.version : null,
    replayed: typeof value.replayed === 'boolean' ? value.replayed : null,
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
    ...('assignee' in value ? { assignee: value.assignee as string | null } : {}),
    ...(typeof value.commentId === 'string' ? { commentId: value.commentId } : {}),
    ...('parent' in value ? { parent: (value.parent ?? null) as ParentContext | null } : {}),
    raw: value,
  });

  const writeOptions = (options: { key?: string; model?: string } = {}) => ({
    idempotency_key: options.key,
    model: options.model,
  });
  const work = (options: { work?: Record<string, string | undefined>; for?: string } = {}) => ({
    ...(options.work ?? {}),
    for: options.for,
  });

  return {
    binding: 'mcp',
    role,
    projects: () =>
      map(call('list_projects', {}), (value: { projects: Project[] }) =>
        value.projects.map((project) => ({
          projectId: project.projectId,
          prefix: project.prefix,
          deploys: project.deploys === true,
        })),
      ),
    create: (task, options) =>
      map(
        call('create_task', {
          project: task.project ?? target.projects.main,
          title: task.title,
          description: task.description,
          acceptance: task.acceptance,
          type: task.type,
          labels: task.labels,
          parent: task.parent,
          choices: task.choices,
          depends_on: task.dependsOn,
          metadata: task.metadata,
          claim: task.claim,
          ...writeOptions(options),
        }),
        written,
      ),
    read: (task) =>
      map(
        call('get_task', { task }),
        (value: {
          task: Task;
          comments?: TaskRead['comments'];
          proposalVersion?: string | null;
          parent?: ParentContext | null;
        }): TaskRead => ({
          task: value.task,
          comments: value.comments ?? [],
          proposalVersion: value.proposalVersion ?? null,
          parent: value.parent ?? null,
        }),
      ),
    history: (task) =>
      map(call('get_task_history', { task, limit: 200 }), (value: { changes: HistoryEvent[] }) => value.changes),
    ready: async (project) => {
      // Every page, so a task listed after the first 200 ready ones is still found.
      const ids: string[] = [];
      let offset: number | undefined = 0;
      for (let page = 0; offset !== undefined && page < 100; page += 1) {
        const listed = await call('list_tasks', {
          project: project ?? target.projects.main,
          ready: true,
          limit: 200,
          offset,
        });
        if (!listed.ok) return listed;
        const value = listed.value as { tasks: { id: string }[]; nextOffset?: number | null };
        ids.push(...value.tasks.map((task) => task.id));
        offset = typeof value.nextOffset === 'number' ? value.nextOffset : undefined;
      }
      return { ok: true, value: ids };
    },
    claim: (task, options = {}) =>
      map(call('claim_task', { task, ...work(options), ...writeOptions(options) }), written),
    claimByPullRequest: (pr, options = {}) =>
      map(call('claim_task', { pr, project: target.projects.main, ...writeOptions(options) }), written),
    update: (task, change, options) =>
      map(
        call('update_task', {
          task,
          title: change.title,
          description: change.description,
          status: change.status,
          assignee: change.assignee,
          parent: change.parent,
          defer: change.defer,
          add_labels: change.addLabels,
          remove_labels: change.removeLabels,
          choices: change.choices,
          ...writeOptions(options),
        }),
        written,
      ),
    comment: (task, text, options = {}) =>
      map(
        call('comment_on_task', {
          task,
          text,
          ...work(options),
          ...(options.pin === true ? { pin: true } : {}),
          ...(options.unpin === undefined ? {} : { unpin: options.unpin }),
          ...writeOptions(options),
        }),
        (value: object) => written({ id: task, ...value }),
      ),
    close: (task, close, options) =>
      map(
        call('close_task', {
          task,
          reason: close.reason,
          resolution: close.resolution,
          duplicate_of: close.duplicateOf,
          commit: close.commit,
          pr: close.pr,
          link: close.link,
          ...writeOptions(options),
        }),
        written,
      ),
    link: (task, to, type) => call('link_tasks', type === null ? { task, to, remove: true } : { task, to, type }),
    requestApproval: (task, request) =>
      map(
        call('request_human_approval', { task, reason: request }),
        (value: { approval: { id: string }; created: boolean }) => ({
          approval: value.approval.id,
          created: value.created,
        }),
      ),
    requestSteps: (task, request) =>
      map(
        call('request_human_action', {
          task,
          title: request.title,
          context: request.context,
          steps: request.steps,
        }),
        (value: { request: { id: string }; created: boolean }) => ({
          request: value.request.id,
          created: value.created,
        }),
      ),
    relay: (task, relay, options) =>
      map(
        call('reconcile_task', {
          task,
          action: relay.action,
          proposal_version: relay.proposalVersion,
          option: relay.option,
          quote: relay.quote,
          source: relay.source,
          explanation: relay.explanation,
          evidence: relay.evidence,
          duplicate_of: relay.duplicateOf,
          holder: relay.holder,
          inactive: relay.inactive,
          activity_check: relay.activityCheck,
          progress: relay.progress,
          met: relay.met,
          ...writeOptions(options),
        }),
        written,
      ),
    misnamed: (task) => call('update_task', { task, titel: 'A misspelt argument' }),
    decide: () => Promise.reject(new NotOffered('mcp', "record a person's own decision")),
    signal: (signal) =>
      map(
        call('report_delivery', {
          repository: signal.repository,
          stage: signal.stage,
          pull_requests: signal.pullRequests,
          commits: signal.commits,
        }),
        (value: { moved: { id: string; stage: string }[] }) => ({ moved: value.moved }),
      ),
    connect: async () => {
      try {
        const fresh = await new McpConnection(endpoint, sender.headers, trace).initialize();
        return { ok: true, value: { instructions: fresh.instructions } };
      } catch (error) {
        if (!(error instanceof McpError)) throw error;
        return { ok: false, refusal: { kind: 'other', text: error.message, wellFormed: false } };
      }
    },
  };
}
