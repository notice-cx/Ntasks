/**
 * The MCP tools that change tasks. Their names and arguments are the ones
 * NoticeOS's task tools had (scripts/hosted-task-mcp.mts there), with fewer
 * of them required, so agents written for those change Ntasks tasks
 * unchanged; test/api/write-tools.test.ts compares the schemas with
 * NoticeOS's own. Each tool runs one of the writes in task-writes.ts.
 *
 * A call that names a task needs no project: the task id's prefix names it
 * (project.ts). A write that would repeat its effect takes an optional
 * idempotency_key; without one, its own arguments key it (retryRequest), so
 * an interrupted call sent again is answered, not repeated. A dependency or
 * an approval request repeats harmlessly and takes none. A write answers with
 * the task's id, version and what it changed, or with the whole task when
 * asked for detail "full". A created or changed task comes back with what
 * lint finds missing, as advice: nothing is refused for it.
 */
import {
  DEPENDENCY_TYPES,
  EXTERNAL_LINK_KINDS,
  IDEMPOTENCY_KEY,
  lacksProof,
  TASK_LIMITS,
  TASK_RESOLUTIONS,
  WORK_LIMITS,
  type DependencyType,
  type Project,
  type Task,
  type TaskStatus,
} from '@ntasks/domain';
import {
  addsOrRemoves,
  assigneeArg,
  booleanArg,
  cardArg,
  choiceArg,
  choicesArg,
  closingArgs,
  deferArg,
  detailArg,
  emptyIsNone,
  estimateArg,
  externalLinksArg,
  fieldsArg,
  handoffMetadataArg,
  keyArg,
  labelsArg,
  modelArg,
  priorityArg,
  projectArg,
  listed,
  refuse,
  setOrTakeOff,
  taskArg,
  textArg,
  typeArg,
  urlsArg,
  workArgs,
  WRITABLE_TYPES,
  type Args,
  type WorkArgs,
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
  canonical,
  closeTask,
  commentOnTask,
  createTask,
  linkTasks,
  lintOf,
  lintView,
  OPEN_STATUSES,
  proofWarning,
  requestApproval,
  retryStanding,
  sha256,
  unblockedBy,
  updateTask,
  type NewLink,
  type NewTask,
  type RetryRequest,
  type TaskChange,
} from '../task-writes.ts';
import { reachable } from '../auth.ts';
import { linksSeenBy, projectOf } from '../lookup.ts';
import { commentView, mcpTask, writtenView, type McpTaskField } from '../views.ts';
import { pullRequestUrl, shippedArgs, type ProofNames } from '../delivery.ts';
import { possibleDuplicates } from '../similar.ts';
import { citationWarnings, TASK_TEXT } from './citations.ts';
import { projectFor, projectForNew } from './project.ts';
import { MANY, PROJECT, schema, TASK, TASKS, type TaskTool, type ToolContext } from './read-tools.ts';

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
const LINKS = Object.freeze([
  'depends_on',
  'blocks',
  'related',
  'discovered_from',
  'duplicates',
  'supersedes',
] as const);
/** The links update_task adds besides related: none holds the task out of ready work. */
const CHANGE_LINKS = Object.freeze(['related', 'duplicates', 'supersedes'] as const);
/** The names close_task gives the proof of a close as done. */
const PROOF: ProofNames = Object.freeze({ commit: 'commit', pr: 'pr', link: 'link' });

/** Optional on every write: the change is credited to this model as well as to the agent. */
export const MODEL = Object.freeze({
  type: 'string',
  maxLength: TASK_LIMITS.actor,
  description:
    'Optional: the name of the model you run as, as you would say it. The task records it beside your name, and the Agents page groups work by it.',
});
export const IDEMPOTENCY = Object.freeze({
  type: 'string',
  pattern: IDEMPOTENCY_KEY.source,
  description:
    'Optional: a key you choose for this call. Retrying with the same key and arguments never repeats the change. ' +
    'Without a key, an identical call repeats the first answer only while every task that answer wrote is unchanged since; a create also stops repeating after 24 hours.',
});
/** How much of the task a write's reply shows. */
export const DETAIL = Object.freeze({
  type: 'string',
  enum: ['full'],
  description:
    'full returns the whole task, as get_task shows it. Left out, the reply has the task id, its version and what changed.',
});
/** What a holder records about the work in hand, on a claim or a comment.
 * Each is one line, and a newer value replaces the older. */
const WORK = Object.freeze({
  for: {
    type: 'string',
    maxLength: TASK_LIMITS.helper,
    description:
      'The name of the helper agent working under you, such as page-rebuild-2. You stay the holder, and the task shows both, as "claude for page-rebuild-2".',
  },
  session: {
    type: 'string',
    maxLength: WORK_LIMITS.session,
    description: 'A link to, or the id of, the agent session doing the work.',
  },
  worktree: { type: 'string', maxLength: WORK_LIMITS.worktree, description: 'The worktree that holds the work.' },
  branch: { type: 'string', maxLength: WORK_LIMITS.branch, description: 'The branch that holds the work.' },
  pr: { type: 'string', maxLength: WORK_LIMITS.pr, description: "The pull request's URL." },
  commit: {
    type: 'string',
    maxLength: WORK_LIMITS.commit,
    description: 'The commit last tested, such as the one CI ran.',
  },
  next: {
    type: 'string',
    maxLength: WORK_LIMITS.next,
    description:
      'The next step, in one line. Each of these replaces the value before it, and closing or releasing the task clears them.',
  },
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
const NOTES = Object.freeze({
  type: 'string',
  maxLength: TASK_LIMITS.notes,
  description: 'Notes kept while working on it, such as progress and findings, in Markdown.',
});
const DESIGN = Object.freeze({
  type: 'string',
  maxLength: TASK_LIMITS.design,
  description: 'How it is to be built, in Markdown.',
});
const ESTIMATE = Object.freeze({
  type: 'integer',
  minimum: 0,
  maximum: TASK_LIMITS.estimateMinutes,
  description: 'How long it should take, in whole minutes.',
});
/** Links to pages outside Ntasks. */
const EXTERNAL_LINKS = Object.freeze({
  type: 'array',
  maxItems: TASK_LIMITS.externalLinks,
  description:
    'Pages outside Ntasks this task links to, such as a pull request or a document. A task links to a URL once.',
  items: schema(
    {
      url: {
        type: 'string',
        maxLength: TASK_LIMITS.externalLinkUrl,
        description: 'An http or https URL.',
      },
      title: {
        type: 'string',
        maxLength: TASK_LIMITS.externalLinkTitle,
        description: 'One line: the words shown for the link.',
      },
      kind: { type: 'string', enum: EXTERNAL_LINK_KINDS, description: 'What the page is.' },
    },
    ['url', 'title'],
  ),
});
/** Values of a project's custom fields, by key (list_fields lists them). */
const FIELDS = Object.freeze({
  type: 'object',
  maxProperties: TASK_LIMITS.fields,
  additionalProperties: { type: ['string', 'number', 'boolean', 'array'], items: { type: 'string' } },
  description:
    "Values of the project's custom fields, by key, as list_fields lists them: text, a number, a date as " +
    'YYYY-MM-DD, an option, a list of options, an http or https URL, or true or false, as the field takes.',
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
  notes: NOTES,
  design: DESIGN,
  estimate_minutes: ESTIMATE,
  depends_on: TASK_IDS('Tasks this one waits on: it is not ready until they close.'),
  blocks: TASK_IDS('Tasks that wait on this one.'),
  related: TASK_IDS('Tasks it relates to, without waiting on them; may name another project in this workspace.'),
  discovered_from: TASK_IDS('Tasks whose work turned this one up.'),
  duplicates: TASK_IDS(
    'Tasks this one duplicates: the same work, filed before. May name another project in this workspace.',
  ),
  supersedes: TASK_IDS('Tasks this one replaces. May name another project in this workspace.'),
  external_links: EXTERNAL_LINKS,
  fields: FIELDS,
  approval: {
    type: 'string',
    maxLength: GATE_REASON_MAX,
    description:
      'What a person must approve before it proceeds. Opens a gate that holds it out of ready work, as request_human_approval does.',
  },
  claim: { type: 'boolean', description: 'true files it claimed by you, in progress, as claim_task would.' },
  done: {
    type: 'object',
    additionalProperties: false,
    required: ['evidence'],
    description:
      'Files it closed as done by you, for work already finished: the evidence, and what proves it, as close_task takes them.',
    properties: {
      evidence: {
        type: 'string',
        maxLength: TASK_LIMITS.reason,
        description: 'What shipped and how you know: the reason close_task takes.',
      },
      commit: { type: 'string', description: 'The commit that holds the change.' },
      pr: { type: 'string', description: "The pull request's URL." },
      link: { type: 'string', description: 'For work no commit shows: a URL that shows it, such as a document.' },
    },
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

/** The links of a new task that stay in its project, so name its project as its parent does. */
const IN_PROJECT_LINKS = Object.freeze(['depends_on', 'blocks', 'discovered_from'] as const);

/** The task ids a new task names that stay in its project: its parent, then its links that do. */
function anchorsOf(entry: unknown): unknown[] {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
  const row = entry as Args;
  return [
    row.parent,
    ...IN_PROJECT_LINKS.flatMap((kind) => (Array.isArray(row[kind]) ? (row[kind] as unknown[]) : [])),
  ];
}

/**
 * The call's arguments as its retry record keeps them: all but the key, and
 * detail, which changes only how much the reply shows. A call without a key
 * of its own is keyed by its workspace, its sender, the tool and those
 * arguments, and that derived key answers the same call again only while
 * every task its answer wrote is unchanged since, and a create's for a day
 * (Retry.derived), so an interrupted call writes once and a repeat after a
 * change runs again.
 */
export async function retryRequest(context: ToolContext, operation: string, args: Args): Promise<RetryRequest> {
  const request: Args = { ...args };
  delete request.idempotency_key;
  delete request.detail;
  const given = keyArg(args);
  if (given !== undefined) return { operation, key: given, request };
  const key = `auto:${await sha256(
    canonical({ workspace: context.workspace.id, sender: context.principal.id, tool: operation, arguments: request }),
  )}`;
  return { operation, key, request, derived: true };
}

/** How specific each kind of link is. A task named in two kinds is linked
 * once, as the most specific; depends_on and blocks both hold a task back. */
const LINK_RANK: Readonly<Record<NewLink['kind'], number>> = Object.freeze({
  depends_on: 0,
  blocks: 0,
  discovered_from: 1,
  supersedes: 2,
  duplicates: 3,
  related: 4,
});

interface NamedLink<K extends NewLink['kind']> {
  readonly kind: K;
  readonly taskId: string;
  /** The argument that names it, such as related[0]. */
  readonly path: string;
}

/** The links a call names, each task once: a task named twice keeps its most
 * specific link, and `warnings` gets a sentence naming the one left out. */
function oncePerTask<K extends NewLink['kind']>(links: readonly NamedLink<K>[], warnings: string[]): NamedLink<K>[] {
  const kept = new Map<string, NamedLink<K>>();
  for (const link of links) {
    const standing = kept.get(link.taskId);
    if (standing === undefined) {
      kept.set(link.taskId, link);
      continue;
    }
    if (standing.kind !== link.kind && LINK_RANK[standing.kind] === 0 && LINK_RANK[link.kind] === 0)
      refuse(
        `invalid arguments: ${standing.path} and ${link.path} (this task cannot both wait on ${link.taskId} and block it)`,
      );
    const [keep, drop] = LINK_RANK[link.kind] < LINK_RANK[standing.kind] ? [link, standing] : [standing, link];
    kept.set(link.taskId, keep);
    warnings.push(
      `${drop.path} names ${link.taskId}, which ${keep.path} names too; it is linked once, as ${keep.kind}`,
    );
  }
  return [...kept.values()];
}

/** A new task's fields, from create_task or one entry of create_tasks.
 * `target` reads each task id it names, a parent or a linked task, by the
 * path that names it; `at` starts each path a refusal or warning names. */
function creation(args: Args, target: (path: string, value: unknown) => string, warnings: string[], at = ''): NewTask {
  const parent = args.parent === undefined ? undefined : target('parent', args.parent);
  const named: NamedLink<NewLink['kind']>[] = [];
  for (const kind of LINKS) {
    const value = args[kind];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > TASK_LIMITS.links)
      refuse(`invalid arguments: ${kind} (a list of at most ${TASK_LIMITS.links} task ids)`);
    value.forEach((id: unknown, index) => {
      const path = `${kind}[${index}]`;
      named.push({ kind, taskId: target(path, id), path: `${at}${path}` });
    });
  }
  if (named.length > TASK_LIMITS.links) refuse(`invalid arguments: at most ${TASK_LIMITS.links} linked tasks`);
  const links = oncePerTask(named, warnings);
  const linkedParent = parent === undefined ? undefined : links.find((link) => link.taskId === parent);
  if (linkedParent !== undefined)
    refuse(
      `invalid arguments: ${linkedParent.path} (${parent} is the parent already; leave it out of the other links)`,
    );
  const fields = {
    title: textArg(args, 'title', TASK_LIMITS.title, true)!,
    description: textArg(args, 'description', TASK_LIMITS.description, false, true),
    type: typeArg(args),
    priority: priorityArg(args),
    labels: labelsArg(args, 'labels'),
    parent,
    metadata: handoffMetadataArg(args),
    acceptance: textArg(args, 'acceptance', TASK_LIMITS.acceptance, false, true),
    notes: textArg(args, 'notes', TASK_LIMITS.notes, false, true),
    design: textArg(args, 'design', TASK_LIMITS.design, false, true),
    estimateMinutes: estimateArg(args, 'estimate_minutes'),
    links: links.length ? links : undefined,
    externalLinks: externalLinksArg(args, 'external_links'),
    fields: fieldsArg(args, 'fields'),
    choices: choicesArg(args),
    card: cardArg(args),
    changeClass: choiceArg(args, 'change_class', TASK_CHANGE_CLASSES),
    approval: textArg(args, 'approval', GATE_REASON_MAX, false),
    claim: booleanArg(args, 'claim') === true ? (true as const) : undefined,
    done: doneArg(args),
  };
  if (fields.claim && fields.done)
    refuse('invalid arguments: claim and done (a task filed done is closed; leave out claim)');
  if (fields.done && fields.approval !== undefined)
    refuse('invalid arguments: done and approval (a task that waits on an approval is not filed closed)');
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as unknown as NewTask;
}

/** A new task's close as done: its evidence, and the commit, pull request or link that proves it. */
function doneArg(args: Args): NewTask['done'] {
  const value = args.done;
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    refuse('invalid arguments: done (an object: evidence, and optionally commit, pr and link)');
  const done = value as Args;
  const unknown = Object.keys(done).filter((name) => !['evidence', 'commit', 'pr', 'link'].includes(name));
  if (unknown.length > 0)
    refuse(`invalid arguments: done (evidence, commit, pr and link only; not ${unknown.join(', ')})`);
  const named = Object.fromEntries(Object.entries(done).map(([name, entry]) => [`done.${name}`, entry]));
  return {
    reason: textArg(named, 'done.evidence', TASK_LIMITS.reason, true)!,
    ...shippedArgs(named, { commit: 'done.commit', pr: 'done.pr', link: 'done.link' }, 'done'),
  };
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
 * place, so a retried call replays each entry it already made, and for a
 * derived key the generation of the call's filing (batchGeneration). */
async function entryKey(key: string, index: number, generation = 0): Promise<string> {
  const call = generation === 0 ? key : `${key}:${generation}`;
  return `batch.${(await sha256(`noticeos-task-batch-v1:${call}`)).slice(0, 40)}.${index}`;
}

/**
 * The generation of a keyless create_tasks call's entry keys: the first whose
 * records all still answer or were never made. A call whose earlier filing
 * has a task changed since runs again as a new generation, so the whole batch
 * is filed again, never partly replayed; an entry refused before has no
 * record, so every entry is read.
 */
async function batchGeneration(
  context: ToolContext,
  project: Project,
  entries: number,
  entry: (generation: number, index: number) => Promise<RetryRequest>,
): Promise<number> {
  for (let generation = 0; ; generation += 1) {
    let stale = false;
    for (let index = 0; !stale && index < entries; index += 1)
      stale = (await retryStanding(context, project, await entry(generation, index))) === 'stale';
    if (!stale) return generation;
  }
}

/**
 * The retry record of one task of a call that names several in `tasks`:
 * under the call's own key and the task, or for a keyless call under the key
 * the same call naming that task alone would have, so either answers for the other.
 */
async function eachRetry(context: ToolContext, operation: string, args: Args, taskId: string): Promise<RetryRequest> {
  const single: Args = { ...args, task: taskId };
  delete single.tasks;
  const given = keyArg(args);
  if (given === undefined) return retryRequest(context, operation, single);
  delete single.idempotency_key;
  delete single.detail;
  const call = (await sha256(`ntasks-each-task-v1:${operation}:${given}`)).slice(0, 32);
  return { operation, key: `each.${call}.${taskId}`, request: single };
}

/** The task ids a call names: `task`, or `tasks`, each once. */
function tasksNamed(args: Args): { readonly one: boolean; readonly ids: readonly string[] } {
  if (args.task !== undefined && args.tasks !== undefined)
    refuse('invalid arguments: task and tasks (name one task with task, or several with tasks)');
  if (args.tasks === undefined) return { one: true, ids: [taskArg(args)] };
  const value = args.tasks;
  if (!Array.isArray(value) || value.length < 1 || value.length > MANY)
    refuse(`invalid arguments: tasks (1–${MANY} task ids)`);
  return {
    one: false,
    ids: [...new Set(value.map((id: unknown, index) => taskArg({ [`tasks[${index}]`]: id }, `tasks[${index}]`)))],
  };
}

/** Runs `work` on each task in turn; a task refused gets its sentence as its result, and the rest still run. */
async function eachTask<T>(
  ids: readonly string[],
  work: (id: string) => Promise<T>,
  key: 'id' | 'task' = 'id',
): Promise<(T | Record<string, string>)[]> {
  const results: (T | Record<string, string>)[] = [];
  for (const id of ids) {
    try {
      results.push(await work(id));
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      results.push({ [key]: id, error: error.message });
    }
  }
  return results;
}

/** A write's answer about a task: with detail "full" the whole task, as
 * get_task shows it; otherwise its id, the fields `named` lists and its
 * version. Either way without links the sender may not see. */
async function written(
  context: ToolContext,
  detail: 'full' | undefined,
  task: Task,
  named: readonly McpTaskField[],
  replayed: boolean,
): Promise<Record<string, unknown>> {
  const seen = detail === 'full' || named.includes('dependencies') ? (await linksSeenBy(context)).task(task) : task;
  return detail === 'full' ? { task: mcpTask(seen), replayed } : { ...writtenView(seen, named), replayed };
}

/** The fields of the task a claim's answer shows for the helper and work details it names. */
function workShown(work: WorkArgs | undefined): McpTaskField[] {
  return [
    ...(work?.assigneeFor === undefined ? [] : ['for' as const]),
    ...(work?.work === undefined ? [] : ['work' as const]),
  ];
}

/** The fields a new task's answer shows: its status, and who holds it and how it closed when filed so. */
function filedShown(task: Task): McpTaskField[] {
  return [
    'status',
    ...(task.assignee === null ? [] : ['assignee' as const]),
    ...(task.close === null ? [] : ['resolution' as const]),
    ...(task.delivery === null ? [] : ['delivery' as const]),
  ];
}

/** The fields a close's answer shows: what it closed with, and where the change is when it records that. */
function closeShown(task: Task): McpTaskField[] {
  return ['status', 'resolution', ...(task.delivery === null ? [] : ['delivery' as const])];
}

/** Lint's answer, when it names a missing section or gives advice. */
function lintIfAny(view: Record<string, readonly string[]> | null): { lint?: Record<string, readonly string[]> } {
  return view !== null && Object.values(view).some((entries) => entries.length > 0) ? { lint: view } : {};
}

/** The project's open tasks, read once for a call that files tasks there, to find possible duplicates. */
async function openTasksOf(context: ToolContext, projectId: string): Promise<readonly Task[]> {
  return context.engine.listBoard(projectId, { statuses: OPEN_STATUSES, withoutExternalLinks: true });
}

/** A new task's possible duplicates among `open`, when it has any. */
function duplicatesIfAny(task: Task, open: readonly Task[], filed: ReadonlySet<string>) {
  const found = possibleDuplicates(task.title, open, filed);
  return found.length > 0 ? { possibleDuplicates: found } : {};
}

/** The sentences for tasks closed as done without proof, naming the argument that takes it. */
function proofWarnings(tasks: readonly Task[], takes: string): string[] {
  return tasks.filter(lacksProof).map((task) => proofWarning(task.id, takes));
}

/** A refusal of one create_tasks entry, naming the argument by its path from the call. */
function inEntry(message: string, index: number): string {
  const rest = message.replace(/^invalid arguments: /u, '');
  if (rest === message || rest.startsWith('tasks[')) return message;
  const first = /^[a-z_]+/u.exec(rest)?.[0];
  return first !== undefined && CREATE_FIELDS.includes(first)
    ? `invalid arguments: tasks[${index}].${rest}`
    : `invalid arguments: tasks[${index}]: ${rest}`;
}

/** The task ids an entry of create_tasks names: a task's id, or #n for the
 * call's task at place n, counting from zero, earlier or later. */
function placeOrId(index: number, count: number): (path: string, value: unknown) => string {
  return (path, value) => {
    const place = typeof value === 'string' ? /^#(\d{1,2})$/u.exec(value) : null;
    if (!place) return taskArg({ [path]: value }, path);
    const named = Number(place[1]);
    if (named === index) refuse(`invalid arguments: ${path} (#${named} is this task itself)`);
    if (named >= count)
      refuse(
        `invalid arguments: ${path} (#${named} names no task of this call: #n counts its ${count} tasks from zero, #0 to #${count - 1})`,
      );
    return value as string;
  };
}

/** The places of the call's tasks a planned entry names with #n. */
function placesNamed(task: NewTask): number[] {
  const named = [task.parent, ...(task.links ?? []).map((link) => link.taskId)];
  return [...new Set(named.filter((id) => id?.startsWith('#')).map((id) => Number(id!.slice(1))))];
}

/**
 * The order to file a call's tasks in: each after the tasks it names with
 * #n, otherwise in the call's order. Tasks that name each other in a loop are
 * refused, each with the loop; a task that names a refused one is refused
 * when its turn comes.
 */
function filingOrder(planned: readonly (NewTask | null)[]): {
  readonly order: number[];
  readonly loops: Map<number, string>;
} {
  const names = planned.map((task) => (task === null ? [] : placesNamed(task)));
  const order: number[] = [];
  const placed = new Set<number>();
  for (let progress = true; progress;) {
    progress = false;
    for (const [index, named] of names.entries()) {
      if (placed.has(index) || !named.every((place) => placed.has(place))) continue;
      order.push(index);
      placed.add(index);
      progress = true;
      break;
    }
  }
  const loops = new Map<number, string>();
  const left = names.map((_, index) => index).filter((index) => !placed.has(index));
  for (const start of left) {
    // The shortest way from this task back to itself, if it lies on a loop.
    const from = new Map<number, number>();
    const queue = [start];
    let back: number | undefined;
    while (queue.length > 0 && back === undefined) {
      const at = queue.shift()!;
      for (const next of names[at]!) {
        if (next === start) back = at;
        else if (!from.has(next) && !placed.has(next)) {
          from.set(next, at);
          queue.push(next);
        }
        if (back !== undefined) break;
      }
    }
    if (back === undefined) continue;
    const path = [start];
    for (let at = back; at !== start; at = from.get(at)!) path.splice(1, 0, at);
    loops.set(
      start,
      `refused: tasks[${start}] names tasks of this call that name it back (${[...path, start].map((place) => `#${place}`).join(' → ')}), ` +
        'so none of them can be filed first; name the earlier task from the later one only.',
    );
  }
  return { order: [...order, ...left], loops };
}

/**
 * The open task a pull request names, for a claim that names no task: the one
 * whose work details or pull-request link name it, in the project the call
 * names or every project the sender reaches. None, or several, is refused.
 */
async function taskOfPullRequest(context: ToolContext, args: Args, pr: string): Promise<string> {
  const { engine, principal } = context;
  const wanted = pullRequestUrl(pr) ?? pr;
  const scope = args.project === undefined ? null : (await projectOf(context, projectArg(args))).id;
  const reached = new Set(reachable(principal, await engine.listProjects()).map((project) => project.id));
  const names = (url: string | undefined) => url !== undefined && pullRequestUrl(url) === wanted;
  const matches = (await engine.listBoard(scope, { statuses: OPEN_STATUSES }))
    .filter((task) => reached.has(task.projectId))
    .filter(
      (task) =>
        names(task.work.pr) || task.externalLinks.some((link) => link.kind === 'pull-request' && names(link.url)),
    )
    .map((task) => task.id);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0)
    refuse(
      `refused: no open task names pull request ${wanted} in its work details or pull-request links; name the task with task.`,
      'not_found',
    );
  refuse(
    `refused: pull request ${wanted} names ${matches.length} open tasks, ${listed(matches)}; name one with task.`,
    'state',
  );
}

/** Every open task under `taskId`, deepest first, so each closes before its parent. */
async function openUnder(context: ToolContext, projectId: string, taskId: string): Promise<string[]> {
  const children = await context.engine.listBoard(projectId, {
    statuses: OPEN_STATUSES,
    parentId: taskId,
    withoutExternalLinks: true,
  });
  const under: string[] = [];
  for (const child of children) under.push(...(await openUnder(context, projectId, child.id)), child.id);
  return under;
}

/** The field of the task update_task's reply shows for each argument it
 * takes; null for long text, which the reply leaves out, and the arguments
 * that name the call. */
const SHOWN_CHANGES: Readonly<Record<string, McpTaskField | null>> = Object.freeze({
  project: null,
  task: null,
  status: 'status',
  priority: 'priority',
  title: 'title',
  description: null,
  assignee: 'assignee',
  parent: 'parent',
  defer: 'deferUntil',
  acceptance: null,
  notes: null,
  design: null,
  estimate_minutes: 'estimateMinutes',
  add_labels: 'labels',
  remove_labels: 'labels',
  related: 'dependencies',
  duplicates: 'dependencies',
  supersedes: 'dependencies',
  add_external_links: 'externalLinks',
  remove_external_links: 'externalLinks',
  fields: 'fields',
  choices: 'choices',
  card: 'card',
  change_class: 'changeClass',
});

/** The project of a new task, as create_task and create_tasks describe it. */
const NEW_PROJECT = Object.freeze({
  ...PROJECT,
  description:
    'Optional: the projectId, key or prefix from list_projects. Left out, the task goes to the project of its parent ' +
    '(or of a task it depends on, blocks or was found from), else to the one project you may file in.',
});

const UPDATE_TASK: TaskTool = Object.freeze({
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
      notes: NOTES,
      design: DESIGN,
      estimate_minutes: {
        ...ESTIMATE,
        type: ['integer', 'null'],
        description: `${ESTIMATE.description} null takes it off.`,
      },
      add_labels: { type: 'array', items: { type: 'string' } },
      remove_labels: { type: 'array', items: { type: 'string' } },
      related: TASK_IDS('Add nonblocking related tasks in this workspace, including other projects.'),
      duplicates: TASK_IDS(
        'Add tasks this one duplicates: the same work, filed before. May name another project in this workspace.',
      ),
      supersedes: TASK_IDS('Add tasks this one replaces. May name another project in this workspace.'),
      add_external_links: {
        ...EXTERNAL_LINKS,
        minItems: 1,
        description: `${EXTERNAL_LINKS.description} A link to a URL the task has already takes the new title and kind.`,
      },
      fields: {
        ...FIELDS,
        additionalProperties: { type: ['string', 'number', 'boolean', 'array', 'null'], items: { type: 'string' } },
        description: `${FIELDS.description} null takes a value off.`,
      },
      remove_external_links: {
        type: 'array',
        minItems: 1,
        maxItems: TASK_LIMITS.externalLinks,
        items: { type: 'string', maxLength: TASK_LIMITS.externalLinkUrl },
        description: 'The URLs of external links to take off.',
      },
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
      model: MODEL,
      idempotency_key: IDEMPOTENCY,
      detail: DETAIL,
    },
    ['task'],
  ),
  annotations: WRITE,
  scope: SCOPES.write,
  async run(context, args) {
    const named: NamedLink<(typeof CHANGE_LINKS)[number]>[] = [];
    for (const name of CHANGE_LINKS) {
      const value = args[name];
      if (value === undefined) continue;
      if (!Array.isArray(value) || !value.length || value.length > TASK_LIMITS.links)
        refuse(`invalid arguments: ${name} (1–${TASK_LIMITS.links} task ids)`);
      value.forEach((id: unknown, index) => {
        const path = `${name}[${index}]`;
        named.push({ kind: name, taskId: taskArg({ [path]: id }, path), path });
      });
    }
    const warnings: string[] = [];
    const linked: Partial<Record<(typeof CHANGE_LINKS)[number], string[]>> = {};
    for (const link of oncePerTask(named, warnings)) (linked[link.kind] ??= []).push(link.taskId);
    warnings.push(...citationWarnings(args, TASK_TEXT));
    const addExternalLinks = externalLinksArg(args, 'add_external_links', 1);
    const removeExternalLinks = urlsArg(args, 'remove_external_links');
    addsOrRemoves(addExternalLinks, removeExternalLinks, 'add_external_links and remove_external_links');
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
      notes: textArg(args, 'notes', TASK_LIMITS.notes, false, true),
      design: textArg(args, 'design', TASK_LIMITS.design, false, true),
      estimateMinutes: estimateArg(args, 'estimate_minutes', true),
      addLabels: labelsArg(args, 'add_labels', 1),
      removeLabels: labelsArg(args, 'remove_labels', 1),
      ...linked,
      addExternalLinks,
      removeExternalLinks,
      fields: fieldsArg(args, 'fields', true),
      choices: args.choices === null ? null : choicesArg(args),
      card: args.card === null ? null : cardArg(args),
      changeClass: args.change_class === null ? null : choiceArg(args, 'change_class', TASK_CHANGE_CLASSES),
    };
    const change = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as TaskChange;
    if (Object.keys(change).length === 0) refuse('invalid arguments: name at least one field to change');
    setOrTakeOff(args, ['choices', 'card', 'change_class']);
    const model = modelArg(args);
    const detail = detailArg(args);
    const retry = await retryRequest(context, 'update_task', args);
    const projectId = await projectFor(context, args, taskId);
    const { project, result } = await updateTask(context, projectId, taskId, change, model, retry);
    const shown = Object.keys(args).flatMap((name) =>
      Object.hasOwn(SHOWN_CHANGES, name) && SHOWN_CHANGES[name] !== null ? [SHOWN_CHANGES[name]!] : [],
    );
    return {
      ...(await written(context, detail, result.task, shown, result.replayed)),
      ...lintIfAny(lintView(await lintOf(context, project.id, [result.task]), taskId, choiceAdvice(result.task))),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
} satisfies TaskTool);

const REQUEST_HUMAN_APPROVAL: TaskTool = Object.freeze({
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
      model: MODEL,
    },
    ['task', 'reason'],
  ),
  annotations: WRITE,
  scope: SCOPES.write,
  async run(context, args) {
    const taskId = taskArg(args);
    const reason = textArg(args, 'reason', GATE_REASON_MAX, true)!;
    const model = modelArg(args);
    const projectId = await projectFor(context, args, taskId);
    const { gate, created } = await requestApproval(context, projectId, taskId, reason, model);
    return { task: taskId, ...approvalOf(taskId, gate), created };
  },
} satisfies TaskTool);

export const WRITE_TOOLS: readonly TaskTool[] = Object.freeze([
  {
    name: 'create_task',
    description:
      'Create a task in a project, with its links; claim: true files it claimed by you, and done files finished work closed. ' +
      "The answer's possibleDuplicates names open tasks whose titles share most words with it, and lint the sections it still lacks. " +
      'create_tasks files many in one call.',
    inputSchema: schema(
      { project: NEW_PROJECT, ...NEW_TASK, model: MODEL, idempotency_key: IDEMPOTENCY, detail: DETAIL },
      ['title'],
    ),
    annotations: WRITE,
    scope: SCOPES.write,
    async run(context, args) {
      const warnings: string[] = [];
      const task = creation(args, (path, value) => taskArg({ [path]: value }, path), warnings);
      warnings.push(...newTaskCitations(args));
      const model = modelArg(args);
      const detail = detailArg(args);
      const retry = await retryRequest(context, 'create_task', args);
      const named = await projectOf(context, await projectForNew(context, args, anchorsOf(args)), 'write');
      const open = await openTasksOf(context, named.id);
      const { project, result } = await createTask(context, named.id, task, model, retry);
      const id = result.task.id;
      const gate = result.created[0];
      return {
        ...(await written(context, detail, result.task, filedShown(result.task), result.replayed)),
        ...(gate === undefined ? {} : approvalOf(id, gate)),
        ...(task.done === undefined
          ? lintIfAny(lintView(await lintOf(context, project.id, [result.task]), id, choiceAdvice(result.task)))
          : {}),
        ...duplicatesIfAny(result.task, open, new Set([id])),
        ...withWarnings([...warnings, ...proofWarnings([result.task], 'done')]),
      };
    },
  },
  {
    name: 'create_tasks',
    description:
      `Create up to ${BATCH} tasks in one call, each with create_task's fields. A parent or link may name another ` +
      'task of the same call by its place, counting from zero: #0 for the first, #1 for the second, earlier or later. ' +
      'The answer has a result per task, in the call’s order: a task refused does not stop the rest, and the same call sent again never files one twice.',
    inputSchema: schema(
      {
        project: NEW_PROJECT,
        tasks: { type: 'array', minItems: 1, maxItems: BATCH, items: schema(NEW_TASK, ['title']) },
        model: MODEL,
        idempotency_key: IDEMPOTENCY,
      },
      ['tasks'],
    ),
    annotations: WRITE,
    scope: SCOPES.write,
    async run(context, args) {
      const entries = args.tasks;
      const model = modelArg(args);
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > BATCH)
        refuse(`invalid arguments: tasks (1–${BATCH})`);
      const warnings: string[] = [];
      const results: Record<string, unknown>[] = [];
      // Each entry is read on its own: one that breaks a rule is refused alone.
      const planned = entries.map((entry: unknown, index): NewTask | null => {
        try {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            refuse(`invalid arguments: tasks[${index}] (a task: an object with a title)`);
          return creation(entry as Args, placeOrId(index, entries.length), warnings, `tasks[${index}].`);
        } catch (error) {
          if (!(error instanceof Refused)) throw error;
          results[index] = { index, error: inEntry(error.message, index) };
          return null;
        }
      });
      warnings.push(
        ...entries.flatMap((entry: unknown, index) =>
          entry !== null && typeof entry === 'object' && !Array.isArray(entry)
            ? newTaskCitations(entry as Args, `tasks[${index}].`)
            : [],
        ),
      );
      const { order, loops } = filingOrder(planned);
      const retry = await retryRequest(context, 'create_tasks', args);
      const project = await projectOf(context, await projectForNew(context, args, entries.flatMap(anchorsOf)), 'write');
      const entry = async (generation: number, index: number): Promise<RetryRequest> => ({
        operation: 'create_tasks',
        key: await entryKey(retry.key, index, generation),
        request: { project: project.id, task: entries[index] as unknown, model: model ?? null },
        ...(retry.derived === true ? { derived: true } : {}),
      });
      const generation = retry.derived === true ? await batchGeneration(context, project, entries.length, entry) : 0;
      const open = await openTasksOf(context, project.id);
      const filed = new Map<number, { task: Task; replayed: boolean; gate: Task | undefined; done: boolean }>();
      const idOf = (id: string) => (id.startsWith('#') ? filed.get(Number(id.slice(1)))!.task.id : id);
      for (const index of order) {
        const task = planned[index];
        if (task === null || task === undefined) continue;
        const loop = loops.get(index);
        const missing = placesNamed(task).find((place) => !filed.has(place));
        if (loop !== undefined || missing !== undefined) {
          results[index] = {
            index,
            error:
              loop ?? `refused: tasks[${index}] names #${missing}, which was not filed, so it was not filed either.`,
          };
          continue;
        }
        const resolved: NewTask = {
          ...task,
          ...(task.parent === undefined ? {} : { parent: idOf(task.parent) }),
          ...(task.links === undefined
            ? {}
            : { links: task.links.map((link) => ({ kind: link.kind, taskId: idOf(link.taskId) })) }),
        };
        try {
          const { result } = await createTask(context, project.id, resolved, model, await entry(generation, index));
          filed.set(index, {
            task: result.task,
            replayed: result.replayed,
            gate: result.created[0],
            done: task.done !== undefined,
          });
        } catch (error) {
          if (!(error instanceof Refused)) throw error;
          results[index] = { index, error: error.message };
        }
      }
      const tasks = [...filed.values()];
      const found = await lintOf(
        context,
        project.id,
        tasks.filter((made) => !made.done).map((made) => made.task),
      );
      const ids = new Set(tasks.map((made) => made.task.id));
      for (const [index, { task, replayed, gate, done }] of filed) {
        results[index] = {
          index,
          ...writtenView(task, filedShown(task)),
          replayed,
          ...(gate === undefined
            ? {}
            : { approval: { id: gate.id, status: gate.status, reason: gateReason(gate.description) }, held: true }),
          ...(done ? {} : lintIfAny(lintView(found, task.id, choiceAdvice(task)))),
          ...duplicatesIfAny(task, open, ids),
        };
      }
      const refused = results.some((result) => 'error' in result);
      return {
        results,
        ...(tasks.some((made) => made.gate !== undefined)
          ? {
              note: 'A task with an approval waits for the owner’s scoped approval. Record an existing answer with reconcile_task.',
            }
          : {}),
        ...withWarnings([
          ...warnings,
          ...proofWarnings(
            tasks.filter((made) => made.done).map((made) => made.task),
            'done',
          ),
        ]),
        ...(refused
          ? {
              retry:
                'Send the same call again to finish after an unavailable task; tasks already filed are not filed again. ' +
                'To change a refused task, send it in a new call, naming filed tasks by id.',
            }
          : {}),
      };
    },
  },
  {
    name: 'claim_task',
    description:
      'Assign an open task to yourself and start it. Fails if someone else holds it. ' +
      'Without task, pr names it: the open task whose work details or pull-request link name that pull request.',
    inputSchema: schema({
      project: PROJECT,
      task: { ...TASK, description: 'The task id, such as abc-1x2. Leave it out to claim by pr.' },
      model: MODEL,
      ...WORK,
      idempotency_key: IDEMPOTENCY,
      detail: DETAIL,
    }),
    annotations: WRITE,
    scope: SCOPES.write,
    async run(context, args) {
      const model = modelArg(args);
      const work = workArgs(args);
      const detail = detailArg(args);
      const pr = work?.work?.pr;
      if (args.task === undefined && pr === undefined)
        refuse('invalid arguments: task (required, or pr naming the pull request of the open task to claim)');
      const taskId = args.task === undefined ? await taskOfPullRequest(context, args, pr!) : taskArg(args);
      const retry = await retryRequest(context, 'claim_task', args);
      const projectId = await projectFor(context, args, taskId);
      const { result } = await updateTask(context, projectId, taskId, { claim: true, ...work }, model, retry);
      return written(context, detail, result.task, ['status', 'assignee', ...workShown(work)], result.replayed);
    },
  },
  UPDATE_TASK,
  {
    name: 'comment_on_task',
    description: `Add a comment to a task, or the same comment to up to ${MANY} with tasks, such as one check that covers them all.`,
    inputSchema: schema(
      {
        project: PROJECT,
        task: TASK,
        tasks: TASKS('comment on'),
        text: { type: 'string', maxLength: TASK_LIMITS.comment },
        model: MODEL,
        ...WORK,
        idempotency_key: IDEMPOTENCY,
        detail: { ...DETAIL, description: 'full returns the whole comment. Left out, the reply has its id.' },
      },
      ['text'],
    ),
    annotations: WRITE,
    scope: SCOPES.write,
    async run(context, args) {
      const { one, ids } = tasksNamed(args);
      const text = textArg(args, 'text', TASK_LIMITS.comment, true)!;
      const model = modelArg(args);
      const work = workArgs(args);
      const detail = detailArg(args);
      const comment = async (taskId: string, retry: RetryRequest) => {
        const projectId = await projectFor(context, args, taskId);
        const { comment, replayed } = await commentOnTask(context, projectId, taskId, text, retry, work, model);
        return detail === 'full'
          ? { comment: commentView(comment), replayed }
          : { task: taskId, commentId: comment.id, replayed };
      };
      if (one) return comment(ids[0]!, await retryRequest(context, 'comment_on_task', args));
      return {
        results: await eachTask(
          ids,
          async (taskId) => ({
            task: taskId,
            ...(await comment(taskId, await eachRetry(context, 'comment_on_task', args, taskId))),
          }),
          'task',
        ),
      };
    },
  },
  {
    name: 'link_tasks',
    description:
      'Set the one link between two tasks, replacing the kind it had, or remove it with remove: true. ' +
      'type names how task links to to: blocks (task waits on to and is not ready until to closes), related, ' +
      "discovered-from (task was found from to's work), duplicates (task is the same work as to, filed later) or " +
      'supersedes (task replaces to). A link to or from a person’s decision changes only when the person decides.',
    inputSchema: schema(
      {
        project: PROJECT,
        task: TASK,
        to: {
          type: 'string',
          description: 'The other task id. related, duplicates and supersedes may name another project.',
        },
        type: { type: 'string', enum: DEPENDENCY_TYPES, description: 'How task links to to.' },
        remove: { type: 'boolean', description: 'true removes the link between the two, whichever way it points.' },
        model: MODEL,
      },
      ['task', 'to'],
    ),
    annotations: Object.freeze({ ...WRITE, destructiveHint: true }),
    scope: SCOPES.write,
    async run(context, args) {
      const taskId = taskArg(args);
      const to = taskArg(args, 'to');
      if (taskId === to) refuse('invalid arguments: to (another task than this one)');
      const remove = booleanArg(args, 'remove') === true;
      const type: DependencyType | undefined = choiceArg(args, 'type', DEPENDENCY_TYPES);
      if (remove === (type !== undefined))
        refuse('invalid arguments: type (the kind of link to set), or remove: true to remove it; one of the two');
      const model = modelArg(args);
      const projectId = await projectFor(context, args, taskId);
      const { replaced } = await linkTasks(context, projectId, taskId, to, type ?? null, model);
      return type === undefined
        ? { task: taskId, to, removed: true }
        : { task: taskId, to, type, ...(replaced === null ? {} : { replaced }) };
    },
  },
  REQUEST_HUMAN_APPROVAL,
  {
    name: 'close_task',
    description:
      'Close a task with the reason it is done, citing evidence, and pass commit, pr or link as its proof. ' +
      `tasks closes up to ${MANY} with the same evidence, and with_children closes an epic's open tasks first; ` +
      'a task nobody holds is recorded as yours. The answer lists unblocked: tasks these closes made ready. ' +
      'When nothing shipped, pass the resolution that says why; the reason still cites the evidence. ' +
      'An approval the task waits on must first be answered or retired. A declined action must not happen.',
    inputSchema: schema(
      {
        project: PROJECT,
        task: TASK,
        tasks: TASKS('close with the same reason'),
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
        commit: {
          type: 'string',
          description:
            "With done: the commit that holds the change; left out, the commit your work details name. The task's delivery starts at built, and report_delivery moves it to merged and live.",
        },
        pr: {
          type: 'string',
          description:
            "With done: the pull request's URL; left out, the pr your work details name. The task's delivery starts at built, as with commit.",
        },
        link: {
          type: 'string',
          description: 'With done, for work no commit or pull request shows: a URL that shows it, such as a document.',
        },
        with_children: {
          type: 'boolean',
          description: 'true closes every open task under each one named first, with the same reason and proof.',
        },
        model: MODEL,
        idempotency_key: IDEMPOTENCY,
        detail: DETAIL,
      },
      ['reason'],
    ),
    annotations: WRITE,
    scope: SCOPES.write,
    async run(context, args) {
      const { one, ids } = tasksNamed(args);
      const model = modelArg(args);
      const given = closingArgs(args, one ? ids[0]! : '', 'duplicate_of');
      if (given.duplicateOf !== undefined && ids.includes(given.duplicateOf))
        refuse('invalid arguments: duplicate_of (another task than the ones closing)');
      const closing = { ...given, ...shippedArgs(args, PROOF, given.resolution) };
      const withChildren = booleanArg(args, 'with_children') === true;
      const detail = detailArg(args);
      const closed: Task[] = [];
      const close = async (taskId: string, retry: RetryRequest) => {
        const projectId = await projectFor(context, args, taskId);
        const { result } = await closeTask(context, projectId, taskId, closing, model, retry);
        closed.push(result.task);
        return written(context, detail, result.task, closeShown(result.task), result.replayed);
      };
      if (one && !withChildren) {
        return {
          ...(await close(ids[0]!, await retryRequest(context, 'close_task', args))),
          unblocked: await unblockedBy(context, closed),
          ...withWarnings([...citationWarnings(args, ['reason']), ...proofWarnings(closed, 'close_task')]),
        };
      }
      // An epic's open tasks close before it, deepest first; a task named twice closes once.
      const order: string[] = [];
      const refusedFirst: Record<string, string>[] = [];
      for (const id of ids) {
        if (withChildren) {
          try {
            order.push(...(await openUnder(context, await projectFor(context, args, id), id)));
          } catch (error) {
            if (!(error instanceof Refused)) throw error;
            refusedFirst.push({ id, error: error.message });
            continue;
          }
        }
        order.push(id);
      }
      const once = [...new Set(order)].filter((id) => !refusedFirst.some((entry) => entry.id === id));
      const results = [
        ...refusedFirst,
        ...(await eachTask(once, async (taskId) => ({
          id: taskId,
          ...(await close(taskId, await eachRetry(context, 'close_task', args, taskId))),
        }))),
      ];
      return {
        results,
        unblocked: await unblockedBy(context, closed),
        ...withWarnings([...citationWarnings(args, ['reason']), ...proofWarnings(closed, 'close_task')]),
      };
    },
  },
] satisfies TaskTool[]);

/** The citation warnings of a new task's text, and of the evidence it is filed done with, as `at` names it. */
function newTaskCitations(entry: Args, at = ''): string[] {
  const done = entry.done;
  return [
    ...citationWarnings(entry, TASK_TEXT, at),
    ...(done !== null && typeof done === 'object' && !Array.isArray(done)
      ? citationWarnings(done as Args, ['evidence'], `${at}done.`)
      : []),
  ];
}

/** Warnings, when there are any. */
function withWarnings(warnings: readonly string[]): { warnings?: readonly string[] } {
  return warnings.length > 0 ? { warnings } : {};
}

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
