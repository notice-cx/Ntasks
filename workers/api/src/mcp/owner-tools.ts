/**
 * reconcile_task, which records an owner answer an agent holds or maintains
 * a human request with evidence, and get_agent_stats, which counts agents'
 * work. Their names, schemas, results and refusals are NoticeOS's
 * (scripts/hosted-task-mcp.mts there); owner-answers.ts and agent-stats.ts
 * hold their rules.
 */
import { TASK_LIMITS } from '@ntasks/domain';
import { choiceArg, keyArg, modelArg, only, projectArg, refuse, taskArg, textArg, type Args } from '../args.ts';
import { agentStats } from '../agent-stats.ts';
import { SCOPES } from '../auth.ts';
import { TASK_CHOICE_KEYS } from '../noticeos-fields.ts';
import { MAINTENANCE_ACTIONS, reconcileTask, seen, type TaskMaintenance } from '../owner-answers.ts';
import { mcpTask } from '../views.ts';
import { PROJECT, READ, schema, TASK, type TaskTool, type ToolContext } from './read-tools.ts';
import { IDEMPOTENCY, MODEL, retryRequest, WRITE } from './write-tools.ts';

/** The arguments reconcile_task takes. */
const RECONCILE_ARGS = [
  'project',
  'task',
  'action',
  'proposal',
  'explanation',
  'evidence',
  'response',
  'owner',
  'source',
  'scope',
  'answer_mode',
  'question',
  'approval_item',
  'option',
  'duplicate_of',
  'holder',
  'inactive',
  'activity_check',
  'progress',
  'model',
  'idempotency_key',
] as const;

/** An object with the keys whose value is undefined left out, in the order given. */
function defined<T extends object>(row: T): T {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as T;
}

export const RECONCILE_TASK: TaskTool = Object.freeze({
  name: 'reconcile_task',
  description:
    'Record an existing owner answer, retire a completed/obsolete/superseded/duplicate human request, ' +
    'record a declined approval gate, remove a routine human label, or release a confirmed inactive assignment. Read get_task first and send its proposal snapshot. ' +
    'For linkless local conversations use answer_mode relayed with the exact question, reply, owner, scope and claude-code:session/<session id> or a comment preserving those words. Relayed approvals close immediately and the owner may dispute them. owner_performed records the owner’s completed result as done without granting an agent permission. Obsolete requests close as no-longer-needed. ' +
    'Evidence and a plain explanation are required. For an answer received directly from the owner in this chat, use answer_mode: direct with the exact question and reply; your authenticated agent identity is recorded as the recorder. Otherwise verify owner identity and the exact proposal in the linked source. Never invent an answer. ' +
    'For batch replies, call once per explicitly named task within the answered scope. ' +
    'Retirement grants no permission; production reads/writes, spending, messages, destructive actions and material commitments still require explicit action-specific approval.',
  inputSchema: schema(
    {
      project: PROJECT,
      task: TASK,
      action: { type: 'string', enum: MAINTENANCE_ACTIONS },
      proposal: {
        type: 'string',
        description: 'The exact proposal snapshot from get_task for the proposal the owner saw.',
      },
      explanation: { type: 'string', maxLength: 800, description: 'Plain-language reason for this disposition.' },
      evidence: {
        type: 'string',
        maxLength: 800,
        description:
          'Concrete commit, task, test or source reference proving the reason; code alone never proves approval.',
      },
      response: {
        type: 'string',
        maxLength: 1000,
        description:
          'For answer, declined or owner_performed: exact owner words. A, a recommendation reply, a clear direction or the explicit refusal.',
      },
      owner: {
        type: 'string',
        description: 'Required for answer, declined or owner_performed: the human owner, never the relaying agent.',
      },
      source: {
        type: 'string',
        description:
          'Original source: comment:<id> on this task, https:// or codex://threads/ conversation, or claude-code:session/<session id> with answer_mode relayed. owner_performed requires the owner’s reported result, never agent implementation evidence.',
      },
      scope: {
        type: 'string',
        maxLength: 1000,
        description:
          'For answer: exactly what the owner authorized. An approval gate requires its exact full Reason text.',
      },
      answer_mode: {
        type: 'string',
        enum: ['direct', 'relayed'],
        description:
          'direct requires a chat URL; relayed also accepts claude-code:session/<session id> or a task comment quoting the exact question and reply. Both record the admitted agent without independent authentication. Relayed approvals close immediately and the owner can dispute them. Omit for source-verified answers.',
      },
      question: {
        type: 'string',
        maxLength: 1000,
        description:
          'For direct or relayed answers: the exact question presented to the owner. Approval questions must include the complete requested action, environment and verification.',
      },
      approval_item: {
        type: 'integer',
        minimum: 1,
        maximum: 99,
        description:
          'For a numbered batch approval relayed from a source comment: the item the gate requests. The source must preserve its number and the exact question and reply.',
      },
      option: {
        type: 'string',
        enum: TASK_CHOICE_KEYS,
        description:
          'For a direct decision-card answer: the stored option corresponding to the exact selected reply. Preserve the reply in response; never map an uncertain or conflicting answer.',
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
    },
    ['project', 'task', 'action', 'proposal', 'explanation', 'evidence', 'idempotency_key'],
  ),
  annotations: WRITE,
  scope: SCOPES.write,
  async run(context: ToolContext, args: Args) {
    only(args, RECONCILE_ARGS);
    // Built in the order NoticeOS built it: a recorded disposition keeps this object as its identity.
    const operation: TaskMaintenance = defined({
      kind: 'maintain' as const,
      taskId: taskArg(args),
      action: choiceArg(args, 'action', MAINTENANCE_ACTIONS)!,
      proposal: textArg(args, 'proposal', 30000, true)!,
      explanation: textArg(args, 'explanation', 800, true)!,
      evidence: textArg(args, 'evidence', 800, true)!,
      model: modelArg(args),
      response: textArg(args, 'response', 1000, false),
      owner: textArg(args, 'owner', TASK_LIMITS.actor, false),
      source: textArg(args, 'source', 512, false),
      scope: textArg(args, 'scope', 1000, false),
      answerMode: choiceArg(args, 'answer_mode', ['direct', 'relayed'] as const),
      question: textArg(args, 'question', 1000, false),
      approvalItem: args.approval_item as number | undefined,
      option: choiceArg(args, 'option', TASK_CHOICE_KEYS),
      duplicateOf: args.duplicate_of === undefined ? undefined : taskArg(args, 'duplicate_of'),
      holder: textArg(args, 'holder', TASK_LIMITS.actor, false),
      inactive: args.inactive as boolean | undefined,
      activityCheck: textArg(args, 'activity_check', 800, false),
      progress: textArg(args, 'progress', 1000, false),
    });
    const projectId = projectArg(args);
    keyArg(args);
    if (operation.action === undefined) refuse('refused: action is required for reconciliation.');
    const { result } = await reconcileTask(context, projectId, operation, retryRequest('reconcile_task', args));
    return { task: mcpTask(await seen(context, result.task)), replayed: result.replayed };
  },
});

export const GET_AGENT_STATS: TaskTool = Object.freeze({
  name: 'get_agent_stats',
  description:
    'Agent work statistics grouped by model: current and blocked counts, closes in 7 days and the 7 before, eight weeks of velocity, ranking and leaders. Unknown models share Other. Returns aggregates without task details. Omit project for the whole workspace; failed projects are named in broken.',
  inputSchema: schema({
    project: { ...PROJECT, description: 'The projectId from list_projects; omit for workspace totals.' },
  }),
  annotations: READ,
  scope: SCOPES.read,
  async run(context: ToolContext, args: Args) {
    only(args, ['project']);
    return agentStats(context, args.project === undefined ? undefined : projectArg(args));
  },
});
