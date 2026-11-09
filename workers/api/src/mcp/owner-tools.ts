/**
 * reconcile_task, which records an owner answer an agent relays or maintains
 * a human request with evidence, and get_agent_stats, which counts agents'
 * work with NoticeOS's name, schema and result (scripts/hosted-task-mcp.mts
 * there). owner-answers.ts and agent-stats.ts hold their rules.
 */
import { TASK_LIMITS } from '@ntasks/domain';
import {
  choiceArg,
  criteriaMetArg,
  detailArg,
  modelArg,
  projectArg,
  refuse,
  taskArg,
  textArg,
  type Args,
} from '../args.ts';
import { agentStats } from '../agent-stats.ts';
import { SCOPES } from '../auth.ts';
import { TASK_CHOICE_KEYS } from '../noticeos-fields.ts';
import { MAINTENANCE_ACTIONS, reconcileTask, seen, type TaskMaintenance } from '../owner-answers.ts';
import { mcpTask, PROPOSAL_VERSION, writtenView } from '../views.ts';
import { projectFor } from './project.ts';
import { PROJECT, READ, schema, TASK, type TaskTool, type ToolContext } from './read-tools.ts';
import { DETAIL, IDEMPOTENCY, MODEL, retryRequest, WRITE } from './write-tools.ts';

/** An object with the keys whose value is undefined left out, in the order given. */
function defined<T extends object>(row: T): T {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as T;
}

/** The disposition reconcile_task's arguments describe. */
function maintenanceOf(args: Args): TaskMaintenance {
  const action = choiceArg(args, 'action', MAINTENANCE_ACTIONS);
  if (action === undefined) refuse('refused: action is required for reconciliation.');
  const version = args.proposal_version;
  if (typeof version !== 'string' || !PROPOSAL_VERSION.test(version))
    refuse('invalid arguments: proposal_version (the proposalVersion get_task returned: 32 hexadecimal characters)');
  // Built in one order: a recorded disposition keeps this object as its identity.
  return defined({
    taskId: taskArg(args),
    action,
    proposalVersion: version,
    explanation: textArg(args, 'explanation', 800, false),
    evidence: textArg(args, 'evidence', 800, false),
    model: modelArg(args),
    option: choiceArg(args, 'option', TASK_CHOICE_KEYS),
    met: args.met === undefined ? undefined : criteriaMetArg(args, 'met'),
    quote: textArg(args, 'quote', 1000, false),
    source: textArg(args, 'source', 512, false),
    duplicateOf: args.duplicate_of === undefined ? undefined : taskArg(args, 'duplicate_of'),
    holder: textArg(args, 'holder', TASK_LIMITS.actor, false),
    inactive: args.inactive as boolean | undefined,
    activityCheck: textArg(args, 'activity_check', 800, false),
    progress: textArg(args, 'progress', 1000, false),
  });
}

export const RECONCILE_TASK: TaskTool = Object.freeze({
  name: 'reconcile_task',
  description:
    'Record an answer the owner gave you in conversation, or maintain a human request with evidence. Read get_task first. ' +
    'An answer: action answer (declined or owner_performed on an approval), proposal_version (the proposalVersion get_task returned for the proposal you showed the owner), quote (their exact words), source (where they said it) and, on a task with choices, the option they chose. ' +
    'Nothing reads the quote: name the option yourself. It is recorded as relayed by you; the owner can dispute a relayed approval, which reopens it. A refusal names the argument at fault. ' +
    'When the owner calls a task done although some of its criteria are unmet: action accepted, with met, the criteria they found met; it closes as done, accepted by them over the rest, and they can dispute it. Only the owner waives a criterion. ' +
    'Maintenance, with explanation and evidence: completed, obsolete, superseded or duplicate (with duplicate_of) retires a request; routine takes off the human label; release frees an assignment whose holder stopped. ' +
    'Retirement grants no permission; production reads/writes, spending, messages, destructive actions and material commitments still require explicit action-specific approval.',
  inputSchema: schema(
    {
      project: PROJECT,
      task: TASK,
      action: { type: 'string', enum: MAINTENANCE_ACTIONS },
      proposal_version: {
        type: 'string',
        pattern: PROPOSAL_VERSION.source,
        description:
          'The proposalVersion get_task returned for the proposal the owner saw. A version older than the task’s current one is refused: show the owner the task again.',
      },
      option: {
        type: 'string',
        enum: TASK_CHOICE_KEYS,
        description:
          'For answer on a task with choices: the option the owner chose. Leave it out when their answer chose none. An approval takes none.',
      },
      met: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        description:
          'For accepted: the numbers of the criteria the owner found met, counting each line or list item of acceptance from 1; [] when none is. The rest are recorded as waived.',
      },
      quote: {
        type: 'string',
        maxLength: 1000,
        description: 'For answer, declined, owner_performed or accepted: the owner’s exact words, recorded as given.',
      },
      source: {
        type: 'string',
        maxLength: 512,
        description:
          'For answer, declined, owner_performed or accepted: where the owner said it, such as a conversation URL, claude-code:session/<session id> or comment:<id>.',
      },
      explanation: {
        type: 'string',
        maxLength: 800,
        description: 'Plain-language reason for this disposition. Required for maintenance.',
      },
      evidence: {
        type: 'string',
        maxLength: 800,
        description:
          'Concrete commit, task, test or source reference proving the reason; code alone never proves approval. Required for maintenance.',
      },
      duplicate_of: {
        type: 'string',
        description: 'For duplicate: open task retaining complete scope. Duplicate gates must match the full request.',
      },
      holder: { type: 'string', description: 'For release: exact current assignee.' },
      inactive: {
        type: 'boolean',
        description:
          'For release: true only after checking the holder is no longer working; age alone is insufficient.',
      },
      activity_check: {
        type: 'string',
        maxLength: 800,
        description: 'For release: activity evidence and how it was checked.',
      },
      progress: {
        type: 'string',
        maxLength: 1000,
        description: 'For release: preserved progress, commits and remaining implementation.',
      },
      model: MODEL,
      idempotency_key: IDEMPOTENCY,
      detail: DETAIL,
    },
    ['task', 'action', 'proposal_version'],
  ),
  annotations: WRITE,
  scope: SCOPES.write,
  async run(context: ToolContext, args: Args) {
    const operation = maintenanceOf(args);
    const detail = detailArg(args);
    const retry = await retryRequest(context, 'reconcile_task', args);
    const projectId = await projectFor(context, args, operation.taskId);
    const { result } = await reconcileTask(context, projectId, operation, retry);
    const task = await seen(context, result.task);
    return detail === 'full'
      ? { task: mcpTask(task), replayed: result.replayed }
      : {
          ...writtenView(task, [
            'status',
            'assignee',
            'resolution',
            'awaitingHuman',
            'answer',
            ...(task.close?.acceptance ? (['closeAcceptance'] as const) : []),
          ]),
          replayed: result.replayed,
        };
  },
});

export const GET_AGENT_STATS: TaskTool = Object.freeze({
  name: 'get_agent_stats',
  description:
    'Agent work statistics grouped by model: current and blocked counts, closes in 7 days and the 7 before, eight weeks of velocity, ranking and leaders. Unknown models share Other. Returns aggregates without task details. Omit project for the whole workspace; failed projects are named in broken.',
  inputSchema: schema({
    project: { ...PROJECT, description: 'The projectId, key or prefix from list_projects; omit for workspace totals.' },
  }),
  annotations: READ,
  scope: SCOPES.read,
  async run(context: ToolContext, args: Args) {
    return agentStats(context, args.project === undefined ? undefined : projectArg(args));
  },
});
