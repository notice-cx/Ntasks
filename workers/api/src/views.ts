/**
 * Tasks as the API's clients read them. The field names are the ones NoticeOS's
 * web pages and task tools used, so the web app and agents written for them
 * read Ntasks unchanged: `issueType` and `parent` on the web app's task,
 * `type` and `parent` on an MCP task, and NoticeOS's own fields (card,
 * cardShipped, changeClass) read from the metadata keys NoticeOS writes.
 */
import {
  lacksProof,
  type CustomField,
  type Json,
  type JsonObject,
  type Task,
  type TaskComment,
  type TaskEvent,
} from '@ntasks/domain';
import { NOTICEOS_METADATA as NOTICEOS, TASK_CHANGE_CLASSES } from './noticeos-fields.ts';
import { shortHash } from './short-hash.ts';

const CHANGE_CLASSES: readonly string[] = TASK_CHANGE_CLASSES;

function objectOrNull(value: Json | undefined): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function changeClassOf(metadata: JsonObject): string | null {
  const value = metadata[NOTICEOS.changeClass];
  return typeof value === 'string' && CHANGE_CLASSES.includes(value) ? value : null;
}

/** A gate imported from Beads keeps its ask in its description as
 * `Reason: <text>`, under the title "Gate: human"; that ask is its title. */
function titleOf(task: Task): string {
  if (task.type !== 'gate') return task.title;
  const reason = /(?:^|\n)Reason:[ \t]*([\s\S]+)$/u.exec(task.description)?.[1]?.trim();
  return reason ? reason.slice(0, 400) : task.title;
}

/**
 * Whether a task waits on a person: an open human gate, which a person
 * approves, or a ready task labelled `human` that carries no choice yet,
 * which a person answers. A deferred or closed task waits on nobody.
 */
export function waitsOnPerson(task: Task): boolean {
  if (task.status === 'deferred' || task.status === 'closed') return false;
  if (task.type === 'gate') return (task.awaitType ?? 'human') === 'human';
  return task.choice === null && task.type !== 'epic' && task.labels.includes('human') && task.ready;
}

/**
 * The text an owner's answer is checked against: the task as the owner saw it
 * when asked. An answer recorded later must name this exact text, so a task
 * edited after the question was asked cannot borrow the answer. A request's
 * steps count with their text and commands, not with anyone's marks on them,
 * so a tick leaves the proposal as it was.
 */
export function proposalOf(
  task: Pick<Task, 'id' | 'title' | 'description' | 'acceptance' | 'type' | 'choices' | 'steps'>,
): string {
  const asked = [task.id, task.title, task.description, task.acceptance, task.type, task.choices];
  const steps = task.steps?.map((step) => [step.text, step.command]);
  return JSON.stringify(steps === undefined ? asked : [...asked, steps]);
}

/** A proposal version as an answer names it. 128 bits, so nobody can write two
 * proposals with one version and swap one for the other under an answer. */
export const PROPOSAL_VERSION = /^[0-9a-f]{32}$/u;

/** The proposal's version, which an owner's answer names: the first 32
 * hexadecimal characters of the SHA-256 of `proposalOf(task)`. */
export function proposalVersionOf(
  task: Pick<Task, 'id' | 'title' | 'description' | 'acceptance' | 'type' | 'choices' | 'steps'>,
): Promise<string> {
  return shortHash(proposalOf(task), 32);
}

/** The actions that record an owner's answer, as the answer record names them. */
const OWNER_ANSWERS: readonly Json[] = ['answer', 'declined', 'owner_performed'];

/**
 * The latest owner answer recorded on a task: what was chosen, the owner's
 * words, where they said it, who recorded it and how, and the proposal
 * version it answered; null when none is recorded. `option` is a letter on a
 * task with choices, `approve` or `decline` on an approval, `done` or
 * `decline` on a request to do steps, and null when the answer chose none of
 * the options.
 */
export function answerOf(task: Pick<Task, 'type' | 'metadata' | 'steps'>) {
  const record = objectOrNull(task.metadata[NOTICEOS.maintenance]);
  if (record === null) return null;
  const events = Array.isArray(record.events) ? record.events : [];
  // The record holds the latest disposition, and `events` the earlier ones, oldest first.
  const answer = [record, ...[...events].reverse()]
    .map(objectOrNull)
    .find((entry) => entry !== null && OWNER_ANSWERS.includes(entry.action ?? null));
  if (!answer || typeof answer.by !== 'string' || typeof answer.at !== 'string') return null;
  const text = (value: Json | undefined) => (typeof value === 'string' ? value : null);
  const disputed = objectOrNull(answer.disputed);
  return {
    option:
      task.type === 'gate'
        ? answer.action === 'declined'
          ? 'decline'
          : task.steps === null
            ? 'approve'
            : 'done'
        : text(answer.option),
    quote: text(answer.response),
    source: text(answer.source),
    recordedBy: answer.by,
    /** A person who answered in the web app recorded it directly; an agent or a service relayed it. */
    relayed: answer.verification !== 'person',
    /** The client id of the connected app the person answered through; null in the web app or when relayed. */
    app: text(answer.app),
    proposalVersion: text(answer.proposalVersion),
    at: answer.at,
    disputedBy: text(disputed?.by),
  };
}

/** A task as the web app's pages read it. */
export function webTask(task: Task) {
  return {
    id: task.id,
    title: titleOf(task),
    status: task.status,
    priority: task.priority,
    issueType: task.type,
    assignee: task.assignee,
    updatedAt: task.updatedAt,
    closedAt: task.close?.at ?? null,
    /** Who closed it and the model they named; null when imported without them. */
    closedBy: task.close?.by ?? null,
    closedModel: task.close?.model ?? null,
    /** The model the assignee named when they claimed it. */
    assigneeModel: task.assigneeModel,
    /** The helper agent the assignee works through: claude for page-rebuild-2. */
    for: task.assigneeFor,
    /** What the assignee recorded about the work in hand: session, worktree, branch, pr, commit and next. */
    work: task.work,
    /** When the assignee last changed or commented on the task. */
    lastActivityAt: task.lastActivityAt,
    parent: task.parentId,
    deferUntil: task.deferUntil,
    dueAt: task.dueAt,
    description: task.description,
    acceptance: task.acceptance,
    notes: task.notes,
    design: task.design,
    estimateMinutes: task.estimateMinutes,
    labels: task.labels,
    ready: task.ready,
    dependencies: task.dependencies.map((link) => ({
      id: link.taskId,
      type: link.type,
      title: link.title,
      status: link.status,
    })),
    externalLinks: task.externalLinks.map(({ url, title, kind }) => ({ url, title, kind })),
    fields: task.fields,
    comments: task.commentCount,
    metadata: task.metadata,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    closeReason: task.close?.reason ?? null,
    /** The URL a close as done named to show the work. */
    closeLink: task.close?.link ?? null,
    /** On a task a person accepted as done on their own call: who, who relayed it for them, and each criterion met or waived. */
    closeAcceptance: task.close?.acceptance ?? null,
    /** "none" for a task, bug, feature or chore closed as done with no commit, pull request or link. */
    proof: lacksProof(task) ? ('none' as const) : null,
    awaitType: task.awaitType,
    /** On a request that a person do steps: each step, with who ticked it, their note and where they got stuck. */
    steps: task.steps,
    choices: task.choices,
    choice: task.choice,
    answer: answerOf(task),
    card: objectOrNull(task.metadata[NOTICEOS.card]),
    cardShipped: objectOrNull(task.metadata[NOTICEOS.cardShipped]),
    changeClass: changeClassOf(task.metadata),
    resolution: task.close?.resolution ?? null,
    duplicateOf: task.close?.duplicateOf ?? null,
    /** Where a closed task's change is: built, merged or live; null when it has no delivery. */
    delivery: task.delivery,
  };
}

/** Tasks as the web app's pages read them, each with `proposalVersion`: its
 * proposal's version while it waits on a person, which their answer names,
 * and null otherwise, so a long board hashes only the tasks someone answers. */
export function webTasks(tasks: readonly Task[]) {
  return Promise.all(
    tasks.map(async (task) => ({
      ...webTask(task),
      proposalVersion: waitsOnPerson(task) ? await proposalVersionOf(task) : null,
    })),
  );
}

/** A task in full, as get_task returns it. */
export function mcpTask(task: Task) {
  const web = webTask(task);
  return {
    id: task.id,
    title: web.title,
    status: task.status,
    priority: task.priority,
    type: task.type,
    assignee: task.assignee,
    for: task.assigneeFor,
    work: task.work,
    lastActivityAt: task.lastActivityAt,
    labels: task.labels,
    parent: task.parentId,
    ready: task.ready,
    awaitingHuman: waitsOnPerson(task),
    description: task.description,
    acceptance: task.acceptance,
    notes: task.notes,
    design: task.design,
    estimateMinutes: task.estimateMinutes,
    steps: task.steps,
    choices: task.choices,
    choice: task.choice,
    answer: web.answer,
    card: web.card,
    cardShipped: web.cardShipped,
    changeClass: web.changeClass,
    deferUntil: task.deferUntil,
    dependencies: web.dependencies,
    externalLinks: web.externalLinks,
    fields: task.fields,
    commentCount: task.commentCount,
    metadata: task.metadata,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    closedAt: web.closedAt,
    closeReason: web.closeReason,
    closeLink: web.closeLink,
    closeAcceptance: web.closeAcceptance,
    resolution: web.resolution,
    duplicateOf: web.duplicateOf,
    ...(task.delivery === null ? {} : { delivery: task.delivery }),
    ...(web.proof === null ? {} : { proof: web.proof }),
  };
}

/** A task as list_tasks shows it: enough to choose one, which get_task then
 * reads in full. Its long text (description, acceptance, notes and design) is
 * left out, and so is a field with no value, so a long page stays readable. */
export function mcpSummary(task: Task): Record<string, unknown> {
  const full = mcpTask(task);
  const row: Record<string, unknown> = {
    id: full.id,
    title: full.title,
    status: full.status,
    priority: full.priority,
    type: full.type,
    assignee: full.assignee,
    for: full.for,
    lastActivityAt: full.lastActivityAt,
    labels: full.labels,
    parent: full.parent,
    ready: full.ready,
    awaitingHuman: full.awaitingHuman,
    choices: full.choices,
    choice: full.choice,
    card: full.card,
    changeClass: full.changeClass,
    estimateMinutes: full.estimateMinutes,
    externalLinks: full.externalLinks,
    fields: full.fields,
    deferUntil: full.deferUntil,
    createdAt: full.createdAt,
    updatedAt: full.updatedAt,
    closedAt: full.closedAt,
    resolution: full.resolution,
    duplicateOf: full.duplicateOf,
    delivery: full.delivery ?? null,
    proof: full.proof ?? null,
  };
  return Object.fromEntries(
    Object.entries(row).filter(
      ([, value]) =>
        value !== null &&
        !(Array.isArray(value) && value.length === 0) &&
        !(typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0),
    ),
  );
}

/** A field of a task as get_task shows it. */
export type McpTaskField = keyof ReturnType<typeof mcpTask>;

/** A task as a write's reply shows it unless asked for all of it: its id,
 * the fields `named` lists as get_task shows them, and its version, which
 * goes up with each change. */
export function writtenView(task: Task, named: readonly McpTaskField[]): Record<string, unknown> {
  const full: Partial<Record<McpTaskField, unknown>> = mcpTask(task);
  return {
    id: task.id,
    ...Object.fromEntries([...new Set(named)].map((field) => [field, full[field] ?? null])),
    version: task.version,
  };
}

/** An epic's open child as get_task lists it: who holds it, for which helper, and when they last wrote to it. */
export function childView(task: Task) {
  return {
    id: task.id,
    title: titleOf(task),
    status: task.status,
    assignee: task.assignee,
    for: task.assigneeFor,
    lastActivityAt: task.lastActivityAt,
  };
}

/** A custom field as list_fields and the HTTP field routes show it. */
export function fieldView(field: CustomField) {
  return {
    key: field.key,
    name: field.name,
    type: field.type,
    options: field.options,
    createdAt: field.createdAt,
    retiredAt: field.retiredAt,
  };
}

export function commentView(comment: TaskComment) {
  return { id: comment.id, author: comment.author, text: comment.text, createdAt: comment.createdAt };
}

/** What a history event did, in the words get_task_history uses. */
function actionOf(event: TaskEvent): string {
  if (event.kind !== 'updated') return event.kind;
  if (event.changes.status === 'in_progress' && typeof event.changes.assignee === 'string') return 'claimed';
  return 'status' in event.changes ? 'status_changed' : 'updated';
}

/** A task as it stood at one version, rebuilt from its history, in get_task's field names. */
function snapshotView(state: Record<string, Json>) {
  const close = objectOrNull(state.close);
  const metadata = objectOrNull(state.metadata) ?? {};
  const dependencies = Array.isArray(state.dependencies) ? state.dependencies : [];
  const externalLinks = Array.isArray(state.externalLinks) ? state.externalLinks : [];
  const fields = objectOrNull(state.fields) ?? {};
  return {
    id: state.id ?? null,
    title: state.title ?? null,
    status: state.status ?? null,
    priority: state.priority ?? null,
    type: state.type ?? null,
    assignee: state.assignee ?? null,
    for: state.assigneeFor ?? null,
    work: objectOrNull(state.work) ?? {},
    labels: state.labels ?? [],
    parent: state.parentId ?? null,
    description: state.description ?? '',
    acceptance: state.acceptance ?? '',
    notes: state.notes ?? '',
    design: state.design ?? '',
    estimateMinutes: state.estimateMinutes ?? null,
    steps: state.steps ?? null,
    choices: state.choices ?? null,
    choice: state.choice ?? null,
    card: objectOrNull(metadata[NOTICEOS.card]),
    cardShipped: objectOrNull(metadata[NOTICEOS.cardShipped]),
    changeClass: changeClassOf(metadata),
    deferUntil: state.deferUntil ?? null,
    dependencies: dependencies.map((link) => {
      const entry = objectOrNull(link) ?? {};
      return { id: entry.taskId ?? null, type: entry.type ?? null };
    }),
    externalLinks,
    fields,
    metadata,
    startedAt: state.startedAt ?? null,
    closedAt: close?.at ?? null,
    closeReason: close?.reason ?? null,
    closeAcceptance: objectOrNull(close?.acceptance),
    resolution: close?.resolution ?? null,
    duplicateOf: close?.duplicateOf ?? null,
    delivery: objectOrNull(state.delivery),
  };
}

/**
 * A task's history as get_task_history returns it, newest first, from all of
 * its events oldest first. Each change names the fields it set with their old
 * and new values; with `snapshots`, each is the whole task as it then stood.
 */
export function historyView(events: readonly TaskEvent[], limit: number, snapshots: boolean) {
  const state: Record<string, Json> = {};
  const changes = events.map((event) => {
    const fields: Record<string, { old: Json; new: Json }> = {};
    if (event.kind === 'commented') {
      fields.comment = { old: null, new: event.changes.text ?? null };
    } else {
      for (const [field, value] of Object.entries(event.changes)) {
        fields[field] = { old: state[field] ?? null, new: value };
        state[field] = value;
      }
    }
    const base = { revision: String(event.seq), at: event.at, actor: event.actor, model: event.model };
    // A comment leaves the task as it was, so it is no version of its own.
    if (snapshots) return event.kind === 'commented' ? null : { ...base, task: snapshotView({ ...state }) };
    return { ...base, actions: [actionOf(event)], fields };
  });
  return changes
    .filter((change) => change !== null)
    .reverse()
    .slice(0, limit);
}
