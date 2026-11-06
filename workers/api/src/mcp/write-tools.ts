/**
 * The MCP tools that change tasks. Their names, arguments, descriptions,
 * results and refusals are the ones NoticeOS's task tools had
 * (scripts/hosted-task-mcp.mts there), so agents written for those change
 * Ntasks tasks unchanged; test/api/write-tools.test.ts compares the schemas
 * with NoticeOS's own. Each tool runs one of the writes in task-writes.ts.
 *
 * A write that would repeat its effect takes an idempotency_key, so an agent
 * can retry an interrupted call safely; a dependency or an approval request
 * repeats harmlessly and takes none. A created or changed task comes back
 * with what lint finds missing, as advice: nothing is refused for it.
 */
import {
  DEPENDENCY_TYPES,
  IDEMPOTENCY_KEY,
  TASK_LIMITS,
  TASK_RESOLUTIONS,
  type DependencyType,
  type Task,
  type TaskStatus,
} from '@ntasks/domain';
import {
  assigneeArg,
  cardArg,
  choiceArg,
  choicesArg,
  closingArgs,
  deferArg,
  emptyIsNone,
  handoffMetadataArg,
  keyArg,
  labelsArg,
  modelArg,
  only,
  priorityArg,
  projectArg,
  listed,
  refuse,
  setOrTakeOff,
  taskArg,
  textArg,
  typeArg,
  WRITABLE_TYPES,
  type Args,
} from '../args.ts';
import { SCOPES } from '../auth.ts';
import {
  choiceAdvice,
  GATE_REASON_MAX,
  gateReason,
  HANDOFF_FIELDS,
  HANDOFF_KINDS,
  HANDOFF_LABEL,
  HANDOFF_LIMITS,
  TASK_CARD_LIMITS,
  TASK_CHANGE_CLASSES,
  TASK_CHOICE_KEYS,
  TASK_CHOICE_LIMITS,
  TASK_MEASURABILITIES,
  TASK_REVENUE_FAMILIES,
} from '../noticeos-fields.ts';
import { Refused } from '../refused.ts';
import {
  addDependency,
  closeTask,
  commentOnTask,
  createTask,
  lintOf,
  lintView,
  removeDependency,
  requestApproval,
  sha256,
  updateTask,
  type NewLink,
  type NewTask,
  type RetryRequest,
  type TaskChange,
} from '../task-writes.ts';
import { commentView, mcpTask } from '../views.ts';
import { PROJECT, schema, TASK, type TaskTool } from './read-tools.ts';

export const WRITE = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

/** How many tasks one create_tasks call files: few enough to finish well inside a client's patience. */
const BATCH = 25;
const STATUSES: readonly Exclude<TaskStatus, 'closed'>[] = ['open', 'in_progress', 'blocked', 'deferred'];
/** The link arguments a new task takes. */
const LINKS = Object.freeze(['depends_on', 'blocks', 'related', 'discovered_from'] as const);

/** Optional on a new task, a claim and a close: the work is credited to this model as well as to the agent. */
const MODEL = Object.freeze({
  type: 'string',
  maxLength: TASK_LIMITS.actor,
  description:
    'The name of the model you run as, as you would say it. Pass it on every new task, claim and close: the Tower shows it beside your name, and the Agents page ranks your work by it.',
});
const IDEMPOTENCY = Object.freeze({
  type: 'string',
  pattern: IDEMPOTENCY_KEY.source,
  description: 'A key you choose for this call. Retrying with the same key and arguments never repeats the change.',
});
const TASK_IDS = (description: string) => ({
  type: 'array',
  items: { type: 'string' },
  maxItems: TASK_LIMITS.links,
  description,
});
/** The options a person picks from (noticeos-fields.ts holds the rules a call is checked against). */
const CHOICES = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['question', 'options'],
  description:
    'When the task needs a person to pick one option. The Tower shows one button per option; the pick comes back on the task as choice.',
  properties: {
    question: {
      type: 'string',
      maxLength: TASK_CHOICE_LIMITS.question,
      description: 'What the person decides, asked as a question.',
    },
    options: {
      type: 'array',
      minItems: TASK_CHOICE_LIMITS.fewest,
      maxItems: TASK_CHOICE_LIMITS.most,
      items: schema(
        {
          key: {
            type: 'string',
            enum: TASK_CHOICE_KEYS,
            description: 'a for the first option, b for the second, and so on in order.',
          },
          label: {
            type: 'string',
            maxLength: TASK_CHOICE_LIMITS.label,
            description: "One line: the words on the option's button.",
          },
          detail: {
            type: 'string',
            maxLength: TASK_CHOICE_LIMITS.detail,
            description: 'What choosing it means, when the label leaves it out.',
          },
          recommended: { type: 'boolean', description: 'true on exactly one option: the one you recommend.' },
        },
        ['key', 'label'],
      ),
    },
  },
});
const L = TASK_CARD_LIMITS;
/** Why a task is worth doing (noticeos-fields.ts holds the rules a call is checked against). */
const CARD = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['valuePerMonth', 'likelihood', 'reviewMinutes', 'daysToSignal', 'measurability'],
  description:
    'What the work is worth, for work meant to change money. The Tower ranks tasks by it; a task without one is listed, not ranked. ' +
    'The server records who wrote it and when.',
  properties: {
    valuePerMonth: {
      type: 'number',
      minimum: L.valuePerMonth.min,
      maximum: L.valuePerMonth.max,
      description: `The change in ledger value it predicts, USD a month, ${L.valuePerMonth.min} to ${L.valuePerMonth.max}; a loss it avoids counts as positive.`,
    },
    likelihood: {
      type: 'number',
      minimum: L.likelihood.min,
      maximum: L.likelihood.max,
      description: `How likely it pays off, ${L.likelihood.min} to ${L.likelihood.max}.`,
    },
    reviewMinutes: {
      type: 'number',
      minimum: L.reviewMinutes.min,
      maximum: L.reviewMinutes.max,
      description: `The operator's minutes to review and decide it, ${L.reviewMinutes.min} to ${L.reviewMinutes.max}; the ranking prices them.`,
    },
    buildMinutes: {
      type: 'number',
      minimum: L.buildMinutes.min,
      maximum: L.buildMinutes.max,
      description: `Your minutes to build it, ${L.buildMinutes.min} to ${L.buildMinutes.max}; shown beside the ranking, not priced.`,
    },
    daysToSignal: {
      type: 'integer',
      minimum: L.daysToSignal.min,
      maximum: L.daysToSignal.max,
      description: `Whole days until the ledger shows whether it worked, ${L.daysToSignal.min} to ${L.daysToSignal.max}.`,
    },
    measurability: {
      type: 'string',
      enum: TASK_MEASURABILITIES,
      description: 'How the change is measured: cohort, holdout, or unmeasured when neither applies.',
    },
    revenueFamily: { type: 'string', enum: TASK_REVENUE_FAMILIES, description: 'The revenue it moves.' },
    durability: {
      type: 'number',
      minimum: L.durability.min,
      maximum: L.durability.max,
      description: `How durable and diversified the gain is, a multiplier from ${L.durability.min} to ${L.durability.max}; 1 when left out.`,
    },
    kill: {
      ...schema(
        {
          state: {
            type: 'string',
            maxLength: L.killState,
            description: 'One line: the state that, still true on date, gives the task up.',
          },
          date: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            description: "YYYY-MM-DD. It is also the task's due date.",
          },
        },
        ['state', 'date'],
      ),
      description: 'When to give up on it.',
    },
    note: { type: 'string', maxLength: L.note, description: 'One line: why the money moves.' },
  },
});
const CHANGE_CLASS = Object.freeze({
  type: 'string',
  enum: TASK_CHANGE_CLASSES,
  description: 'The kind of change the task makes. The autonomy ladder and the likelihood priors are kept by it.',
});
/** A new task's fields, for create_task and each entry of create_tasks. */
const NEW_TASK = Object.freeze({
  title: { type: 'string', maxLength: TASK_LIMITS.title },
  description: { type: 'string', maxLength: TASK_LIMITS.description },
  type: {
    type: 'string',
    enum: WRITABLE_TYPES,
    description: 'decision records a choice; label it human when a person must make it.',
  },
  priority: { type: 'integer', minimum: 0, maximum: 4, description: '0 is most urgent.' },
  labels: { type: 'array', items: { type: 'string' }, maxItems: TASK_LIMITS.labels },
  parent: { type: 'string', description: 'A parent task id.' },
  acceptance: { type: 'string', maxLength: TASK_LIMITS.acceptance, description: 'What proves it done.' },
  depends_on: TASK_IDS('Tasks this one waits on: it is not ready until they close.'),
  blocks: TASK_IDS('Tasks that wait on this one.'),
  related: TASK_IDS('Tasks it relates to, without waiting on them; may name another project in this workspace.'),
  discovered_from: TASK_IDS('Tasks whose work turned this one up.'),
  approval: {
    type: 'string',
    maxLength: GATE_REASON_MAX,
    description:
      'What a person must approve before it proceeds. Opens a gate that holds it out of ready work, as request_human_approval does.',
  },
  choices: CHOICES,
  card: CARD,
  change_class: CHANGE_CLASS,
  metadata: {
    type: 'object',
    additionalProperties: false,
    required: HANDOFF_FIELDS,
    description:
      'The complete source identity from a copied NoticeOS handoff. Only these five fields are accepted; they grant no authority.',
    properties: {
      noticeos_source: { type: 'string', const: HANDOFF_LABEL },
      noticeos_asset: { type: 'string', maxLength: HANDOFF_LIMITS.asset, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' },
      noticeos_kind: { type: 'string', enum: HANDOFF_KINDS },
      noticeos_rule: { type: 'string', minLength: 1, maxLength: HANDOFF_LIMITS.value },
      noticeos_key: { type: 'string', minLength: 1, maxLength: HANDOFF_LIMITS.value },
    },
  },
});
const CREATE_FIELDS: readonly string[] = Object.freeze(Object.keys(NEW_TASK));

/** The call's arguments as its retry record keeps them: everything but the key. */
function retryRequest(operation: string, args: Args): RetryRequest {
  const { idempotency_key: key, ...request } = args;
  return { operation, key: key as string, request };
}

/** A new task's fields, from create_task or one entry of create_tasks.
 * `target` reads each task id it names: a parent or a linked task. */
function creation(args: Args, target: (name: string, value: unknown) => string): NewTask {
  const parent = args.parent === undefined ? undefined : target('parent', args.parent);
  const links: NewLink[] = [];
  for (const kind of LINKS) {
    const value = args[kind];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > TASK_LIMITS.links) refuse(`invalid arguments: ${kind}`);
    for (const id of value) links.push({ kind, taskId: target(kind, id) });
  }
  const targets = links.map((link) => link.taskId);
  if (targets.length > TASK_LIMITS.links) refuse(`invalid arguments: at most ${TASK_LIMITS.links} linked tasks`);
  if (new Set(targets).size !== targets.length)
    refuse('invalid arguments: a linked task is named twice; a task links to another once');
  if (parent !== undefined && targets.includes(parent))
    refuse('invalid arguments: the parent is linked already; leave it out of the other links');
  const fields = {
    title: textArg(args, 'title', TASK_LIMITS.title, true)!,
    description: textArg(args, 'description', TASK_LIMITS.description, false, true),
    type: typeArg(args),
    priority: priorityArg(args),
    labels: labelsArg(args, 'labels'),
    parent,
    metadata: handoffMetadataArg(args),
    acceptance: textArg(args, 'acceptance', TASK_LIMITS.acceptance, false, true),
    links: links.length ? links : undefined,
    choices: choicesArg(args),
    card: cardArg(args),
    changeClass: choiceArg(args, 'change_class', TASK_CHANGE_CLASSES),
    approval: textArg(args, 'approval', GATE_REASON_MAX, false),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as unknown as NewTask;
}

/** An approval request as every reply shows it, saying plainly what it does to the task. */
function approvalOf(taskId: string, gate: Task) {
  return {
    approval: { id: gate.id, status: gate.status, reason: gateReason(gate.description) },
    held: true,
    note: `${taskId} waits for the owner’s scoped approval of ${gate.id}. Record an existing answer with reconcile_task; never ask for the same approval again.`,
  };
}

/** One create_tasks entry's own idempotency key: the call's key and the entry's
 * place, so a retried call replays each entry it already made. */
async function entryKey(key: string, index: number): Promise<string> {
  return `batch.${(await sha256(`noticeos-task-batch-v1:${key}`)).slice(0, 40)}.${index}`;
}

export const WRITE_TOOLS: readonly TaskTool[] = Object.freeze([
  {
    name: 'create_task',
    description:
      "Create a task in a project, with its links, naming your model. The result's lint names sections it still lacks; " +
      'add them with update_task. create_tasks files many in one call.',
    inputSchema: schema({ project: PROJECT, ...NEW_TASK, model: MODEL, idempotency_key: IDEMPOTENCY }, [
      'project',
      'title',
      'idempotency_key',
    ]),
    annotations: WRITE,
    scope: SCOPES.write,
    async run(context, args) {
      only(args, ['project', ...CREATE_FIELDS, 'model', 'idempotency_key']);
      const task = creation(args, (name, value) => taskArg({ [name]: value }, name));
      const projectId = projectArg(args);
      const model = modelArg(args);
      keyArg(args);
      const { project, result } = await createTask(context, projectId, task, model, retryRequest('create_task', args));
      const id = result.task.id;
      const gate = result.created[0];
      return {
        id,
        project: project.key,
        replayed: result.replayed,
        ...(gate === undefined ? {} : approvalOf(id, gate)),
        lint: lintView(await lintOf(context, project.id, [result.task]), id, choiceAdvice(result.task)),
      };
    },
  },
  {
    name: 'create_tasks',
    description:
      `Create up to ${BATCH} tasks in one call, in order, naming your model. A parent or link may name an earlier ` +
      'task of the same call as #0 for the first, #1 for the second. Stops at the first task refused and says which; ' +
      'retrying with the same idempotency_key and tasks never files one twice.',
    inputSchema: schema(
      {
        project: PROJECT,
        tasks: { type: 'array', minItems: 1, maxItems: BATCH, items: schema(NEW_TASK, ['title']) },
        model: MODEL,
        idempotency_key: IDEMPOTENCY,
      },
      ['project', 'tasks', 'idempotency_key'],
    ),
    annotations: WRITE,
    scope: SCOPES.write,
    async run(context, args) {
      only(args, ['project', 'tasks', 'model', 'idempotency_key']);
      const projectId = projectArg(args);
      const batchKey = keyArg(args);
      const entries = args.tasks;
      const model = modelArg(args);
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > BATCH)
        refuse(`invalid arguments: tasks (1–${BATCH})`);
      // Every entry is read before any is filed, so a malformed one files nothing.
      const planned = entries.map((entry: unknown, index) => {
        try {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) refuse('invalid arguments: a task');
          const row = entry as Args;
          only(row, CREATE_FIELDS);
          return creation(row, (name, value) => {
            const earlier = typeof value === 'string' ? /^#(\d{1,2})$/u.exec(value) : null;
            if (!earlier) return taskArg({ [name]: value }, name);
            if (Number(earlier[1]) >= index)
              refuse(`invalid arguments: ${name} (#n names an earlier task of this call)`);
            return value as string;
          });
        } catch (error) {
          if (!(error instanceof Refused)) throw error;
          throw new Refused(
            error.kind,
            error.message.replace(/^invalid arguments: /u, `invalid arguments: tasks[${index}]: `),
          );
        }
      });
      const made: { index: number; task: Task; replayed: boolean; gate: Task | undefined }[] = [];
      let projectKey: string | null = null;
      let filedIn: string | null = null;
      const earlier = (id: string) => (id.startsWith('#') ? made[Number(id.slice(1))]!.task.id : id);
      let failed: Record<string, unknown> | null = null;
      for (const [index, task] of planned.entries()) {
        const resolved: NewTask = {
          ...task,
          ...(task.parent === undefined ? {} : { parent: earlier(task.parent) }),
          ...(task.links === undefined
            ? {}
            : { links: task.links.map((link) => ({ kind: link.kind, taskId: earlier(link.taskId) })) }),
        };
        try {
          const { project, result } = await createTask(context, projectId, resolved, model, {
            operation: 'create_tasks',
            key: await entryKey(batchKey, index),
            request: { project: projectId, task: entries[index] as unknown, model: model ?? null },
          });
          projectKey = project.key;
          filedIn = project.id;
          made.push({ index, task: result.task, replayed: result.replayed, gate: result.created[0] });
        } catch (error) {
          if (!(error instanceof Refused)) throw error;
          failed = { index, error: error.message };
          break;
        }
      }
      const found =
        filedIn === null
          ? new Map<string, readonly string[]>()
          : await lintOf(
              context,
              filedIn,
              made.map((entry) => entry.task),
            );
      return {
        project: projectKey,
        created: made.map(({ index, task, replayed, gate }) => ({
          index,
          id: task.id,
          replayed,
          ...(gate === undefined
            ? {}
            : { approval: { id: gate.id, status: gate.status, reason: gateReason(gate.description) }, held: true }),
          lint: lintView(found, task.id, choiceAdvice(task)),
        })),
        ...(made.some((entry) => entry.gate !== undefined)
          ? {
              note: 'A task with an approval waits for the owner’s scoped approval. Record an existing answer with reconcile_task.',
            }
          : {}),
        ...(failed
          ? {
              failed,
              notAttempted: planned.length - made.length - 1,
              retry:
                'Retry with the same idempotency_key and tasks to finish after a passing failure; tasks already filed are not repeated. ' +
                'To change a refused task, send it and the rest with a new key, naming filed tasks by id.',
            }
          : {}),
      };
    },
  },
  {
    name: 'claim_task',
    description: 'Assign an open task to yourself and start it, naming your model. Fails if someone else holds it.',
    inputSchema: schema({ project: PROJECT, task: TASK, model: MODEL, idempotency_key: IDEMPOTENCY }, [
      'project',
      'task',
      'idempotency_key',
    ]),
    annotations: WRITE,
    scope: SCOPES.write,
    async run(context, args) {
      only(args, ['project', 'task', 'model', 'idempotency_key']);
      const projectId = projectArg(args);
      const taskId = taskArg(args);
      const model = modelArg(args);
      keyArg(args);
      const { result } = await updateTask(
        context,
        projectId,
        taskId,
        { claim: true },
        model,
        retryRequest('claim_task', args),
      );
      return { task: mcpTask(result.task), replayed: result.replayed };
    },
  },
  {
    name: 'update_task',
    description:
      "Change a task's fields. Use close_task to close one and claim_task to take one. The result's lint names sections it still lacks.",
    inputSchema: schema(
      {
        project: PROJECT,
        task: TASK,
        status: { type: 'string', enum: STATUSES },
        priority: { type: 'integer', minimum: 0, maximum: 4 },
        title: { type: 'string', maxLength: TASK_LIMITS.title },
        description: { type: 'string', maxLength: TASK_LIMITS.description },
        assignee: { type: 'string' },
        parent: { type: 'string', description: 'A parent task id, or "" for none.' },
        defer: { type: 'string', description: 'YYYY-MM-DD to hide it until then, or "" to clear.' },
        acceptance: { type: 'string', maxLength: TASK_LIMITS.acceptance },
        add_labels: { type: 'array', items: { type: 'string' } },
        remove_labels: { type: 'array', items: { type: 'string' } },
        related: TASK_IDS('Add nonblocking related tasks in this workspace, including other projects.'),
        choices: {
          ...CHOICES,
          type: ['object', 'null'],
          description: 'A whole new set of choices, or null to take them off. Refused once a person has chosen.',
        },
        card: {
          ...CARD,
          type: ['object', 'null'],
          description: `A whole new card, or null to take it off. Refused once the task closed as done: its card then stays as it shipped. ${CARD.description}`,
        },
        change_class: {
          ...CHANGE_CLASS,
          type: ['string', 'null'],
          enum: [...TASK_CHANGE_CLASSES, null],
          description: `${CHANGE_CLASS.description} null takes it off.`,
        },
        idempotency_key: IDEMPOTENCY,
      },
      ['project', 'task', 'idempotency_key'],
    ),
    annotations: WRITE,
    scope: SCOPES.write,
    async run(context, args) {
      only(args, [
        'project',
        'task',
        'status',
        'priority',
        'title',
        'description',
        'assignee',
        'parent',
        'defer',
        'acceptance',
        'add_labels',
        'remove_labels',
        'choices',
        'card',
        'change_class',
        'related',
        'idempotency_key',
      ]);
      let related: string[] | undefined;
      if (args.related !== undefined) {
        if (!Array.isArray(args.related) || !args.related.length || args.related.length > TASK_LIMITS.links)
          refuse(`invalid arguments: related (1–${TASK_LIMITS.links} task ids)`);
        related = args.related.map((id: unknown) => taskArg({ task: id }));
      }
      const taskId = taskArg(args);
      const fields: TaskChange = {
        status: choiceArg(args, 'status', STATUSES),
        priority: priorityArg(args),
        title: textArg(args, 'title', TASK_LIMITS.title, false),
        description: textArg(args, 'description', TASK_LIMITS.description, false, true),
        assignee: assigneeArg(args),
        parent: args.parent === '' ? null : args.parent === undefined ? undefined : taskArg(args, 'parent'),
        defer: emptyIsNone(deferArg(args)),
        acceptance: textArg(args, 'acceptance', TASK_LIMITS.acceptance, false, true),
        addLabels: labelsArg(args, 'add_labels', 1),
        removeLabels: labelsArg(args, 'remove_labels', 1),
        related,
        choices: args.choices === null ? null : choicesArg(args),
        card: args.card === null ? null : cardArg(args),
        changeClass: args.change_class === null ? null : choiceArg(args, 'change_class', TASK_CHANGE_CLASSES),
      };
      const change = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      ) as TaskChange;
      if (Object.keys(change).length === 0) refuse('invalid arguments: name at least one field to change');
      setOrTakeOff(args, ['choices', 'card', 'change_class']);
      const projectId = projectArg(args);
      keyArg(args);
      const { project, result } = await updateTask(
        context,
        projectId,
        taskId,
        change,
        undefined,
        retryRequest('update_task', args),
      );
      return {
        task: mcpTask(result.task),
        replayed: result.replayed,
        lint: lintView(await lintOf(context, project.id, [result.task]), taskId, choiceAdvice(result.task)),
      };
    },
  },
  {
    name: 'comment_on_task',
    description: 'Add a comment to a task.',
    inputSchema: schema(
      {
        project: PROJECT,
        task: TASK,
        text: { type: 'string', maxLength: TASK_LIMITS.comment },
        idempotency_key: IDEMPOTENCY,
      },
      ['project', 'task', 'text', 'idempotency_key'],
    ),
    annotations: WRITE,
    scope: SCOPES.write,
    async run(context, args) {
      only(args, ['project', 'task', 'text', 'idempotency_key']);
      const projectId = projectArg(args);
      const taskId = taskArg(args);
      const text = textArg(args, 'text', TASK_LIMITS.comment, true)!;
      keyArg(args);
      const { comment, replayed } = await commentOnTask(
        context,
        projectId,
        taskId,
        text,
        retryRequest('comment_on_task', args),
      );
      return { comment: commentView(comment), replayed };
    },
  },
  {
    name: 'add_dependency',
    description:
      'Record that a task depends on another. A blocks dependency, the default, keeps the task out of ready work until the other is closed.',
    inputSchema: schema(
      {
        project: PROJECT,
        task: TASK,
        depends_on: { type: 'string', description: 'The task id it depends on.' },
        type: { type: 'string', enum: DEPENDENCY_TYPES, description: 'blocks (default), related or discovered-from.' },
      },
      ['project', 'task', 'depends_on'],
    ),
    annotations: WRITE,
    scope: SCOPES.write,
    async run(context, args) {
      only(args, ['project', 'task', 'depends_on', 'type']);
      const taskId = taskArg(args);
      const dependsOn = taskArg(args, 'depends_on');
      const type: DependencyType = choiceArg(args, 'type', DEPENDENCY_TYPES) ?? 'blocks';
      if (taskId === dependsOn) refuse('invalid arguments: a task cannot depend on itself');
      await addDependency(context, projectArg(args), taskId, dependsOn, type);
      return { task: taskId, dependsOn, type };
    },
  },
  {
    name: 'remove_dependency',
    description:
      'Remove a dependency between two tasks. One on a human gate or decision stays until a person decides it.',
    inputSchema: schema(
      { project: PROJECT, task: TASK, depends_on: { type: 'string', description: 'The task id it depends on.' } },
      ['project', 'task', 'depends_on'],
    ),
    annotations: Object.freeze({ ...WRITE, destructiveHint: true }),
    scope: SCOPES.write,
    async run(context, args) {
      only(args, ['project', 'task', 'depends_on']);
      const taskId = taskArg(args);
      const dependsOn = taskArg(args, 'depends_on');
      if (taskId === dependsOn) refuse('invalid arguments: a task cannot depend on itself');
      await removeDependency(context, projectArg(args), taskId, dependsOn);
      return { task: taskId, dependsOn, removed: true };
    },
  },
  {
    name: 'request_human_approval',
    description:
      'Ask a person to approve before a task proceeds. This opens a gate, a separate item ' +
      'that holds the task out of ready work until the owner approves its scope. Record an existing answer with reconcile_task. To ask without holding the task, comment ' +
      'on it instead. Asking again with the same reason returns the open request.',
    inputSchema: schema(
      {
        project: PROJECT,
        task: TASK,
        reason: { type: 'string', maxLength: GATE_REASON_MAX, description: 'What the person is asked to approve.' },
      },
      ['project', 'task', 'reason'],
    ),
    annotations: WRITE,
    scope: SCOPES.write,
    async run(context, args) {
      only(args, ['project', 'task', 'reason']);
      const taskId = taskArg(args);
      const projectId = projectArg(args);
      const reason = textArg(args, 'reason', GATE_REASON_MAX, true)!;
      const { gate, created } = await requestApproval(context, projectId, taskId, reason);
      return { task: taskId, ...approvalOf(taskId, gate), created };
    },
  },
  {
    name: 'close_task',
    description:
      'Close a task with the reason it is done, citing evidence such as a commit or URL, and naming your model. ' +
      'When nothing shipped, pass the resolution that says why; the reason still cites the evidence. ' +
      'A task it depends on may still be open; an approval it waits on must first be answered or retired. A declined action must not happen.',
    inputSchema: schema(
      {
        project: PROJECT,
        task: TASK,
        reason: { type: 'string', maxLength: TASK_LIMITS.reason },
        resolution: {
          type: 'string',
          enum: TASK_RESOLUTIONS,
          description:
            'How it ended: done (the default) when the work shipped; wont-do, ' +
            'duplicate, cant-reproduce or already-handled when nothing did.',
        },
        duplicate_of: {
          type: 'string',
          description:
            'With resolution duplicate: the id of the task in this project it duplicates. The two are linked as related.',
        },
        model: MODEL,
        idempotency_key: IDEMPOTENCY,
      },
      ['project', 'task', 'reason', 'idempotency_key'],
    ),
    annotations: WRITE,
    scope: SCOPES.write,
    async run(context, args) {
      only(args, ['project', 'task', 'reason', 'resolution', 'duplicate_of', 'model', 'idempotency_key']);
      const projectId = projectArg(args);
      const taskId = taskArg(args);
      const model = modelArg(args);
      const closing = closingArgs(args, taskId, 'duplicate_of');
      keyArg(args);
      const { result } = await closeTask(context, projectId, taskId, closing, model, retryRequest('close_task', args));
      return { task: mcpTask(result.task), replayed: result.replayed };
    },
  },
] satisfies TaskTool[]);

// ─── Object arguments sent as text ───────────────────────────────────────────

/** A property of a tool's input schema, as far as reading text needs it. */
interface PropertySchema {
  readonly type?: unknown;
  readonly properties?: Readonly<Record<string, PropertySchema>>;
  readonly items?: PropertySchema;
}
const typed = (property: PropertySchema, type: string) =>
  property.type === type || (Array.isArray(property.type) && property.type.includes(type));

/**
 * A tool's arguments with each object-typed one that arrived as a string read
 * as JSON: a client whose copy of the tool list predates an argument has no
 * schema for it and sends it as text. `text` names those read; `unread` those
 * whose text is not an object (or null, where the schema takes null), which
 * stay strings for their own check to refuse. Each entry of an array of
 * objects is read the same way, named by its place.
 */
export function objectsFromText(
  schemaOf: PropertySchema,
  args: Args,
  at = '',
): { readonly args: Args; readonly text: readonly string[]; readonly unread: readonly string[] } {
  const read: Args = { ...args };
  const text: string[] = [];
  const unread: string[] = [];
  for (const [name, property] of Object.entries(schemaOf.properties ?? {})) {
    const value = args[name];
    if (typed(property, 'object') && typeof value === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = undefined;
      }
      if (parsed === null ? typed(property, 'null') : typeof parsed === 'object' && !Array.isArray(parsed)) {
        read[name] = parsed;
        text.push(at + name);
      } else unread.push(at + name);
    } else if (typed(property, 'array') && property.items && typed(property.items, 'object') && Array.isArray(value)) {
      read[name] = value.map((entry: unknown, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        const inner = objectsFromText(property.items!, entry as Args, `${at}${name}[${index}].`);
        text.push(...inner.text);
        unread.push(...inner.unread);
        return inner.args;
      });
    }
  }
  return { args: read, text, unread };
}

/** What a reply or refusal says when object arguments arrived as text. */
export function staleClientLine(names: readonly string[], guideVersion: string): string {
  return (
    `${listed(names)} arrived as text: your client's copy of the task tools predates this server (guide version ${guideVersion}); ` +
    'reconnect this server to get the current tools'
  );
}
