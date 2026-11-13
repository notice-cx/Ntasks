/**
 * The task writes the MCP tools and the HTTP routes share. Each checks that
 * its sender may change the project, keeps the rules NoticeOS's task
 * operations kept (scripts/hosted-task-command.mts and
 * hosted-task-operations.mts in NoticeOS), and makes the change in one engine
 * call, so the change, its history and its retry record land together or not
 * at all. A refusal carries NoticeOS's sentence for an agent and a shorter
 * one for a person.
 */
import {
  canQueueNext,
  closedByNtasks,
  KEEP_OPEN,
  NEXT_LABEL,
  TASK_LIMITS,
  TASK_STATUSES,
  TaskRefused,
  WORK_DETAILS,
  type ActionRequest,
  type Actor,
  type ApprovalRequest,
  type CommentPins,
  type CreateTaskInput,
  type CustomField,
  type DefineFieldInput,
  type DeliverySignal,
  type DependencyType,
  type ExternalLink,
  type FieldValue,
  type JsonObject,
  type MoveResult,
  type NewTaskLink,
  type Project,
  type Retry,
  type Task,
  type TaskComment,
  type TaskPlacement,
  type TaskResolution,
  type TaskStatus,
  type TaskTestResult,
  type TaskType,
  type TaskWrite,
  type WorkDetail,
  type WriteResult,
} from '@ntasks/domain';
import { listed, type WorkArgs } from './args.ts';
import { closeProof, gatedPullRequest, pullRequestUrl } from './delivery.ts';
import { mayReach, reachable, type Principal } from './auth.ts';
import { fieldFilters, fieldValues } from './engine/validate.ts';
import { ownerOf, projectNamed, projectOf, projectOfTask, taskOf, tasksIn, type Reader } from './lookup.ts';
import {
  asksAlike,
  choiceName,
  NOTICEOS_METADATA,
  readCardShipped,
  recordedCard,
  shippedCard,
} from './noticeos-fields.ts';
import { Refused } from './refused.ts';

export interface WriteContext extends Reader {
  /** The current time as UTC ISO 8601 text. */
  readonly now: () => string;
  /** Called once an answer to an approval that gates a pull request has
   * landed; the task store posts it on GitHub (approval-github.ts). */
  readonly approvalAnswered?: (answer: ApprovalAnswer) => Promise<void>;
}

/** An answer to an approval that gates a pull request, as it landed. */
export interface ApprovalAnswer {
  readonly projectId: string;
  /** The approval as the answer left it. */
  readonly gate: Task;
  /** The pull request it gates (gatedPullRequest). */
  readonly pullRequest: string;
  /** Approved, done by the person themselves, declined, or a relayed approval withdrawn by a dispute. */
  readonly answer: 'approved' | 'performed' | 'declined' | 'withdrawn';
  /** The person whose answer it is. */
  readonly by: string;
  /** The agent that relayed it; null for a person's own answer in the web app or a connected app. */
  readonly relayedBy: string | null;
}

/** What a write's retry record is kept under. */
export interface RetryRequest {
  /** The operation's name, such as create_task. */
  readonly operation: string;
  /** The caller's idempotency key. */
  readonly key: string;
  /** What the caller sent, without the key: a retry that sends anything else is refused. */
  readonly request: unknown;
  /** The key was derived from the request, not chosen by the caller (Retry.derived). */
  readonly derived?: boolean;
}

/** How many times a write reads its task again after another write changed it first. */
const ATTEMPTS = 3;
export const OPEN_STATUSES: readonly Exclude<TaskStatus, 'closed'>[] = ['open', 'in_progress', 'blocked', 'deferred'];

// ─── Sentences ────────────────────────────────────────────────────────────────

const refused = (message: string, detail: string) => new Refused('state', message, detail);

function closedRefusal(id: string): Refused {
  return refused(`refused: ${id} is already closed; get_task shows its close reason.`, `${id} is already closed.`);
}

/** Closing, removing the human label or a dependency on a person's decision is the person's to do. */
function decisionRefusal(id: string): Refused {
  return refused(
    `refused: ${id} is a human request. Use reconcile_task with an existing owner answer or concrete maintenance evidence. For a leftover human label after its gate closed, use reconcile_task action routine with the closed gate as evidence, then retry close_task. ` +
      'An unresolved action-specific approval stays blocked; do not invent an answer or treat retirement as permission.',
    `${id} is a person's decision.`,
  );
}

function conflict(): Refused {
  return new Refused(
    'retry_conflict',
    'conflict: this idempotency_key was first used for a different change. Resend that call unchanged to read its result, ' +
      'or choose a new key for this one.',
    'This Idempotency-Key was first used for a different change. Send that change again unchanged, or use a new key.',
  );
}

/** The change did not land because the task kept changing under it. */
function unavailable(keyed: boolean): Refused {
  return new Refused(
    'unavailable',
    keyed
      ? "unavailable: the task store did not complete this call, and nothing in the task's state explains it. Retry the same call; with the same idempotency_key a change lands at most once."
      : 'unavailable: the change could not be confirmed; retry it',
    'The task changed while this change was being made. Try again.',
  );
}

/** A refusal from the engine, in the API's words. Its own checks come first,
 * so these are what slipped past them, such as a link that would close a loop. */
function fromEngine(error: unknown, { loop, keyed = false }: { loop?: Refused; keyed?: boolean } = {}): unknown {
  if (!(error instanceof TaskRefused)) return error;
  switch (error.refusal) {
    case 'retry_conflict':
      return conflict();
    // The engine tried again itself, and another write kept changing a task this one changes.
    case 'version_conflict':
      return unavailable(keyed);
    case 'cycle':
      return (
        loop ??
        refused(
          'refused: these links would make tasks wait on each other in a loop.',
          'These links would make tasks wait on each other in a loop.',
        )
      );
    case 'not_found':
      return new Refused('not_found', `refused: ${error.message}`, error.message);
    case 'invalid':
      return new Refused('invalid', `invalid arguments: ${error.message}`, error.message);
    default:
      return refused(`refused: ${error.message}`, error.message);
  }
}

// ─── Shared steps ─────────────────────────────────────────────────────────────

/** SHA-256 of `text`, as 64 lowercase hexadecimal characters. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** JSON with every object's keys sorted, so a request hashes the same however its sender ordered them. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export async function retryOf(principal: Principal, retry: RetryRequest | undefined): Promise<Retry | undefined> {
  if (retry === undefined) return undefined;
  return {
    principal: principal.id,
    operation: retry.operation,
    key: retry.key,
    requestHash: await sha256(canonical(retry.request)),
    ...(retry.derived === true ? { derived: true } : {}),
  };
}

export function actorOf(principal: Principal, model: string | undefined): Actor {
  return model === undefined ? { name: principal.name } : { name: principal.name, model };
}

/** A gate, or a task labelled human: a person's to answer. */
export function isDecision(task: Pick<Task, 'type' | 'labels'>): boolean {
  return task.type === 'gate' || task.labels.includes('human');
}

/** The open tasks this one waits on through `blocks` links. */
function openBlockers(task: Task): string[] {
  return task.dependencies
    .filter((link) => link.type === 'blocks' && link.status !== 'closed')
    .map((link) => link.taskId);
}

/** The open gates among the tasks this one waits on, each read in the project its id names, which a move can leave
 * other than the task's: a close must find every approval it waits on. */
async function openGates({ engine }: Reader, project: Project, task: Task): Promise<Task[]> {
  const ids = openBlockers(task);
  if (ids.length === 0) return [];
  const projects = await engine.listProjects();
  const owner = (id: string) =>
    projects.find((candidate) => candidate.prefix === id.slice(0, id.indexOf('-')))?.id ?? project.id;
  const blockers = await Promise.all(ids.map((id) => engine.getTask(owner(id), id)));
  return blockers.filter((blocker): blocker is Task => blocker !== null && blocker.type === 'gate');
}

/** The answer an earlier write with this retry identity gave, or null. */
export async function recorded(
  reader: Reader,
  project: Project,
  retry: Retry | undefined,
): Promise<WriteResult | null> {
  const { engine, principal } = reader;
  if (retry === undefined) return null;
  let replay: WriteResult | null;
  try {
    replay = await engine.recordedWrite(project.id, retry);
  } catch (error) {
    throw fromEngine(error);
  }
  // The task it wrote may have moved since to a project the sender cannot reach, which answers as no task.
  if (replay !== null && !mayReach(principal, replay.task.projectId, 'read'))
    throw new Refused(
      'not_found',
      'refused: the task this idempotency_key wrote is in no project you can reach; choose a new key for a new change.',
      'The task this change wrote is not in a project you can reach.',
    );
  return replay;
}

/** Whether a derived key's record answers the same request now, is stale
 * (the request runs again), or does not exist. */
export async function retryStanding(
  context: Reader,
  project: Project,
  request: RetryRequest,
): Promise<'answers' | 'stale' | 'none'> {
  const retry = (await retryOf(context.principal, request))!;
  if ((await recorded(context, project, retry)) !== null) return 'answers';
  // Read as a caller's own key, the record answers whether or not it is stale.
  return (await recorded(context, project, { ...retry, derived: false })) === null ? 'none' : 'stale';
}

/**
 * Binds a caller's idempotency key to the whole of a call that writes several
 * tasks, each under a record of its own (rule 3): the call's record, kept
 * beside `taskId`, answers the same call sent again, and refuses the key for
 * any other request before a task is written. It writes the record alone,
 * leaving the task's version and history as they are.
 */
export async function bindRetry(
  context: WriteContext,
  projectId: string,
  taskId: string,
  request: RetryRequest,
): Promise<void> {
  const project = await projectOf(context, projectId, 'write');
  const retry = (await retryOf(context.principal, request))!;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if ((await recorded(context, project, retry)) !== null) return;
    const task = await taskOf(context, project, taskId);
    try {
      await context.engine.recordUnchanged(project.id, task.id, task.version, retry);
      return;
    } catch (error) {
      if (!(error instanceof TaskRefused) || error.refusal !== 'version_conflict') throw fromEngine(error);
    }
  }
  throw unavailable(true);
}

/**
 * Changes a task: `plan` reads the task as it stands and returns the write,
 * or null when it changes nothing, or throws the refusal its state calls for.
 * When another write changes the task first, it reads the task again and
 * plans again, so a write that names no version still keeps rule 2. A keyed
 * write that changes nothing still records its key, with the task as its
 * answer, so a retry replays it rather than writing what it sent once the
 * task has moved on, and the key cannot be reused for another change.
 */
export async function changing(
  context: WriteContext,
  project: Project,
  first: Task,
  actor: Actor,
  retry: Retry | undefined,
  plan: (task: Task) => Promise<TaskWrite | null>,
  loop?: Refused,
): Promise<WriteResult> {
  let task = first;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const write = await plan(task);
    if (write === null && retry === undefined) return { task, created: [], replayed: false };
    try {
      return write === null
        ? await context.engine.recordUnchanged(project.id, task.id, task.version, retry!)
        : await context.engine.writeTask(project.id, task.id, write, actor, retry);
    } catch (error) {
      const raced = error instanceof TaskRefused && (error.refusal === 'version_conflict' || error.refusal === 'held');
      if (!raced) throw fromEngine(error, { loop });
      task = await taskOf(context, project, task.id);
    }
  }
  throw unavailable(retry !== undefined);
}

/** The link types that may name a task in another project the sender
 * reaches. They hold nothing out of ready work; every other link stays in the project. */
const ACROSS_PROJECTS: readonly DependencyType[] = Object.freeze([
  'related',
  'duplicates',
  'supersedes',
  'merges-after',
]);

/** The task ids a new task or a change links to, each in its project. */
async function linkTargets(
  context: WriteContext,
  project: Project,
  links: readonly { readonly taskId: string; readonly type: DependencyType }[],
): Promise<void> {
  const local: string[] = [];
  for (const link of links) {
    const owner = ACROSS_PROJECTS.includes(link.type) ? await ownerOf(context, link.taskId) : undefined;
    if (owner !== undefined && owner.id !== project.id) await tasksIn(context, owner, [link.taskId]);
    else local.push(link.taskId);
  }
  await tasksIn(context, project, local);
}

// ─── Creating a task ──────────────────────────────────────────────────────────

/** A new task's link: what the new task depends on, blocks, relates to, was
 * found from, duplicates or replaces. */
export interface NewLink {
  readonly kind: 'depends_on' | 'blocks' | 'related' | 'discovered_from' | 'duplicates' | 'supersedes';
  readonly taskId: string;
}

const ENGINE_LINKS: Readonly<Record<NewLink['kind'], Omit<NewTaskLink, 'taskId'>>> = Object.freeze({
  depends_on: { direction: 'depends-on', type: 'blocks' },
  blocks: { direction: 'blocks', type: 'blocks' },
  related: { direction: 'depends-on', type: 'related' },
  discovered_from: { direction: 'depends-on', type: 'discovered-from' },
  duplicates: { direction: 'depends-on', type: 'duplicates' },
  supersedes: { direction: 'depends-on', type: 'supersedes' },
});

export interface NewTask {
  readonly title: string;
  readonly description?: string;
  readonly type?: Exclude<TaskType, 'gate'>;
  readonly priority?: number;
  readonly labels?: readonly string[];
  readonly parent?: string;
  readonly acceptance?: string;
  readonly notes?: string;
  readonly design?: string;
  readonly estimateMinutes?: number;
  /** An ISO time. A card's kill date is the due date too, so a task is filed with one of them. */
  readonly dueAt?: string;
  readonly links?: readonly NewLink[];
  /** Pages outside Ntasks, each URL as the URL standard writes it. */
  readonly externalLinks?: readonly ExternalLink[];
  /** Values of the project's custom fields, by key; the engine checks each against its field. */
  readonly fields?: Readonly<Record<string, FieldValue>>;
  /** What a person must approve before the task proceeds. */
  readonly approval?: ApprovalRequest;
  readonly choices?: JsonObject;
  /** A card's figures, without who wrote it and when. */
  readonly card?: JsonObject;
  readonly changeClass?: string;
  /** Where the task came from, such as a copied handoff. */
  readonly metadata?: JsonObject;
  /** File it claimed by the sender. */
  readonly claim?: true;
  /** File it closed as done by the sender, with this evidence and what proves it. */
  readonly done?: Omit<TaskClosing, 'resolution' | 'duplicateOf'>;
}

export interface Written {
  readonly project: Project;
  readonly result: WriteResult;
}

/** Files a task, with its links, its card and any approval it waits on, in one batch. */
export async function createTask(
  context: WriteContext,
  projectId: string,
  task: NewTask,
  model: string | undefined,
  retryRequest?: RetryRequest,
): Promise<Written> {
  const project = await projectOf(context, projectId, 'write');
  if (project.disabledAt !== null) {
    throw refused(
      `refused: ${projectNamed(project)} is disabled, so it takes no new tasks; its tasks stay readable. ` +
        "A workspace owner enables it again on the web app's Settings page, under Projects.",
      `${project.name} is disabled, so it takes no new tasks. An owner can enable it in Settings.`,
    );
  }
  const links = task.links ?? [];
  if (task.done !== undefined && task.labels?.includes('human')) {
    throw refused(
      "refused: a task labelled human is a person's to close, so it is not filed done. File it open, or leave out the human label.",
      "A task labelled human is a person's to close.",
    );
  }
  if (task.parent !== undefined) await tasksIn(context, project, [task.parent]);
  await linkTargets(
    context,
    project,
    links.map((link) => ({ taskId: link.taskId, type: ENGINE_LINKS[link.kind].type })),
  );
  if (task.done !== undefined) {
    // A close waits for the approvals the task waits on, so filing it closed does too.
    const waitsOn = links.filter((link) => link.kind === 'depends_on').map((link) => link.taskId);
    const gates = (await context.engine.getTasks(project.id, waitsOn))
      .filter((other) => other.type === 'gate' && other.status !== 'closed')
      .map((gate) => gate.id);
    if (gates.length > 0) {
      const named = listed(gates);
      throw refused(
        `refused: the new task waits on approval ${named}, which is still open, so it is not filed done. ` +
          'Use reconcile_task on the gate with the owner’s scoped answer first, or file the task open.',
        `It waits on approval ${named}, which is still open.`,
      );
    }
  }
  const card = task.card === undefined ? undefined : recordedCard(task.card, context.principal.name, context.now());
  const due = card?.kill === undefined ? undefined : (card.kill as JsonObject).date;
  const metadata: JsonObject = {
    ...task.metadata,
    ...(card === undefined ? {} : { [NOTICEOS_METADATA.card]: card }),
    ...(task.changeClass === undefined ? {} : { [NOTICEOS_METADATA.changeClass]: task.changeClass }),
  };
  const input: CreateTaskInput = {
    title: task.title,
    ...(task.description === undefined ? {} : { description: task.description }),
    ...(task.acceptance === undefined ? {} : { acceptance: task.acceptance }),
    ...(task.notes === undefined ? {} : { notes: task.notes }),
    ...(task.design === undefined ? {} : { design: task.design }),
    ...(task.estimateMinutes === undefined ? {} : { estimateMinutes: task.estimateMinutes }),
    ...(task.type === undefined ? {} : { type: task.type }),
    ...(task.priority === undefined ? {} : { priority: task.priority }),
    ...(task.parent === undefined ? {} : { parentId: task.parent }),
    ...(task.labels === undefined ? {} : { labels: task.labels }),
    links: links.map((link) => ({ ...ENGINE_LINKS[link.kind], taskId: link.taskId })),
    ...(task.externalLinks === undefined ? {} : { externalLinks: task.externalLinks }),
    ...(task.fields === undefined ? {} : { fields: task.fields }),
    ...(typeof due === 'string' ? { dueAt: due } : task.dueAt === undefined ? {} : { dueAt: task.dueAt }),
    ...(task.choices === undefined ? {} : { choices: task.choices }),
    metadata,
    ...(task.approval === undefined ? {} : { requestApproval: task.approval }),
    ...(task.claim === true ? { claim: true as const } : {}),
    ...(task.done === undefined ? {} : { close: closeOf(task.done, task.type ?? 'task') }),
  };
  const retry = await retryOf(context.principal, retryRequest);
  try {
    const result = await context.engine.createTask(project.id, input, actorOf(context.principal, model), retry);
    return { project, result };
  } catch (error) {
    throw fromEngine(error, { keyed: retry !== undefined });
  }
}

// ─── Changing a task ──────────────────────────────────────────────────────────

export interface TaskChange extends WorkArgs {
  /** Take the task: the sender becomes its assignee and it moves to in progress.
   * Its helper and work details, if given, are the claim's. */
  readonly claim?: true;
  /** On a closed task, any status opens it again. */
  readonly status?: Exclude<TaskStatus, 'closed'>;
  readonly priority?: number;
  readonly title?: string;
  readonly description?: string;
  readonly acceptance?: string;
  readonly notes?: string;
  readonly design?: string;
  /** null takes the estimate off. */
  readonly estimateMinutes?: number | null;
  /** An ISO time, or null to clear it. A card's kill date sets it too. */
  readonly dueAt?: string | null;
  /** null releases the task. */
  readonly assignee?: string | null;
  /** null takes the task out of its parent. */
  readonly parent?: string | null;
  /** A date, YYYY-MM-DD, or null to clear it. */
  readonly defer?: string | null;
  readonly addLabels?: readonly string[];
  readonly removeLabels?: readonly string[];
  /** Tasks to link as related, as duplicated by this one or as replaced by it,
   * in this project or another the sender reaches. */
  readonly related?: readonly string[];
  readonly duplicates?: readonly string[];
  readonly supersedes?: readonly string[];
  /** Pages outside Ntasks to link, each URL as the URL standard writes it. One
   * the task links to already takes this title and kind. */
  readonly addExternalLinks?: readonly ExternalLink[];
  /** URLs, as the URL standard writes them, whose links to take off. */
  readonly removeExternalLinks?: readonly string[];
  /** Values of the project's custom fields, by key; null takes a value off. */
  readonly fields?: Readonly<Record<string, FieldValue | null>>;
  /** null takes them off. */
  readonly choices?: JsonObject | null;
  /** A card's figures, or null to take it off. */
  readonly card?: JsonObject | null;
  readonly changeClass?: string | null;
}

/** The refusals a claim or a change of assignee meets, from the task's state. */
function assignment(task: Task, change: TaskChange, actor: Actor): void {
  const holder = task.assignee;
  const held = holder !== null && holder !== actor.name;
  if (change.claim) {
    if (task.status === 'closed')
      throw refused(
        `refused: ${task.id} is closed, so it cannot be claimed. File work that remains with create_task.`,
        `${task.id} is already closed.`,
      );
    if (held)
      throw refused(
        `refused: ${task.id} is held by ${holder}. Choose another task, or reach ${holder} with comment_on_task.`,
        `${task.id} is held by ${holder}.`,
      );
    if (task.status === 'blocked' || task.status === 'deferred' || (task.status === 'in_progress' && holder === null)) {
      const blockers = openBlockers(task);
      throw refused(
        `refused: ${task.id} has status ${task.status}, and claim_task takes an open task.` +
          (blockers.length ? ` It depends on ${listed(blockers)}, still open.` : '') +
          ' To work on it now, set its status to open with update_task, then claim it.',
        `${task.id} has status ${task.status}; set it to open before taking it.`,
      );
    }
    return;
  }
  if (change.assignee === undefined || !held || change.assignee === holder) return;
  // A task someone is working stays theirs, and taking one someone holds is a claim the engine refuses.
  if (task.status === 'in_progress' || change.assignee === actor.name) {
    throw refused(
      `refused: ${task.id} is held by ${holder}, and only its holder or a person in the web app gives it to someone else.`,
      `${task.id} is held by ${holder}, and only its holder gives it to someone else.`,
    );
  }
}

const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);

/** The links a change adds, by type. */
function linksOf(change: TaskChange): { readonly taskId: string; readonly type: DependencyType }[] {
  return [
    ...(change.related ?? []).map((taskId) => ({ taskId, type: 'related' as const })),
    ...(change.duplicates ?? []).map((taskId) => ({ taskId, type: 'duplicates' as const })),
    ...(change.supersedes ?? []).map((taskId) => ({ taskId, type: 'supersedes' as const })),
  ];
}

/** The write that makes `change` to `task` as it stands, or null when it changes nothing. */
function planChange(context: WriteContext, task: Task, change: TaskChange, actor: Actor): TaskWrite | null {
  // The values that differ from the task's, change.fields having been checked against the project's fields.
  const setFields = Object.fromEntries(
    Object.entries(change.fields ?? {}).filter(([key, value]) =>
      value === null ? task.fields[key] !== undefined : !same(value, task.fields[key]),
    ),
  );
  if (change.removeLabels?.includes('human') && isDecision(task)) throw decisionRefusal(task.id);
  // A person's pick is recorded against the options they saw.
  if (change.choices !== undefined && task.choice !== null) {
    const chosen = choiceName(task.choice);
    throw refused(
      `refused: ${task.id} already carries a person's choice${chosen === null ? '' : `, ${chosen}`}, and its choices ` +
        'stay as they were when it was made. get_task shows the choice; file work that remains with create_task.',
      chosen === null ? `${task.id} already has a choice.` : `${task.id} already has a choice: ${chosen}.`,
    );
  }
  // Grading reads the card a task shipped with, so that card stays as it shipped.
  const shipped = change.card === undefined ? null : readCardShipped(task.metadata);
  if (shipped !== null) {
    const day = shipped.closedAt.slice(0, 10);
    throw refused(
      `refused: ${task.id} shipped on ${day}, and its card stays as it shipped: ` +
        'get_task shows it as cardShipped. File work that remains, with its own card, with create_task.',
      `${task.id} shipped on ${day}, and its card stays as it shipped.`,
    );
  }
  assignment(task, change, actor);
  const assignee = change.assignee === undefined ? task.assignee : change.assignee;
  if (change.status === 'in_progress' && assignee === null)
    throw refused(
      `refused: ${task.id} needs a holder to be in progress. Use claim_task to take it, or set an assignee with the status.`,
      `${task.id} needs a holder to be in progress. Claim it or set an assignee with the status.`,
    );

  const set: Record<string, unknown> = {};
  const put = (field: string, value: unknown, current: unknown) => {
    if (value !== undefined && !same(value, current)) set[field] = value;
  };
  put('title', change.title, task.title);
  put('description', change.description, task.description);
  put('acceptance', change.acceptance, task.acceptance);
  put('notes', change.notes, task.notes);
  put('design', change.design, task.design);
  put('estimateMinutes', change.estimateMinutes, task.estimateMinutes);
  put('dueAt', change.dueAt, task.dueAt);
  put('priority', change.priority, task.priority);
  put('parentId', change.parent, task.parentId);
  put(
    'deferUntil',
    change.defer === undefined || change.defer === null ? change.defer : `${change.defer}T00:00:00.000Z`,
    task.deferUntil,
  );
  put('choices', change.choices, task.choices);
  const status = change.status ?? (change.assignee === null && task.status === 'in_progress' ? 'open' : undefined);
  const reopen = status !== undefined && task.status === 'closed';
  if (reopen) set.status = status;
  else put('status', status, task.status);
  if (change.claim) {
    put('assignee', actor.name, task.assignee);
    put('status', 'in_progress', task.status);
  } else {
    put('assignee', change.assignee, task.assignee);
  }
  put('assigneeFor', change.assigneeFor, task.assigneeFor);
  const work = Object.fromEntries(
    Object.entries(change.work ?? {}).filter(([detail, value]) => !same(value, task.work[detail as WorkDetail])),
  );
  if (Object.keys(work).length > 0) set.work = work;

  const metadata: Record<string, JsonObject | string | null> = {};
  if (change.card === null && task.metadata[NOTICEOS_METADATA.card] !== undefined)
    metadata[NOTICEOS_METADATA.card] = null;
  if (change.card) {
    const card = recordedCard(change.card, actor.name, context.now());
    metadata[NOTICEOS_METADATA.card] = card;
    // A card's kill date is also the task's due date; a card taken off leaves it.
    const kill = card.kill as JsonObject | undefined;
    if (typeof kill?.date === 'string') put('dueAt', `${kill.date}T00:00:00.000Z`, task.dueAt);
  }
  if (change.changeClass !== undefined && !same(change.changeClass, task.metadata[NOTICEOS_METADATA.changeClass]))
    metadata[NOTICEOS_METADATA.changeClass] = change.changeClass;

  const addLabels = (change.addLabels ?? []).filter((label) => !task.labels.includes(label));
  const removeLabels = (change.removeLabels ?? []).filter((label) => task.labels.includes(label));
  const linked = new Set(task.dependencies.map((link) => link.taskId));
  // A link the two already have, of any type, stays as it is.
  const addLinks = linksOf(change)
    .filter((link) => !linked.has(link.taskId))
    .filter((link, index, all) => all.findIndex((other) => other.taskId === link.taskId) === index);

  const external = new Map(task.externalLinks.map((link) => [link.url, link]));
  const addExternalLinks = (change.addExternalLinks ?? []).filter((link) => {
    const standing = external.get(link.url);
    return standing?.title !== link.title || standing.kind !== link.kind;
  });
  const removeExternalLinks = (change.removeExternalLinks ?? []).filter((url) => external.has(url));

  const write: TaskWrite = {
    expectedVersion: task.version,
    ...(Object.keys(set).length > 0 ? { set } : {}),
    ...(reopen ? { reopen: true as const } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(addLabels.length > 0 ? { addLabels } : {}),
    ...(removeLabels.length > 0 ? { removeLabels } : {}),
    ...(addLinks.length > 0 ? { addLinks } : {}),
    ...(addExternalLinks.length > 0 ? { addExternalLinks } : {}),
    ...(removeExternalLinks.length > 0 ? { removeExternalLinks } : {}),
    ...(Object.keys(setFields).length > 0 ? { setFields } : {}),
  };
  return Object.keys(write).length > 1 ? write : null;
}

/** Changes a task's fields, claims it or hands it on. */
export async function updateTask(
  context: WriteContext,
  projectId: string,
  taskId: string,
  change: TaskChange,
  model: string | undefined,
  retryRequest?: RetryRequest,
): Promise<Written> {
  const project = await projectOf(context, projectId, 'write');
  const task = await taskOf(context, project, taskId);
  const retry = await retryOf(context.principal, retryRequest);
  const replay = await recorded(context, project, retry);
  if (replay !== null) return { project, result: replay };
  for (const name of ['related', 'duplicates', 'supersedes'] as const) {
    if (change[name]?.includes(taskId))
      throw new Refused('invalid', `invalid arguments: ${name} (another task than this one)`);
  }
  if (typeof change.parent === 'string') await tasksIn(context, project, [change.parent]);
  await linkTargets(context, project, linksOf(change));
  // Checked here as well as in the engine, so a value the task already has is no change.
  const checked: TaskChange =
    change.fields === undefined
      ? change
      : {
          ...change,
          fields: await engineChecked(async () =>
            fieldValues(await context.engine.listFields(project.id), change.fields, true),
          ),
        };
  const actor = actorOf(context.principal, model);
  const loop =
    typeof change.parent === 'string'
      ? refused(
          `refused: ${change.parent} is ${taskId} or under it, so it cannot be its parent.`,
          `${change.parent} is ${taskId} or under it, so it cannot be its parent.`,
        )
      : undefined;
  const result = await changing(
    context,
    project,
    task,
    actor,
    retry,
    async (current) => planChange(context, current, checked, actor),
    loop,
  );
  return { project, result };
}

/** Changes queue membership, with the note and any reopen in the same write. */
export async function setTaskNext(
  context: WriteContext,
  projectId: string,
  taskId: string,
  next: { queued: boolean; reopen: boolean; note: string | undefined },
  retryRequest?: RetryRequest,
): Promise<WriteResult> {
  const project = await projectOf(context, projectId, 'write');
  const task = await taskOf(context, project, taskId);
  const retry = await retryOf(context.principal, retryRequest);
  const replay = await recorded(context, project, retry);
  if (replay !== null) return replay;
  const actor = actorOf(context.principal, undefined);
  return changing(context, project, task, actor, retry, async (current) => {
    if (next.queued) {
      if (!canQueueNext(current)) throw new Refused('state', 'Only tasks for agents can be added to Next.');
      if (current.status === 'in_progress') throw new Refused('state', 'This task is already in progress.');
      if (next.reopen !== (current.status === 'closed'))
        throw new Refused(
          'state',
          next.reopen ? 'Refresh the task before adding it to Next.' : 'Reopen this task to add it to Next.',
        );
    }
    const edit: TaskChange = next.queued
      ? { addLabels: [NEXT_LABEL], ...(next.reopen ? { status: 'open', assignee: null, defer: null } : {}) }
      : { removeLabels: [NEXT_LABEL] };
    const write = planChange(context, current, edit, actor);
    return next.note === undefined ? write : { expectedVersion: current.version, ...write, comment: next.note };
  });
}

// ─── Moving tasks ─────────────────────────────────────────────────────────────

/** Where a move puts tasks: in a project, under a task of it or under none. */
export interface TaskMove {
  /** The tasks to move, each once, in the order the answer lists them. */
  readonly tasks: readonly string[];
  /** The project they go to, by projectId, key or prefix; left out, the parent's. */
  readonly project?: string;
  /** The task they go under; null or left out, none. */
  readonly parent?: string | null;
  /** Moves every task under each one named with it, keeping its parent. */
  readonly withChildren?: boolean;
}

export interface MovedTasks {
  readonly result: MoveResult;
  /** For each task that came from another project, the keys of the values it
   * kept that this project defines with another type or options, or not at all. */
  readonly fieldsKept: Readonly<Record<string, readonly string[]>>;
}

/** The project a move goes to, which must take new tasks; a name no project here has is refused as another workspace's. */
async function destinationOf(context: WriteContext, move: TaskMove): Promise<Project> {
  const parent = move.parent ?? null;
  const parentProject = parent === null ? null : await projectOfTask(context, parent);
  if (move.project === undefined && parentProject === null)
    throw new Refused(
      'invalid',
      'invalid arguments: project (required unless parent names the task they go under)',
      'Name the project the tasks go to, or the task they go under.',
    );
  let project: Project;
  try {
    project = await projectOf(context, move.project ?? parentProject!.id, 'write');
  } catch (error) {
    if (!(error instanceof Refused) || error.kind !== 'not_found') throw error;
    throw new Refused(
      'not_found',
      `${error.message} A task moves only between projects of its own workspace; to put work in another workspace, file it there.`,
      `${error.detail}. A task moves only between projects of its own workspace.`,
    );
  }
  if (parentProject !== null && parentProject.id !== project.id)
    throw new Refused(
      'invalid',
      `invalid arguments: parent (${parent} is in ${projectNamed(parentProject)}, not in ${projectNamed(project)}, where the tasks go)`,
      `${parent} is in ${parentProject.name}, not in ${project.name}.`,
    );
  if (project.disabledAt !== null)
    throw refused(
      `refused: ${projectNamed(project)} is disabled, so it takes no new tasks; its tasks stay readable. ` +
        "A workspace owner enables it again on the web app's Settings page, under Projects.",
      `${project.name} is disabled, so it takes no new tasks. An owner can enable it in Settings.`,
    );
  if (parent !== null) await tasksIn(context, project, [parent]);
  return project;
}

/**
 * The placements of a move as the tasks stand now: each task named under the
 * parent, and with `withChildren` every task under one that leaves its
 * project, under its own parent. A task leaving its project with tasks under
 * it, without `withChildren`, is refused.
 */
async function placementsOf(context: WriteContext, project: Project, move: TaskMove): Promise<TaskPlacement[]> {
  const owners = new Map<string, { readonly project: Project; readonly ids: string[] }>();
  for (const id of move.tasks) {
    const owner = await projectOf(context, (await projectOfTask(context, id)).id, 'write');
    const group = owners.get(owner.id) ?? { project: owner, ids: [] };
    group.ids.push(id);
    owners.set(owner.id, group);
  }
  const found = new Map<string, Task>();
  for (const { project: owner, ids } of owners.values()) {
    for (const task of await context.engine.getTasks(owner.id, ids)) found.set(task.id, task);
    for (const id of ids) if (!found.has(id)) await taskOf(context, owner, id);
  }
  const parent = move.parent ?? null;
  const placements: TaskPlacement[] = move.tasks.map((id) => ({
    taskId: id,
    expectedVersion: found.get(id)!.version,
    parentId: parent,
  }));
  const placed = new Set(move.tasks);
  const leaving: Task[] = [];
  for (const id of move.tasks) {
    const task = found.get(id)!;
    if (task.projectId === project.id) continue;
    leaving.push(task);
    const under = await context.engine.listUnder(task.projectId, [task.id], TASK_LIMITS.move + 1);
    if (under.length > 0 && move.withChildren !== true) {
      const named = listed(under.slice(0, 3).map((child) => child.id));
      throw new Refused(
        'invalid',
        `invalid arguments: with_children (${task.id} has tasks under it, such as ${named}, which move to another project only with it; pass with_children: true)`,
        `${task.id} has tasks under it, such as ${named}; they move to another project only with it.`,
      );
    }
    for (const child of under) {
      leaving.push(child);
      if (placed.has(child.id)) continue;
      placed.add(child.id);
      placements.push({ taskId: child.id, expectedVersion: child.version, parentId: child.parentId });
    }
  }
  // An open approval or request to do steps moves with the task waiting on it, when every task waiting on it moves:
  // a person answers it beside the task it holds back, and an answer reaches the tasks it holds.
  for (const task of leaving) {
    const blockers = task.dependencies.filter((link) => link.type === 'blocks' && link.status !== 'closed');
    const gates = (
      await context.engine.getTasks(
        task.projectId,
        blockers.map((link) => link.taskId),
      )
    ).filter((gate) => gate.type === 'gate' && !placed.has(gate.id));
    for (const gate of gates) {
      const waiting = gate.dependents.filter((link) => link.type === 'blocks').map((link) => link.taskId);
      if (!waiting.every((id) => placed.has(id))) continue;
      placed.add(gate.id);
      placements.push({ taskId: gate.id, expectedVersion: gate.version, parentId: null });
    }
  }
  if (placements.length > TASK_LIMITS.move)
    throw new Refused(
      'invalid',
      `invalid arguments: tasks (one move places at most ${TASK_LIMITS.move} tasks, counting the tasks under them, and this one places more; split it into smaller calls)`,
      `One move takes at most ${TASK_LIMITS.move} tasks, counting the tasks under them.`,
    );
  return placements;
}

/** The tasks a move names, as it left them, in the order named: each by the id it moved to, if it moved. */
export function namedAfter(ids: readonly string[], result: MoveResult): Task[] {
  const now = new Map(result.moved.map(({ from, to }) => [from, to]));
  return ids.flatMap((id) => result.tasks.filter((task) => task.id === (now.get(id) ?? id)));
}

/** The field values the tasks that came from another project kept that their project does not take as they are. */
async function fieldsKeptOf(context: WriteContext, result: MoveResult): Promise<Record<string, readonly string[]>> {
  const arrived = new Set(result.moved.map((moved) => moved.to));
  const kept: Record<string, string[]> = {};
  const defined = new Map<string, readonly CustomField[]>();
  for (const task of result.tasks) {
    if (!arrived.has(task.id)) continue;
    if (!defined.has(task.projectId)) defined.set(task.projectId, await context.engine.listFields(task.projectId));
    const fields = defined.get(task.projectId)!;
    const keys = Object.entries(task.fields).flatMap(([key, value]) => {
      try {
        fieldValues(fields, { [key]: value }, false);
        return [];
      } catch {
        return [key];
      }
    });
    if (keys.length > 0) kept[task.id] = keys;
  }
  return kept;
}

/**
 * Moves tasks to a project, under a task of it or under none, in one engine
 * call: every task moves or none does. A task from another project takes a
 * new id there, and keeps its field values whether or not the project defines
 * them. A move that leaves every task where it is changes nothing.
 */
export async function moveTasks(
  context: WriteContext,
  move: TaskMove,
  model: string | undefined,
  retryRequest?: RetryRequest,
): Promise<MovedTasks> {
  const retry = await retryOf(context.principal, retryRequest);
  const finished = async (found: MoveResult): Promise<MovedTasks> => {
    // A replay reads the tasks where they are now, which may be a project the sender cannot reach.
    const reached = new Set(reachable(context.principal, await context.engine.listProjects()).map((one) => one.prefix));
    const seen = (id: string) => reached.has(id.slice(0, id.indexOf('-')));
    const result: MoveResult = {
      ...found,
      tasks: found.tasks.filter((task) => seen(task.id)),
      moved: found.moved.filter((moved) => seen(moved.to)),
      ...(found.epics === undefined ? {} : { epics: found.epics.filter((epic) => seen(epic.id)) }),
    };
    return { result, fieldsKept: await fieldsKeptOf(context, result) };
  };
  // A move answered before answers again, whatever has changed since about where it went.
  if (retry !== undefined) {
    let replay: MoveResult | null;
    try {
      replay = await context.engine.recordedMove(retry);
    } catch (error) {
      throw fromEngine(error);
    }
    if (replay !== null) return finished(replay);
  }
  const project = await destinationOf(context, move);
  const actor = actorOf(context.principal, model);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const placements = await placementsOf(context, project, move);
    try {
      return finished(await context.engine.moveTasks(project.id, placements, actor, retry));
    } catch (error) {
      if (error instanceof TaskRefused && error.refusal === 'version_conflict') continue;
      const parent = move.parent ?? null;
      throw fromEngine(error, {
        keyed: retry !== undefined,
        loop:
          parent === null
            ? undefined
            : refused(
                `refused: ${parent} is one of the tasks moved or under one of them, so they cannot go under it.`,
                `${parent} is one of the tasks moved or under one of them.`,
              ),
      });
    }
  }
  throw unavailable(retry !== undefined);
}

// ─── Closing a task ───────────────────────────────────────────────────────────

export interface TaskClosing {
  /** The evidence: a commit or a link, or why nothing shipped. */
  readonly reason: string;
  /** done when left out. */
  readonly resolution?: TaskResolution;
  /** With duplicate: the task this one duplicates, in the same project. */
  readonly duplicateOf?: string;
  /** What shipped, with done: either starts the task's delivery at built,
   * except on a decision or an approval. One left out comes from the task's
   * work details, unless the close names only a link (closeProof). */
  readonly commit?: string;
  readonly pullRequest?: string;
  /** With done: a URL that shows work no commit or pull request shows. */
  readonly link?: string;
  /** The test run that shows the close. */
  readonly test?: TaskTestResult;
}

/** A new task's close as done, its evidence and proof, as the engine takes them (closeProof). */
function closeOf(closing: Omit<TaskClosing, 'resolution' | 'duplicateOf'>, type: TaskType) {
  return { reason: closing.reason, ...closeProof(closing, type, {}) };
}

/** The proof a task closed as done without any is told it takes. */
export function proofWarning(taskId: string, takes: string): string {
  return `${taskId} is done without proof; ${takes} takes commit, pr or link, a URL that shows the work.`;
}

/** Closes a task, keeping its card as it shipped when it closes as done, and
 * linking a duplicate to the task it duplicates. */
export async function closeTask(
  context: WriteContext,
  projectId: string,
  taskId: string,
  closing: TaskClosing,
  model: string | undefined,
  retryRequest?: RetryRequest,
): Promise<Written> {
  const project = await projectOf(context, projectId, 'write');
  const task = await taskOf(context, project, taskId);
  const retry = await retryOf(context.principal, retryRequest);
  const replay = await recorded(context, project, retry);
  if (replay !== null) return { project, result: replay };
  const duplicateOf = closing.duplicateOf;
  if (duplicateOf !== undefined) await tasksIn(context, project, [duplicateOf]);
  const actor = actorOf(context.principal, model);
  const result = await changing(context, project, task, actor, retry, async (current) => {
    const id = current.id;
    if (isDecision(current)) throw decisionRefusal(id);
    // An epic Ntasks closed when its last task closed takes this close, with its reason and proof, in place of Ntasks's.
    if (current.status === 'closed' && !closedByNtasks(current)) throw closedRefusal(id);
    if (current.assignee !== null && current.assignee !== actor.name) {
      const holder = current.assignee;
      throw refused(
        `refused: ${id} is held by ${holder}, and only its holder closes it. ` +
          `Reach ${holder} with comment_on_task, or ask a person to close it in the web app.`,
        `${id} is held by ${holder}, and only its holder closes it.`,
      );
    }
    const gates = await openGates(context, project, current);
    if (gates.length > 0 && gates.every((gate) => gate.steps !== null)) {
      const named = listed(gates.map((gate) => gate.id));
      throw refused(
        `refused: ${id} waits on ${named}, steps a person is asked to do, which are still open. ${id} is ready again once they tick the last step; record their report that they did them with reconcile_task action owner_performed.`,
        `${id} waits on ${named}. Tick each step first.`,
      );
    }
    if (gates.length > 0) {
      const named = listed(gates.map((gate) => gate.id));
      throw refused(
        gates.every((gate) => gate.awaitType === 'human')
          ? `refused: ${id} waits on approval ${named}, which is still open. Use reconcile_task on the gate with the owner’s scoped answer, or action declined with their refusal; then close ${id} with implementation evidence. A declined action must not happen.`
          : `refused: ${id} waits on gate ${named}, which is still open. Close ${id} after it resolves.`,
        `${id} waits on approval ${named}. Approve it first.`,
      );
    }
    const children = await context.engine.listBoard(project.id, { statuses: OPEN_STATUSES, parentId: id });
    if (children.length > 0) {
      const named = listed(children.map((child) => child.id));
      throw refused(
        `refused: ${id} has open children: ${named}. Close them first, or give them another parent with update_task.`,
        `${id} has open tasks under it: ${named}.`,
      );
    }
    const resolution = closing.resolution ?? 'done';
    const shipped = resolution === 'done' ? shippedCard(current.metadata, closing.reason, context.now()) : null;
    const linked =
      duplicateOf !== undefined &&
      [...current.dependencies, ...current.dependents].some((link) => link.taskId === duplicateOf);
    return {
      expectedVersion: current.version,
      close: {
        reason: closing.reason,
        resolution,
        ...(duplicateOf === undefined ? {} : { duplicateOf }),
        ...(resolution === 'done' ? closeProof(closing, current.type, current.work) : {}),
        ...(closing.test === undefined ? {} : { test: closing.test }),
      },
      ...(shipped === null ? {} : { metadata: { [NOTICEOS_METADATA.cardShipped]: shipped } }),
      // The two are linked as related, so either task's page reaches the other.
      ...(duplicateOf === undefined || linked ? {} : { addLinks: [{ taskId: duplicateOf, type: 'related' as const }] }),
    };
  });
  return { project, result };
}

/** What a merge did to the tasks in progress whose work named its pull request. */
export interface MergeCloses {
  readonly closed: readonly { readonly id: string }[];
  /** Each task the merge left in progress, and why. */
  readonly kept: readonly { readonly id: string; readonly why: string }[];
}

/** Why no merge ever closes this task, whatever its pull request, or null when one may. */
export function neverClosedByMerge(task: Pick<Task, 'type' | 'labels'>): string | null {
  if (task.type === 'epic') return 'an epic closes once its tasks do, never by a merge';
  if (isDecision(task)) return "it is a person's request, which only their answer closes";
  if (task.labels.includes(KEEP_OPEN)) return `it is labelled ${KEEP_OPEN}, so its holder closes it`;
  return null;
}

/** Why a merge of `pullRequest` leaves this task as it is, or null when it closes it. */
async function keptByMerge(
  context: WriteContext,
  project: Project,
  task: Task,
  pullRequest: string,
): Promise<string | null> {
  const named = task.work.pr === undefined ? null : pullRequestUrl(task.work.pr);
  if (task.status !== 'in_progress' || named !== pullRequest)
    return 'it is no longer in progress with its work naming this pull request';
  const never = neverClosedByMerge(task);
  if (never !== null) return never;
  const gates = await openGates(context, project, task);
  if (gates.length > 0) return `it waits on ${listed(gates.map((gate) => gate.id))}, still open`;
  const children = await context.engine.listBoard(project.id, { statuses: OPEN_STATUSES, parentId: task.id });
  if (children.length > 0) return `it has open tasks under it: ${listed(children.map((child) => child.id))}`;
  return null;
}

/** The comment a merge's close adds, which keeps what the holder left, since the close clears its work details. */
function leftByHolder(task: Task, pullRequest: string): string {
  const details = WORK_DETAILS.flatMap((detail) =>
    detail === 'pr' || task.work[detail] === undefined ? [] : [`- ${detail}: ${task.work[detail]}`],
  );
  return [
    `GitHub reported that ${pullRequest} merged, so the merge closed this task rather than its holder, ` +
      `${task.assignee ?? 'nobody'}. Reopen it if work remains. Its work in hand recorded:`,
    ...(task.assigneeFor === null ? [] : [`- for: ${task.assigneeFor}`]),
    ...(details.length > 0 ? details : ['- nothing besides the pull request']),
  ].join('\n');
}

/**
 * Closes as done each task in progress whose work names a pull request a
 * merged signal names (STATE-18), with that pull request and the merge
 * commit as its proof, recording the sender as its closer. Only GitHub's
 * own word calls it: the receiver, once the Worker checked that GitHub sent
 * the delivery (github.ts), and the task store's check, which asks GitHub as
 * the workspace's app (github-check.ts). A signal a sender reports closes
 * nothing, and so does one
 * that names no merge commit, since the merge commit is half the proof. An
 * epic, a person's request, a task labelled keep-open and one that waits on
 * an open request or has open tasks under it stay as they are. Each task closes in its own
 * write, so one that keeps changing leaves the others closed; GitHub's
 * delivery sent again closes it then.
 */
export async function closeMerged(context: WriteContext, signal: DeliverySignal): Promise<MergeCloses> {
  if (signal.stage !== 'merged' || signal.pullRequests.length === 0) return { closed: [], kept: [] };
  const merged = new Set(signal.pullRequests);
  // As a delivery records it, only a signal that names one commit names the merge commit.
  const mergeCommit = signal.commits.length === 1 ? signal.commits[0] : undefined;
  const projects = new Map(
    (await context.engine.listProjects())
      .filter((project) => mayReach(context.principal, project.id, 'write'))
      .map((project) => [project.id, project]),
  );
  if (projects.size === 0) return { closed: [], kept: [] };
  const inProgress = await context.engine.listBoard(null, { statuses: ['in_progress'], withoutExternalLinks: true });
  const actor = actorOf(context.principal, undefined);
  const closed: { id: string }[] = [];
  const kept: { id: string; why: string }[] = [];
  for (const task of inProgress) {
    const project = projects.get(task.projectId);
    const pullRequest = task.work.pr === undefined ? null : pullRequestUrl(task.work.pr);
    if (project === undefined || pullRequest === null || !merged.has(pullRequest)) continue;
    if (mergeCommit === undefined) {
      kept.push({ id: task.id, why: 'GitHub named no merge commit, which a close by a merge records as its proof' });
      continue;
    }
    const reason =
      `Closed by the merge of ${pullRequest} as ${mergeCommit.slice(0, 7)}, which GitHub reported; ` +
      "the task's work named that pull request.";
    const outcome: { why: string | null } = { why: null };
    try {
      await changing(context, project, task, actor, undefined, async (current) => {
        outcome.why = await keptByMerge(context, project, current, pullRequest);
        if (outcome.why !== null) return null;
        const shipped = shippedCard(current.metadata, reason, context.now());
        return {
          expectedVersion: current.version,
          close: {
            reason,
            resolution: 'done',
            ...closeProof({ pullRequest, commit: mergeCommit }, current.type, current.work),
          },
          comment: leftByHolder(current, pullRequest),
          ...(shipped === null ? {} : { metadata: { [NOTICEOS_METADATA.cardShipped]: shipped } }),
        };
      });
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      outcome.why = error.detail;
    }
    if (outcome.why === null) closed.push({ id: task.id });
    else kept.push({ id: task.id, why: outcome.why });
  }
  return { closed, kept };
}

/**
 * The tasks that waited on these, just closed, through a blocks link and are
 * now ready, each once, most urgent first. A blocks link stays in its
 * project, so each closed task's waiting tasks are read in its own project.
 */
export async function unblockedBy(
  { engine }: Reader,
  closed: readonly Task[],
): Promise<{ readonly id: string; readonly title: string }[]> {
  const done = new Set(closed.map((task) => task.id));
  const waiting = new Map<string, Set<string>>();
  for (const task of closed) {
    for (const link of task.dependents) {
      if (link.type !== 'blocks' || link.status === 'closed' || done.has(link.taskId)) continue;
      const ids = waiting.get(task.projectId) ?? new Set<string>();
      ids.add(link.taskId);
      waiting.set(task.projectId, ids);
    }
  }
  // One read holds at most a page of ids.
  const reads = [...waiting].flatMap(([projectId, ids]) => {
    const all = [...ids];
    return Array.from({ length: Math.ceil(all.length / TASK_LIMITS.page) }, (_, page) =>
      engine.getTasks(projectId, all.slice(page * TASK_LIMITS.page, (page + 1) * TASK_LIMITS.page)),
    );
  });
  const read = await Promise.all(reads);
  return read
    .flat()
    .filter((task) => task.ready)
    .map((task) => ({ id: task.id, title: task.title }));
}

// ─── Comments, links and approvals ────────────────────────────────────────────

/** The refusal a comment that records work details meets when the sender does not hold the open task. */
function notHolding(task: Task, actor: Actor): Refused | null {
  const id = task.id;
  if (task.status === 'closed')
    return refused(
      `refused: ${id} is closed, so it has no work in hand to record. Send the comment without for and the work details.`,
      `${id} is closed.`,
    );
  if (task.assignee === null)
    return refused(
      `refused: nobody holds ${id}, so it has no work in hand to record. Claim it with claim_task, passing these details.`,
      `Nobody holds ${id}.`,
    );
  if (task.assignee !== actor.name)
    return refused(
      `refused: ${id} is held by ${task.assignee}, and only its holder records its work. Send the comment without for and the work details.`,
      `${id} is held by ${task.assignee}, and only its holder records its work.`,
    );
  return null;
}

/** Adds a comment. With `update`, the holder also records its helper and
 * work details, in the same change. */
export async function commentOnTask(
  context: WriteContext,
  projectId: string,
  taskId: string,
  text: string,
  retryRequest?: RetryRequest,
  update?: WorkArgs,
  model?: string,
  pins?: CommentPins,
  test?: TaskTestResult,
): Promise<{ readonly project: Project; readonly comment: TaskComment; readonly replayed: boolean }> {
  const project = await projectOf(context, projectId, 'write');
  const task = await taskOf(context, project, taskId);
  const retry = await retryOf(context.principal, retryRequest);
  if (update !== undefined) {
    const replay = await recorded(context, project, retry);
    if (replay?.comment !== undefined) return { project, comment: replay.comment, replayed: true };
    const actor = actorOf(context.principal, model);
    const result = await changing(context, project, task, actor, retry, async (current) => {
      const refusal = notHolding(current, actor);
      if (refusal !== null) throw refusal;
      // Details that change nothing leave the version as a plain comment does.
      return {
        expectedVersion: current.version,
        set: update,
        comment: text,
        ...(pins === undefined ? {} : { pins }),
        ...(test === undefined ? {} : { test }),
      };
    });
    if (result.comment === undefined) throw unavailable(retry !== undefined);
    return { project, comment: result.comment, replayed: result.replayed };
  }
  try {
    const { comment, replayed } = await context.engine.addComment(
      project.id,
      taskId,
      text,
      actorOf(context.principal, model),
      retry,
      pins,
      test,
    );
    return { project, comment, replayed };
  } catch (error) {
    throw fromEngine(error);
  }
}

/** The link a pair of tasks has, read from one of them: its own onto the
 * other, or the other's onto it. A pair holds one link. */
function pairLinks(task: Task, other: string) {
  return {
    own: task.dependencies.find((link) => link.taskId === other),
    theirs: task.dependents.find((link) => link.taskId === other),
  };
}

/**
 * Sets the one link between two tasks: `taskId` links to `to` as `type`, read
 * as get_task lists it among the task's dependencies (blocks: the task waits
 * on `to`). A link the pair has already, either way round, is replaced in the
 * same write; with `type` null the pair's link is removed. Asking again
 * changes nothing. A link to or from a person's decision changes only when
 * the person decides; a new one may be added.
 */
export async function linkTasks(
  context: WriteContext,
  projectId: string,
  taskId: string,
  to: string,
  type: DependencyType | null,
  model?: string,
): Promise<{
  readonly replaced: { readonly task: string; readonly to: string; readonly type: DependencyType } | null;
}> {
  const project = await projectOf(context, projectId, 'write');
  const task = await taskOf(context, project, taskId);
  const owner = type === null || ACROSS_PROJECTS.includes(type) ? ((await ownerOf(context, to)) ?? project) : project;
  if (type !== null) await linkTargets(context, project, [{ taskId: to, type }]);
  const other = await context.engine.getTask(owner.id, to);
  if (other === null) await tasksIn(context, owner, [to]);
  const actor = actorOf(context.principal, model);
  const standing = pairLinks(task, to);
  const replaced =
    standing.own !== undefined
      ? { task: taskId, to, type: standing.own.type }
      : standing.theirs !== undefined
        ? { task: to, to: taskId, type: standing.theirs.type }
        : null;
  const changes = type === null ? replaced !== null : standing.theirs !== undefined || standing.own?.type !== type;
  if (!changes) return { replaced: null };
  if (replaced !== null && (isDecision(task) || (other !== null && isDecision(other))))
    throw decisionRefusal(isDecision(task) ? task.id : to);
  const loop = refused(
    `refused: ${to} already waits on ${taskId}, so ${taskId} cannot wait on it: the two would wait on each other in a loop.`,
    `${to} already waits on ${taskId}, so ${taskId} cannot wait on it.`,
  );
  // The other task's own link onto this one is removed in the same batch, so
  // it must be in this project; a link across projects is changed from its own side.
  if (standing.theirs !== undefined && owner.id !== project.id) {
    throw refused(
      `refused: ${to} links to ${taskId} as ${standing.theirs.type}, and ${to} is in another project; ` +
        `change that link from its side: link_tasks with task ${to} and to ${taskId}.`,
      `${to} links to ${taskId} from another project; change it there.`,
    );
  }
  const writeOn = standing.theirs === undefined ? task : (other ?? task);
  // The task holding the old link is written first, so its removal lands
  // before the new link's loop check reads the links.
  await changing(
    context,
    project,
    writeOn,
    actor,
    undefined,
    async (current) => {
      const fresh = pairLinks(current, current.id === taskId ? to : taskId);
      if (current.id === taskId) {
        return type === null
          ? fresh.own === undefined
            ? null
            : { expectedVersion: current.version, removeLinks: [to] }
          : fresh.own?.type === type
            ? null
            : { expectedVersion: current.version, addLinks: [{ taskId: to, type }] };
      }
      // Written on the other task: drop its link onto this one, and set or drop this one's.
      const mine = await taskOf(context, project, taskId);
      const own = pairLinks(mine, to).own;
      const beside =
        type !== null ? { addLinks: [{ taskId: to, type }] } : own === undefined ? null : { removeLinks: [to] };
      if (fresh.own === undefined && beside === null) return null;
      // Its link went meanwhile: a retry reads the pair again and writes this task alone.
      if (fresh.own === undefined) throw unavailable(false);
      return {
        expectedVersion: current.version,
        ...(fresh.own === undefined ? {} : { removeLinks: [taskId] }),
        ...(beside === null ? {} : { others: [{ taskId, expectedVersion: mine.version, ...beside }] }),
      };
    },
    loop,
  );
  return { replaced };
}

/** Opens an approval the task waits on, or returns the open one already
 * asking the same thing, so a repeated request never asks a person twice. A
 * request with a title asks the same only of an approval with that title, and
 * one that names a pull request only of an approval that gates it. */
export async function requestApproval(
  context: WriteContext,
  projectId: string,
  taskId: string,
  request: ApprovalRequest,
  model?: string,
): Promise<{ readonly gate: Task; readonly created: boolean }> {
  const project = await projectOf(context, projectId, 'write');
  let task = await taskOf(context, project, taskId);
  const actor = actorOf(context.principal, model);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (task.status === 'closed') throw closedRefusal(task.id);
    const open = (await openGates(context, project, task)).find(
      (gate) =>
        gate.awaitType === 'human' &&
        asksAlike(gate.description, request.reason) &&
        (request.title === undefined || gate.title === request.title) &&
        (request.pullRequest === undefined || gatedPullRequest(gate) === request.pullRequest),
    );
    if (open !== undefined) return { gate: open, created: false };
    try {
      const { created } = await context.engine.writeTask(
        project.id,
        task.id,
        { expectedVersion: task.version, requestApproval: request },
        actor,
      );
      return { gate: created[0]!, created: true };
    } catch (error) {
      if (!(error instanceof TaskRefused) || error.refusal !== 'version_conflict') throw fromEngine(error);
      task = await taskOf(context, project, task.id);
    }
  }
  throw unavailable(false);
}

/** Whether an open gate already asks for these steps: the same title and the same steps in order. */
function asksForSteps(gate: Task, request: ActionRequest): boolean {
  const steps = gate.steps;
  return (
    steps !== null &&
    gate.title === request.title &&
    steps.length === request.steps.length &&
    steps.every(
      (step, index) =>
        step.text === request.steps[index]!.text && step.command === (request.steps[index]!.command ?? null),
    )
  );
}

/** Opens a request that a person do steps, which the task waits on until
 * they tick every one, or returns the open one already asking for the same
 * steps, so a repeated request never asks a person twice. */
export async function requestAction(
  context: WriteContext,
  projectId: string,
  taskId: string,
  request: ActionRequest,
  model?: string,
): Promise<{ readonly gate: Task; readonly created: boolean }> {
  const project = await projectOf(context, projectId, 'write');
  let task = await taskOf(context, project, taskId);
  const actor = actorOf(context.principal, model);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (task.status === 'closed') throw closedRefusal(task.id);
    const open = (await openGates(context, project, task)).find((gate) => asksForSteps(gate, request));
    if (open !== undefined) return { gate: open, created: false };
    try {
      const { created } = await context.engine.writeTask(
        project.id,
        task.id,
        { expectedVersion: task.version, requestAction: request },
        actor,
      );
      return { gate: created[0]!, created: true };
    } catch (error) {
      if (!(error instanceof TaskRefused) || error.refusal !== 'version_conflict') throw fromEngine(error);
      task = await taskOf(context, project, task.id);
    }
  }
  throw unavailable(false);
}

// ─── Custom fields ────────────────────────────────────────────────────────────

/** Runs `work`, turning an engine refusal into the API's. */
async function engineChecked<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw fromEngine(error);
  }
}

/** The project's custom fields, retired ones included. */
export async function fieldsOf(
  context: Reader,
  projectId: string,
): Promise<{
  readonly project: Project;
  readonly fields: readonly CustomField[];
}> {
  const project = await projectOf(context, projectId);
  return { project, fields: await context.engine.listFields(project.id) };
}

/** Filters by the project's custom fields, checked against them, which are
 * read unless the caller has read them: `at` names the argument in a refusal. */
export async function fieldFiltersOf(
  context: Reader,
  project: Project,
  values: unknown,
  at: string,
  fields?: readonly CustomField[],
): Promise<Record<string, string | number | boolean>> {
  return engineChecked(async () => fieldFilters(fields ?? (await context.engine.listFields(project.id)), values, at));
}

/** Defines a custom field in a project the sender may change. */
export async function defineField(
  context: WriteContext,
  projectId: string,
  input: DefineFieldInput,
  retryRequest?: RetryRequest,
  model?: string,
): Promise<{ readonly project: Project; readonly field: CustomField; readonly replayed: boolean }> {
  const project = await projectOf(context, projectId, 'write');
  const retry = await retryOf(context.principal, retryRequest);
  const { field, replayed } = await engineChecked(() =>
    context.engine.defineField(project.id, input, actorOf(context.principal, model), retry),
  );
  return { project, field, replayed };
}

/** Retires a custom field in a project the sender may change: it takes no new values. */
export async function retireField(
  context: WriteContext,
  projectId: string,
  key: string,
  retryRequest?: RetryRequest,
  model?: string,
): Promise<{ readonly project: Project; readonly field: CustomField; readonly replayed: boolean }> {
  const project = await projectOf(context, projectId, 'write');
  const retry = await retryOf(context.principal, retryRequest);
  try {
    const { field, replayed } = await context.engine.retireField(
      project.id,
      key,
      actorOf(context.principal, model),
      retry,
    );
    return { project, field, replayed };
  } catch (error) {
    if (error instanceof TaskRefused && error.refusal === 'not_found')
      throw new Refused(
        'not_found',
        `refused: ${projectNamed(project)} has no field ${key}; list_fields lists its fields.`,
        `${project.name} has no field ${key}.`,
      );
    throw fromEngine(error);
  }
}

// ─── Lint ─────────────────────────────────────────────────────────────────────

/** What lint finds missing from each of these tasks, as they stand after a
 * write, or null when it could not be read: the write has happened either way. */
export async function lintOf(
  { engine }: Reader,
  projectId: string,
  tasks: readonly Task[],
): Promise<ReadonlyMap<string, readonly string[]> | null> {
  if (tasks.length === 0) return new Map();
  try {
    return await engine.lint(
      projectId,
      tasks.map((task) => task.id),
    );
  } catch {
    return null;
  }
}

/** Lint's answer for one task, with advice when there is some; missing is
 * left out when lint could not be read. */
export function lintView(
  found: ReadonlyMap<string, readonly string[]> | null,
  taskId: string,
  advice: readonly string[] = [],
): Record<string, readonly string[]> | null {
  if (found === null) return advice.length ? { advice } : null;
  return { missing: found.get(taskId) ?? [], ...(advice.length ? { advice } : {}) };
}
