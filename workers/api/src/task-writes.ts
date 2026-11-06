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
  TaskRefused,
  type Actor,
  type CreateTaskInput,
  type DependencyType,
  type JsonObject,
  type NewTaskLink,
  type Project,
  type Retry,
  type Task,
  type TaskComment,
  type TaskResolution,
  type TaskStatus,
  type TaskType,
  type TaskWrite,
  type WriteResult,
} from '@ntasks/domain';
import { listed } from './args.ts';
import type { Principal } from './auth.ts';
import { ownerOf, projectOf, taskOf, tasksIn, type Reader } from './lookup.ts';
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
}

/** What a write's retry record is kept under. */
export interface RetryRequest {
  /** The operation's name, such as create_task. */
  readonly operation: string;
  /** The caller's idempotency key. */
  readonly key: string;
  /** What the caller sent, without the key: a retry that sends anything else is refused. */
  readonly request: unknown;
}

/** How many times a write reads its task again after another write changed it first. */
const ATTEMPTS = 3;
const OPEN_STATUSES: readonly Exclude<TaskStatus, 'closed'>[] = ['open', 'in_progress', 'blocked', 'deferred'];

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

async function retryOf(principal: Principal, retry: RetryRequest | undefined): Promise<Retry | undefined> {
  if (retry === undefined) return undefined;
  return {
    principal: principal.id,
    operation: retry.operation,
    key: retry.key,
    requestHash: await sha256(canonical(retry.request)),
  };
}

function actorOf(principal: Principal, model: string | undefined): Actor {
  return model === undefined ? { name: principal.name } : { name: principal.name, model };
}

/** A gate, or a task labelled human: a person's to answer. */
function isDecision(task: Pick<Task, 'type' | 'labels'>): boolean {
  return task.type === 'gate' || task.labels.includes('human');
}

/** The open tasks this one waits on through `blocks` links. */
function openBlockers(task: Task): string[] {
  return task.dependencies
    .filter((link) => link.type === 'blocks' && link.status !== 'closed')
    .map((link) => link.taskId);
}

/** The open gates among the tasks this one waits on. */
async function openGates({ engine }: Reader, project: Project, task: Task): Promise<Task[]> {
  const blockers = await Promise.all(openBlockers(task).map((id) => engine.getTask(project.id, id)));
  return blockers.filter((blocker): blocker is Task => blocker !== null && blocker.type === 'gate');
}

/** The answer an earlier write with this retry identity gave, or null. */
async function recorded({ engine }: Reader, project: Project, retry: Retry | undefined): Promise<WriteResult | null> {
  if (retry === undefined) return null;
  try {
    return await engine.recordedWrite(project.id, retry);
  } catch (error) {
    throw fromEngine(error);
  }
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
async function changing(
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

/** The task ids a new task or a change links to: a related link may name a
 * task in another project the sender reaches; every other link stays in the project. */
async function linkTargets(
  context: WriteContext,
  project: Project,
  links: readonly { readonly taskId: string; readonly related: boolean }[],
): Promise<void> {
  const local: string[] = [];
  for (const link of links) {
    const owner = link.related ? await ownerOf(context, link.taskId) : undefined;
    if (owner !== undefined && owner.id !== project.id) await tasksIn(context, owner, [link.taskId]);
    else local.push(link.taskId);
  }
  await tasksIn(context, project, local);
}

// ─── Creating a task ──────────────────────────────────────────────────────────

/** A new task's link: what the new task depends on, blocks, relates to or was found from. */
export interface NewLink {
  readonly kind: 'depends_on' | 'blocks' | 'related' | 'discovered_from';
  readonly taskId: string;
}

const ENGINE_LINKS: Readonly<Record<NewLink['kind'], Omit<NewTaskLink, 'taskId'>>> = Object.freeze({
  depends_on: { direction: 'depends-on', type: 'blocks' },
  blocks: { direction: 'blocks', type: 'blocks' },
  related: { direction: 'depends-on', type: 'related' },
  discovered_from: { direction: 'depends-on', type: 'discovered-from' },
});

export interface NewTask {
  readonly title: string;
  readonly description?: string;
  readonly type?: Exclude<TaskType, 'gate'>;
  readonly priority?: number;
  readonly labels?: readonly string[];
  readonly parent?: string;
  readonly acceptance?: string;
  readonly links?: readonly NewLink[];
  /** What a person must approve before the task proceeds. */
  readonly approval?: string;
  readonly choices?: JsonObject;
  /** A card's figures, without who wrote it and when. */
  readonly card?: JsonObject;
  readonly changeClass?: string;
  /** Where the task came from, such as a copied handoff. */
  readonly metadata?: JsonObject;
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
  const links = task.links ?? [];
  if (task.parent !== undefined) await tasksIn(context, project, [task.parent]);
  await linkTargets(
    context,
    project,
    links.map((link) => ({ taskId: link.taskId, related: link.kind === 'related' })),
  );
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
    ...(task.type === undefined ? {} : { type: task.type }),
    ...(task.priority === undefined ? {} : { priority: task.priority }),
    ...(task.parent === undefined ? {} : { parentId: task.parent }),
    ...(task.labels === undefined ? {} : { labels: task.labels }),
    links: links.map((link) => ({ ...ENGINE_LINKS[link.kind], taskId: link.taskId })),
    ...(typeof due === 'string' ? { dueAt: due } : {}),
    ...(task.choices === undefined ? {} : { choices: task.choices }),
    metadata,
    ...(task.approval === undefined ? {} : { requestApproval: { reason: task.approval } }),
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

export interface TaskChange {
  /** Take the task: the sender becomes its assignee and it moves to in progress. */
  readonly claim?: true;
  /** On a closed task, any status opens it again. */
  readonly status?: Exclude<TaskStatus, 'closed'>;
  readonly priority?: number;
  readonly title?: string;
  readonly description?: string;
  readonly acceptance?: string;
  /** null releases the task. */
  readonly assignee?: string | null;
  /** null takes the task out of its parent. */
  readonly parent?: string | null;
  /** A date, YYYY-MM-DD, or null to clear it. */
  readonly defer?: string | null;
  readonly addLabels?: readonly string[];
  readonly removeLabels?: readonly string[];
  /** Tasks to link as related, in this project or another the sender reaches. */
  readonly related?: readonly string[];
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

/** The write that makes `change` to `task` as it stands, or null when it changes nothing. */
function planChange(context: WriteContext, task: Task, change: TaskChange, actor: Actor): TaskWrite | null {
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

  const set: Record<string, unknown> = {};
  const put = (field: string, value: unknown, current: unknown) => {
    if (value !== undefined && !same(value, current)) set[field] = value;
  };
  put('title', change.title, task.title);
  put('description', change.description, task.description);
  put('acceptance', change.acceptance, task.acceptance);
  put('priority', change.priority, task.priority);
  put('parentId', change.parent, task.parentId);
  put(
    'deferUntil',
    change.defer === undefined || change.defer === null ? change.defer : `${change.defer}T00:00:00.000Z`,
    task.deferUntil,
  );
  put('choices', change.choices, task.choices);
  const reopen = change.status !== undefined && task.status === 'closed';
  if (reopen) set.status = change.status;
  else put('status', change.status, task.status);
  if (change.claim) {
    put('assignee', actor.name, task.assignee);
    put('status', 'in_progress', task.status);
  } else {
    put('assignee', change.assignee, task.assignee);
  }

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
  const related = [...new Set(change.related ?? [])].filter((id) => !linked.has(id));

  const write: TaskWrite = {
    expectedVersion: task.version,
    ...(Object.keys(set).length > 0 ? { set } : {}),
    ...(reopen ? { reopen: true as const } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(addLabels.length > 0 ? { addLabels } : {}),
    ...(removeLabels.length > 0 ? { removeLabels } : {}),
    ...(related.length > 0 ? { addLinks: related.map((taskId) => ({ taskId, type: 'related' as const })) } : {}),
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
  if (change.related?.includes(taskId))
    throw new Refused('invalid', 'invalid arguments: related (another task than this one)');
  if (typeof change.parent === 'string') await tasksIn(context, project, [change.parent]);
  await linkTargets(
    context,
    project,
    (change.related ?? []).map((id) => ({ taskId: id, related: true })),
  );
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
    async (current) => planChange(context, current, change, actor),
    loop,
  );
  return { project, result };
}

// ─── Closing a task ───────────────────────────────────────────────────────────

export interface TaskClosing {
  /** The evidence: a commit or a link, or why nothing shipped. */
  readonly reason: string;
  /** done when left out. */
  readonly resolution?: TaskResolution;
  /** With duplicate: the task this one duplicates, in the same project. */
  readonly duplicateOf?: string;
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
    if (current.status === 'closed') throw closedRefusal(id);
    if (current.assignee !== null && current.assignee !== actor.name) {
      const holder = current.assignee;
      throw refused(
        `refused: ${id} is held by ${holder}, and only its holder closes it. ` +
          `Reach ${holder} with comment_on_task, or ask a person to close it in the web app.`,
        `${id} is held by ${holder}, and only its holder closes it.`,
      );
    }
    const gates = await openGates(context, project, current);
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
      close: { reason: closing.reason, resolution, ...(duplicateOf === undefined ? {} : { duplicateOf }) },
      ...(shipped === null ? {} : { metadata: { [NOTICEOS_METADATA.cardShipped]: shipped } }),
      // The two are linked as related, so either task's page reaches the other.
      ...(duplicateOf === undefined || linked ? {} : { addLinks: [{ taskId: duplicateOf, type: 'related' as const }] }),
    };
  });
  return { project, result };
}

// ─── Comments, dependencies and approvals ─────────────────────────────────────

export async function commentOnTask(
  context: WriteContext,
  projectId: string,
  taskId: string,
  text: string,
  retryRequest?: RetryRequest,
): Promise<{ readonly project: Project; readonly comment: TaskComment; readonly replayed: boolean }> {
  const project = await projectOf(context, projectId, 'write');
  await taskOf(context, project, taskId);
  const retry = await retryOf(context.principal, retryRequest);
  try {
    const { comment, replayed } = await context.engine.addComment(
      project.id,
      taskId,
      text,
      actorOf(context.principal, undefined),
      retry,
    );
    return { project, comment, replayed };
  } catch (error) {
    throw fromEngine(error);
  }
}

/** Records that a task depends on another. Asking again for a link that
 * stands changes nothing; a link keeps the type it was added with. */
export async function addDependency(
  context: WriteContext,
  projectId: string,
  taskId: string,
  dependsOn: string,
  type: DependencyType,
): Promise<void> {
  const project = await projectOf(context, projectId, 'write');
  const task = await taskOf(context, project, taskId);
  await linkTargets(context, project, [{ taskId: dependsOn, related: type === 'related' }]);
  const loop = refused(
    `refused: ${dependsOn} already waits on ${taskId}, so ${taskId} cannot depend on it: the two would wait on each other in a loop.`,
    `${dependsOn} already waits on ${taskId}, so ${taskId} cannot depend on it.`,
  );
  await changing(
    context,
    project,
    task,
    actorOf(context.principal, undefined),
    undefined,
    async (current) => {
      const standing = current.dependencies.find((link) => link.taskId === dependsOn);
      if (standing?.type === type) return null;
      if (standing !== undefined) {
        throw refused(
          `refused: ${taskId} already depends on ${dependsOn} as ${standing.type}, and a dependency keeps the type it was ` +
            `added with. To record it as ${type}, remove_dependency first, then add it again.`,
          `${taskId} already depends on ${dependsOn} as ${standing.type}.`,
        );
      }
      return { expectedVersion: current.version, addLinks: [{ taskId: dependsOn, type }] };
    },
    loop,
  );
}

/** Removes a dependency. One on a person's decision stays until the person decides it. */
export async function removeDependency(
  context: WriteContext,
  projectId: string,
  taskId: string,
  dependsOn: string,
): Promise<void> {
  const project = await projectOf(context, projectId, 'write');
  const task = await taskOf(context, project, taskId);
  if (isDecision(task)) throw decisionRefusal(task.id);
  const owner = (await ownerOf(context, dependsOn)) ?? project;
  const other = await context.engine.getTask(owner.id, dependsOn);
  if (other !== null && isDecision(other)) throw decisionRefusal(other.id);
  if (other === null && !task.dependencies.some((link) => link.taskId === dependsOn))
    await tasksIn(context, project, [dependsOn]);
  await changing(context, project, task, actorOf(context.principal, undefined), undefined, async (current) =>
    current.dependencies.some((link) => link.taskId === dependsOn)
      ? { expectedVersion: current.version, removeLinks: [dependsOn] }
      : null,
  );
}

/** Opens an approval the task waits on, or returns the open one already
 * asking the same thing, so a repeated request never asks a person twice. */
export async function requestApproval(
  context: WriteContext,
  projectId: string,
  taskId: string,
  reason: string,
): Promise<{ readonly gate: Task; readonly created: boolean }> {
  const project = await projectOf(context, projectId, 'write');
  let task = await taskOf(context, project, taskId);
  const actor = actorOf(context.principal, undefined);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (task.status === 'closed') throw closedRefusal(task.id);
    const open = (await openGates(context, project, task)).find(
      (gate) => gate.awaitType === 'human' && asksAlike(gate.description, reason),
    );
    if (open !== undefined) return { gate: open, created: false };
    try {
      const { created } = await context.engine.writeTask(
        project.id,
        task.id,
        { expectedVersion: task.version, requestApproval: { reason } },
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

// ─── Lint ─────────────────────────────────────────────────────────────────────

/** A decision's sections that record its outcome, which a decision with choices records as its pick instead. */
const OUTCOME = /^(?:##\s*)?(?:Decision|Rationale|Alternatives Considered)$/iu;

/** What lint finds missing from each of these tasks, as they stand after a
 * write, or null when it could not be read: the write has happened either way. */
export async function lintOf(
  { engine }: Reader,
  projectId: string,
  tasks: readonly Task[],
): Promise<ReadonlyMap<string, readonly string[]> | null> {
  if (tasks.length === 0) return new Map();
  let found: ReadonlyMap<string, readonly string[]>;
  try {
    found = await engine.lint(
      projectId,
      tasks.map((task) => task.id),
    );
  } catch {
    return null;
  }
  const missing = new Map<string, readonly string[]>(tasks.map((task) => [task.id, found.get(task.id) ?? []]));
  for (const task of tasks) {
    const sections = found.get(task.id);
    if (sections === undefined || task.type !== 'decision' || task.choices === null) continue;
    const kept = sections.filter((section) => !OUTCOME.test(section));
    if (task.choice !== null) {
      for (const section of ['Decision', 'Rationale']) {
        if (!new RegExp(`^#{1,6}\\s+${section}\\s*#*\\s*$`, 'imu').test(task.description)) kept.push(`## ${section}`);
      }
    }
    missing.set(task.id, kept);
  }
  return missing;
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
