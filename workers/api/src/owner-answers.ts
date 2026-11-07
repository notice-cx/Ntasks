/**
 * What counts as the owner's authority: a person's own answers, picks,
 * dismissals, approvals and disputes, and the owner answers an agent records
 * with reconcile_task. An answer is recorded as the option the owner chose on
 * the proposal version they saw, with their words as a quote; nothing reads
 * the quote to decide what it means. Each decision is one TaskWrite, so the
 * record, its comment, the close or hand-back and the changes to the tasks
 * waiting on it land together or not at all.
 */
import {
  TASK_LIMITS,
  type Json,
  type JsonObject,
  type Project,
  type Task,
  type TaskComment,
  type TaskFieldChanges,
  type TaskResolution,
  type TaskWrite,
} from '@ntasks/domain';
import { listed } from './args.ts';
import { SCOPES } from './auth.ts';
import { linksSeenBy, projectOf, taskOf, tasksIn } from './lookup.ts';
import {
  askedOf,
  choiceName,
  choicesOf,
  NOTICEOS_METADATA,
  TASK_CHOICE_KEYS,
  type TaskChoiceKey,
} from './noticeos-fields.ts';
import { Refused } from './refused.ts';
import {
  actorOf,
  changing,
  isDecision,
  OPEN_STATUSES,
  recorded,
  retryOf,
  type RetryRequest,
  type WriteContext,
  type Written,
} from './task-writes.ts';
import { proposalVersionOf } from './views.ts';

/** The metadata key the record of a task's last answer or maintenance is kept under. */
export const MAINTENANCE = NOTICEOS_METADATA.maintenance;

export const MAINTENANCE_ACTIONS = Object.freeze([
  'answer',
  'declined',
  'owner_performed',
  'completed',
  'obsolete',
  'superseded',
  'duplicate',
  'routine',
  'release',
] as const);
export type MaintenanceAction = (typeof MAINTENANCE_ACTIONS)[number];

/** The actions that record an answer the owner gave; the others maintain a request with evidence. */
export function isOwnerAnswer(action: MaintenanceAction): boolean {
  return action === 'answer' || action === 'declined' || action === 'owner_performed';
}

/** The sentence every refused owner answer ends with. */
export const NOT_RECORDED = 'The answer was not recorded.';

/**
 * A disposition an agent records: an owner answer it relays, or maintenance
 * with evidence. A record keeps `JSON.stringify` of it as its identity, so a
 * retry without an idempotency key finds it recorded.
 */
export interface TaskMaintenance {
  readonly taskId: string;
  readonly action: MaintenanceAction;
  /** The proposalVersion get_task returned for the proposal the owner saw, or the agent read. */
  readonly proposalVersion: string;
  readonly explanation?: string;
  readonly evidence?: string;
  readonly model?: string;
  /** The option the owner chose, on a task with choices; absent when they chose none. */
  readonly option?: TaskChoiceKey;
  /** The owner's exact words, recorded as given. */
  readonly quote?: string;
  /** Where the owner said it, such as the conversation. */
  readonly source?: string;
  readonly duplicateOf?: string;
  /** Checked inactivity and kept progress: age alone never releases a task. */
  readonly holder?: string;
  readonly inactive?: boolean;
  readonly activityCheck?: string;
  readonly progress?: string;
}

// ─── Refusals ─────────────────────────────────────────────────────────────────

/** A disposition refused: the same sentence for an agent and a person. */
function refuse(message: string): never {
  throw new Refused('state', `refused: ${message}`, message);
}

/** An owner answer refused, naming the argument at fault. */
function refuseAnswer(field: string, reason: string): never {
  throw new Refused('state', `refused: ${field}: ${reason}`, reason);
}

/** Why the task's own state refuses a decision, as an agent and a person read it. */
type StateReason =
  | { readonly kind: 'closed' }
  | { readonly kind: 'gate'; readonly gates: readonly string[]; readonly human: boolean }
  | { readonly kind: 'children'; readonly children: readonly string[] }
  | { readonly kind: 'chosen'; readonly chosen: string | null }
  | { readonly kind: 'no-choices' }
  | { readonly kind: 'no-option'; readonly option: string; readonly offered: readonly string[] };

/** `field`, when given, is the argument an agent's sentence names first. */
function refuseState(id: string, reason: StateReason, field?: string): never {
  const named = (message: string) => (field === undefined ? message : `${field}: ${message}`);
  switch (reason.kind) {
    case 'closed':
      throw new Refused(
        'state',
        `refused: ${named(`${id} is already closed; get_task shows its close reason.`)}`,
        `${id} is already closed.`,
      );
    case 'gate':
      throw new Refused(
        'state',
        `refused: ${named(
          reason.human
            ? `${id} waits on approval ${listed(reason.gates)}, which is still open. Use reconcile_task on the gate with the owner’s scoped answer, or action declined with their refusal; then close ${id} with implementation evidence. A declined action must not happen.`
            : `${id} waits on gate ${listed(reason.gates)}, which is still open. Close ${id} after it resolves.`,
        )}`,
        `${id} waits on approval ${listed(reason.gates)}. Approve it first.`,
      );
    case 'children':
      throw new Refused(
        'state',
        `refused: ${named(`${id} has open children: ${listed(reason.children)}. Close them first, or give them another parent with update_task.`)}`,
        `${id} has open tasks under it: ${listed(reason.children)}.`,
      );
    case 'chosen':
      throw new Refused(
        'state',
        `refused: ${named(
          `${id} already carries a person's choice${reason.chosen === null ? '' : `, ${reason.chosen}`}, and its choices ` +
            'stay as they were when it was made. get_task shows the choice; file work that remains with create_task.',
        )}`,
        reason.chosen === null ? `${id} already has a choice.` : `${id} already has a choice: ${reason.chosen}.`,
      );
    case 'no-choices':
      throw new Refused(
        'state',
        `refused: ${named(`${id} offers no choices.`)}`,
        `${id} offers no options to choose from.`,
      );
    case 'no-option':
      throw new Refused(
        'state',
        `refused: ${named(`${id} offers no option (${reason.option}).`)}`,
        `${id} offers ${listed(reason.offered.map((key) => `(${key})`))}, not (${reason.option}).`,
      );
  }
}

// ─── Reading what a task holds ────────────────────────────────────────────────

const isRecord = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Beads' actor match, which NoticeOS kept: a run of `.`, `_` or `-` is one separator, and `--` another. */
function canonicalActor(name: string): string {
  return name.replace(/[._-]+/gu, (run) => (run === '--' ? '/' : '_'));
}
function sameActor(a: string, b: string): boolean {
  return a === b || canonicalActor(a) === canonicalActor(b);
}

/** A recorded pick, read strictly; null for anything else. */
interface RecordedPick {
  readonly option: TaskChoiceKey;
  readonly label: string;
  readonly by: string;
  readonly at: string;
  readonly note?: string;
}
function pickOf(value: unknown): RecordedPick | null {
  if (!isRecord(value)) return null;
  const { option, label, by, at, note } = value;
  if (typeof option !== 'string' || !(TASK_CHOICE_KEYS as readonly string[]).includes(option)) return null;
  if (typeof label !== 'string' || !label.trim() || typeof by !== 'string' || !by.trim()) return null;
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return null;
  if (note !== undefined && (typeof note !== 'string' || !note.trim())) return null;
  return { option: option as TaskChoiceKey, label, by, at, ...(note === undefined ? {} : { note }) };
}

/** A task's choices as a pick reads them: the question, the options and the one recommended. */
interface Offered {
  readonly question: string;
  readonly options: readonly { readonly key: TaskChoiceKey; readonly label: string; readonly recommended?: boolean }[];
}
function offeredOf(task: Task): Offered | null {
  return choicesOf(task.choices) as Offered | null;
}

/** What an approval asks, as it stands: its action, environment, scope and verification. */
function requestOf(gate: Task): string {
  return askedOf(gate.description) ?? gate.title;
}

/**
 * The fields of an answer's record that say what was asked and what the
 * answer covers, in the meaning NoticeOS's record gave them: `response`, the
 * owner's words; `question`, what the proposal asked (an approval's request,
 * a decision's question, else the task's title); and `scope`, what the answer
 * authorizes (an approval's action, environment, scope and verification, the
 * chosen option's label, else the owner's words).
 */
function askedAndAnswered(task: Task, option: TaskChoiceKey | undefined, words: string | undefined): JsonObject {
  const offered = offeredOf(task);
  const request = task.type === 'gate' ? requestOf(task) : undefined;
  const scope = request ?? offered?.options.find((entry) => entry.key === option)?.label ?? words;
  return {
    ...(words === undefined ? {} : { response: words }),
    question: request ?? offered?.question ?? task.title,
    ...(scope === undefined ? {} : { scope }),
  };
}

/** Whether a person has chosen: the pick named, null when it cannot be read, undefined when none. */
function chosenOn(task: Task): string | null | undefined {
  if (task.choice === null) return undefined;
  const chosen = pickOf(task.choice);
  return chosen === null ? null : choiceName(chosen as unknown as JsonObject);
}

/** The comment a pick leaves: "Chose (b) Keep the old page." and the person's note. */
function choiceComment(choice: RecordedPick): string {
  return `Chose (${choice.option}) ${choice.label}.${choice.note === undefined ? '' : ` ${choice.note}`}`;
}

/** What a person's free answer or dismissal is written after, in the comment
 * or the close reason it leaves: their words must fit after it. */
export const ANSWERED = 'Answered: ';
export const RESPONDED = 'Response: ';
export const DISMISSED = 'Dismissed: ';

/** The record of the task's last answer or maintenance, or undefined. */
function maintenanceOf(task: Task): JsonObject | undefined {
  const value = task.metadata[MAINTENANCE];
  return isRecord(value) ? value : undefined;
}

/** The records before the current one, oldest first. */
function eventsOf(record: JsonObject | undefined): readonly Json[] {
  return Array.isArray(record?.events) ? record.events : [];
}

/** `record`'s events with `previous`, without its own events, added as the latest. */
function withPrevious(previous: JsonObject | undefined): Json[] {
  if (previous === undefined) return [];
  const { events: _events, ...kept } = previous;
  return [...eventsOf(previous), kept];
}

// ─── Building one write ───────────────────────────────────────────────────────

/** What a decision reads besides its task: the comments, and in full the open
 * tasks it waits on and that wait on it through blocks links, and its open children. */
export interface Surroundings {
  readonly comments: readonly TaskComment[];
  readonly blockers: readonly Task[];
  readonly dependents: readonly Task[];
  readonly children: readonly string[];
}

/** One write, put together part by part. */
class Draft {
  readonly set: { -readonly [K in keyof TaskFieldChanges]: TaskFieldChanges[K] } = {};
  readonly metadata: Record<string, Json> = {};
  removeLabels: string[] = [];
  addLinks: { taskId: string; type: 'related' | 'blocks' }[] = [];
  comment: string | undefined;
  close: TaskWrite['close'];
  reopen = false;
  readonly others = new Map<string, Draft>();

  constructor(readonly task: Task) {}

  /** The draft of a write to another task, made in the same batch. */
  other(task: Task): Draft {
    let draft = this.others.get(task.id);
    if (draft === undefined) {
      draft = new Draft(task);
      this.others.set(task.id, draft);
    }
    return draft;
  }

  /** Back to ready work for any agent: open, held by nobody, without the human label, or
   * with `keep`, in the status it has. */
  handBack(removeHuman: boolean, keep = false): void {
    if (!keep && this.task.status !== 'open') this.set.status = 'open';
    if (this.task.assignee !== null) this.set.assignee = null;
    if (removeHuman && this.task.labels.includes('human')) this.removeLabels = ['human'];
  }

  #changes(): Omit<TaskWrite, 'expectedVersion'> {
    return {
      ...(Object.keys(this.set).length > 0 ? { set: this.set } : {}),
      ...(Object.keys(this.metadata).length > 0 ? { metadata: this.metadata } : {}),
      ...(this.removeLabels.length > 0 ? { removeLabels: this.removeLabels } : {}),
      ...(this.addLinks.length > 0 ? { addLinks: this.addLinks } : {}),
      ...(this.comment === undefined ? {} : { comment: this.comment }),
      ...(this.close === undefined ? {} : { close: this.close }),
      ...(this.reopen ? { reopen: true as const } : {}),
    };
  }

  /** The write, or null when it changes nothing. */
  write(): TaskWrite | null {
    const changes = this.#changes();
    if (Object.keys(changes).length === 0) return null;
    const others = [...this.others.values()].flatMap((draft) => {
      const other = draft.#changes();
      return Object.keys(other).length === 0
        ? []
        : [{ taskId: draft.task.id, expectedVersion: draft.task.version, ...other }];
    });
    if (others.length > TASK_LIMITS.others)
      refuse(
        `${this.task.id} has ${others.length} open tasks waiting on it, more than the ${TASK_LIMITS.others} one decision tells. Remove some of those dependencies, then decide again.`,
      );
    return {
      expectedVersion: this.task.version,
      ...changes,
      ...(others.length > 0 ? { others } : {}),
    };
  }
}

/** The open tasks this one waits on through blocks links and the open
 * children under it refuse a decision's close; another holder or an open
 * blocker that is not an approval does not. */
function decisionClose(task: Task, around: Surroundings, field?: string): void {
  const gates = around.blockers.filter((blocker) => blocker.type === 'gate');
  if (gates.length > 0)
    refuseState(
      task.id,
      { kind: 'gate', gates: gates.map((gate) => gate.id), human: gates.every((gate) => gate.awaitType === 'human') },
      field,
    );
  if (around.children.length > 0) refuseState(task.id, { kind: 'children', children: around.children }, field);
}

/** The dependents a decision tells: open tasks waiting on it through blocks links. */
function waiting(around: Surroundings): readonly Task[] {
  return around.dependents.filter((dependent) => dependent.status !== 'closed');
}

/** Whether a dependent goes back to ready work with an approval's answer: a
 * task labelled human that is not itself a person's decision with options. */
function handedBackWith(dependent: Task): boolean {
  return (
    dependent.labels.includes('human') &&
    dependent.type !== 'decision' &&
    dependent.type !== 'gate' &&
    offeredOf(dependent) === null
  );
}

/** What an approval of `draft`'s gate does to the tasks waiting on it: each
 * one labelled human goes back to agents, told to keep within the approval. */
function handBackOnApproval(draft: Draft, around: Surroundings): void {
  for (const dependent of waiting(around).filter(handedBackWith)) {
    const other = draft.other(dependent);
    other.comment = `Owner approval recorded on ${draft.task.id}. Continue only within that recorded scope; other approvals are unchanged.`;
    other.handBack(true);
  }
}

/**
 * A pick: the pick, its comment, then a decision's close or any other task's
 * hand-back. A second pick is refused; the same person sending the same
 * option again finishes a pick recorded without its comment or its close,
 * such as one imported from Beads. Whether it made a new pick.
 */
function pickInto(
  draft: Draft,
  option: TaskChoiceKey,
  note: string | undefined,
  around: Surroundings,
  actor: string,
  at: string,
  decision: boolean,
  withComment: boolean,
  field?: string,
): boolean {
  const task = draft.task;
  const closed = task.status === 'closed';
  let pick: RecordedPick;
  const chosen = chosenOn(task);
  if (chosen !== undefined) {
    const earlier = pickOf(task.choice);
    if (earlier === null || earlier.option !== option || !sameActor(earlier.by, actor))
      return refuseState(task.id, { kind: 'chosen', chosen }, field);
    pick = earlier;
    const commented = around.comments.some(
      (entry) => sameActor(entry.author, actor) && entry.text === choiceComment(earlier),
    );
    if (closed || (!decision && commented && !task.labels.includes('human')))
      return refuseState(task.id, { kind: 'chosen', chosen }, field);
    if (!commented && withComment) draft.comment = choiceComment(earlier);
  } else {
    if (closed) refuseState(task.id, { kind: 'closed' }, field);
    const choices = offeredOf(task);
    if (choices === null) return refuseState(task.id, { kind: 'no-choices' }, field);
    const offered = choices.options.find((entry) => entry.key === option);
    if (offered === undefined)
      return refuseState(
        task.id,
        { kind: 'no-option', option, offered: choices.options.map((entry) => entry.key) },
        field,
      );
    pick = { option: offered.key, label: offered.label, by: actor, at, ...(note === undefined ? {} : { note }) };
    draft.set.choice = pick as unknown as JsonObject;
    if (withComment) draft.comment = choiceComment(pick);
  }
  if (decision) {
    decisionClose(task, around, field);
    draft.close = { reason: `Chose (${pick.option}) ${pick.label}`, resolution: 'done' };
  } else draft.handBack(true);
  return chosen === undefined;
}

// ─── A person's own decisions ─────────────────────────────────────────────────

/** Who decides and when, and the version of the proposal the decision answers. */
export interface Deciding {
  readonly actor: string;
  readonly at: string;
  readonly proposalVersion: string;
}

/**
 * The record of a person's own answer, made in the web app: recorded
 * directly, by them, against the proposal version it answered. It becomes the
 * task's last disposition, with the one before it kept in its events.
 */
function recordDirect(
  draft: Draft,
  deciding: Deciding,
  answer: { readonly option?: TaskChoiceKey; readonly words?: string },
): void {
  const previous = maintenanceOf(draft.task);
  const gate = draft.task.type === 'gate';
  draft.metadata[MAINTENANCE] = {
    action: 'answer',
    taskId: draft.task.id,
    proposalVersion: deciding.proposalVersion,
    ...(answer.option === undefined ? {} : { option: answer.option }),
    ...askedAndAnswered(draft.task, answer.option, answer.words),
    by: deciding.actor,
    at: deciding.at,
    verification: 'person',
    ...(gate ? { outcome: 'approved', approved: true } : {}),
    permission: gate ? 'approved-scope-only' : 'none',
    events: withPrevious(previous),
  };
}

/** A person's decision on a task that is open and waits on them: labelled human, not an approval. */
function asked(task: Task): void {
  if (task.status === 'closed') refuseState(task.id, { kind: 'closed' });
  if (task.type === 'gate')
    throw new Refused(
      'state',
      `refused: ${task.id} is an approval; a person approves it.`,
      `${task.id} is an approval: approve it instead.`,
    );
  if (!task.labels.includes('human'))
    throw new Refused(
      'state',
      `refused: ${task.id} does not wait on a person's answer.`,
      `${task.id} does not wait on a person's answer.`,
    );
}

/** A person's answer in their own words, recorded as they wrote it: a
 * decision closes on it, and any other task goes back to ready work with it
 * as a comment. A pick of an option is `choiceWrite`. */
export function responseWrite(
  task: Task,
  response: string,
  around: Surroundings,
  deciding: Deciding,
): TaskWrite | null {
  asked(task);
  const draft = new Draft(task);
  if (task.type === 'decision') {
    decisionClose(task, around);
    draft.comment = `${RESPONDED}${response}`;
    draft.close = { reason: 'Responded', resolution: 'done' };
  } else {
    draft.comment = `${ANSWERED}${response}`;
    draft.handBack(true);
  }
  recordDirect(draft, deciding, { words: response });
  return draft.write();
}

/** A person's pick of one of the task's options. */
export function choiceWrite(
  task: Task,
  option: TaskChoiceKey,
  note: string | undefined,
  around: Surroundings,
  deciding: Deciding,
): TaskWrite | null {
  if (task.type === 'gate')
    throw new Refused(
      'state',
      `refused: ${task.id} is an approval; a person approves it.`,
      `${task.id} is an approval: approve it instead.`,
    );
  const draft = new Draft(task);
  const made = pickInto(draft, option, note, around, deciding.actor, deciding.at, task.type === 'decision', true);
  if (made) recordDirect(draft, deciding, { option, ...(note === undefined ? {} : { words: note }) });
  return draft.write();
}

/** A person declining what a task asks: it closes, won't do unless they name
 * another way it ended, never done. */
export function dismissalWrite(
  task: Task,
  dismissal: {
    readonly reason?: string;
    readonly resolution?: Exclude<TaskResolution, 'done'>;
    readonly duplicateOf?: string;
  },
): TaskWrite | null {
  asked(task);
  const draft = new Draft(task);
  const { reason, resolution = 'wont-do', duplicateOf } = dismissal;
  draft.close = {
    reason: reason === undefined ? 'Dismissed' : `${DISMISSED}${reason}`,
    resolution,
    ...(duplicateOf === undefined ? {} : { duplicateOf }),
  };
  // The two are linked as related, so either task's page reaches the other.
  if (
    duplicateOf !== undefined &&
    ![...task.dependencies, ...task.dependents].some((link) => link.taskId === duplicateOf)
  )
    draft.addLinks.push({ taskId: duplicateOf, type: 'related' });
  return draft.write();
}

/**
 * A person approving an approval: the gate closes as done, the tasks waiting
 * on it are free of it, and those labelled human go back to agents as after
 * an approval an agent relays. The person's approval becomes the gate's
 * record, so an approval an agent relayed before it can no longer be disputed.
 */
export function approvalWrite(
  task: Task,
  reason: string | undefined,
  around: Surroundings,
  deciding: Deciding,
): TaskWrite | null {
  if (task.status === 'closed') refuseState(task.id, { kind: 'closed' });
  if (task.type !== 'gate' || task.awaitType !== 'human')
    throw new Refused('state', `refused: ${task.id} is not an approval.`, `${task.id} is not an approval.`);
  const draft = new Draft(task);
  draft.close = { reason: reason ?? 'Approved', resolution: 'done' };
  recordDirect(draft, deciding, reason === undefined ? {} : { words: reason });
  handBackOnApproval(draft, around);
  return draft.write();
}

/**
 * A person disputing an approval an agent recorded for them: its authority is
 * withdrawn, the gate opens again, and every task waiting on it is told to
 * stop the recorded action until a new approval. Once a person approved the
 * gate directly, nothing relayed is left to dispute.
 */
export function disputeWrite(task: Task, around: Surroundings, actor: string, at: string): TaskWrite | null {
  const previous = maintenanceOf(task);
  // The approval the gate stands on is its latest answer; the owner's report
  // that they did the action, which may follow it, does not replace it. A
  // person's own approval there is final. A record imported from NoticeOS
  // marks a direct approval in `approvedDirectly`.
  const standing = [previous, ...[...eventsOf(previous)].reverse()].find(
    (record) => isRecord(record) && record.action === 'answer',
  );
  const directOf = (record: Json | undefined) =>
    isRecord(record) ? (record.verification === 'person' ? record : record.approvedDirectly) : undefined;
  const direct = [previous, standing].map(directOf).find(isRecord);
  if (task.type === 'gate' && direct !== undefined && direct.approved !== false)
    refuse(
      `${task.id} was approved directly by ${stringOf(direct.by)}; a dispute withdraws only an approval an agent relayed.`,
    );
  if (
    task.type !== 'gate' ||
    previous === undefined ||
    previous.verification !== 'agent-recorded' ||
    (previous.approved !== true && !previous.disputed)
  )
    refuse('dispute requires a recorded agent-relayed approval on this gate.');
  const draft = new Draft(task);
  const sources = [
    ...new Set(
      [previous, ...eventsOf(previous).filter(isRecord)]
        .filter((event) => event.approved === true)
        .map((event) => event.source ?? null),
    ),
  ];
  if (!previous.disputed)
    draft.metadata[MAINTENANCE] = {
      ...previous,
      permission: 'none',
      disputed: { by: actor, at, agent: previous.by ?? null, sources },
      approved: false,
    };
  const text = `Owner disputed the approval relayed by ${stringOf(previous.by)}. The gate is reopened; the recorded action requires a new owner approval.\nDisputed source: ${stringOf(previous.source)}`;
  // The gate's comment names the disputed source: once it is there, this
  // dispute and its notice to the waiting tasks were already made together.
  const announced = around.comments.some((comment) => comment.text === text);
  if (!announced) draft.comment = text;
  if (task.status === 'closed') draft.reopen = true;
  else if (task.status !== 'open') draft.set.status = 'open';
  for (const dependent of announced ? [] : waiting(around)) {
    draft.other(dependent).comment =
      `Owner disputed approval ${task.id}, relayed by ${stringOf(previous.by)}. Stop the recorded action until a new owner approval is recorded.`;
  }
  return draft.write();
}

// ─── An owner answer an agent relays, and maintenance ─────────────────────────

/** The checks of a disposition's arguments together, before any read. */
export function checkMaintenance(op: TaskMaintenance): void {
  if (isOwnerAnswer(op.action)) {
    if (op.quote === undefined) refuseAnswer('quote', 'Required: the owner’s exact words, as they gave them.');
    if (op.source === undefined)
      refuseAnswer('source', 'Required: where the owner said it, such as the conversation or a comment.');
    if (op.option !== undefined && op.action !== 'answer')
      refuseAnswer('option', `Only action answer takes an option; ${op.action} takes none.`);
  } else {
    for (const [field, value] of [
      ['explanation', op.explanation],
      ['evidence', op.evidence],
    ] as const) {
      if (value === undefined) refuse(`${field} is required for action ${op.action}.`);
    }
    if ([op.quote, op.source, op.option].some((value) => value !== undefined))
      refuse(
        'quote, source and option record an owner answer: send them with action answer, declined or owner_performed, or leave them out.',
      );
  }
  if (op.action === 'release') {
    for (const [field, value, limit] of [
      ['holder', op.holder, 128],
      ['activityCheck', op.activityCheck, 800],
      ['progress', op.progress, 1000],
    ] as const) {
      if (value === undefined)
        refuse(
          `${field} is required, must be text without control characters and must fit within ${limit} characters.`,
        );
    }
    if (op.inactive !== true)
      refuse(
        'Assignment release requires inactive: true after checking the holder stopped, with holder, activity_check and preserved progress. Send that evidence; age alone is insufficient.',
      );
  } else if ([op.holder, op.inactive, op.activityCheck, op.progress].some((value) => value !== undefined)) {
    refuse('holder, inactive, activityCheck and progress require action release.');
  }
  if (op.action === 'duplicate') {
    if (op.duplicateOf === undefined || op.duplicateOf === op.taskId)
      refuse('duplicateOf must identify another open task retaining the complete request.');
  } else if (op.duplicateOf !== undefined) refuse('duplicateOf requires action duplicate.');
}

/** Everything a disposition reads before it writes. */
export interface MaintenanceInput extends Surroundings {
  readonly operation: TaskMaintenance;
  readonly task: Task;
  /** The version of the task's proposal as it stands. */
  readonly proposalVersion: string;
  /** The task `duplicateOf` names, as read; undefined when it names none or none was found. */
  readonly duplicate?: Task;
  readonly actor: string;
  /** The owner a relayed answer names as giving it, as a pick's chooser and an
   * owner-performed action's performer: the person the sender acts for, else the sender. */
  readonly owner: string;
  readonly at: string;
}

/** The comment an owner answer leaves: who relayed what, and its quote, source and proposal version. */
function answerNote(op: TaskMaintenance, task: Task, actor: string): string {
  const label = offeredOf(task)?.options.find((entry) => entry.key === op.option)?.label;
  const what =
    task.type === 'gate'
      ? op.action === 'declined'
        ? 'declined'
        : op.action === 'owner_performed'
          ? 'approved, and done by the owner'
          : 'approved'
      : op.option === undefined
        ? null
        : `chose (${op.option}) ${label ?? ''}`.trim();
  return (
    `Owner answer relayed by ${actor}${what === null ? '' : `: ${what}`}.` +
    `\nQuote: ${op.quote}\nSource: ${op.source}\nProposal version: ${op.proposalVersion}` +
    (op.explanation === undefined ? '' : `\n${op.explanation}`) +
    (op.evidence === undefined ? '' : `\nEvidence: ${op.evidence}`) +
    (op.action === 'declined'
      ? '\nApproval declined. The recorded action must not happen. Continue only the remaining authorized work.'
      : '')
  );
}

/**
 * The one write that records an owner answer an agent relays, or
 * evidence-backed maintenance, or null when it is recorded already. An
 * answer names the proposal version the owner saw, and is refused when the
 * proposal has changed since; its quote is recorded as given. Retiring a
 * request records no permission and leaves its action blocked.
 */
export function maintenanceWrite(input: MaintenanceInput): TaskWrite | null {
  const { operation: op, task, comments, actor, at, duplicate } = input;
  const ownerAnswer = isOwnerAnswer(op.action);
  if (op.proposalVersion !== input.proposalVersion)
    return ownerAnswer
      ? refuseAnswer('proposal_version', 'The proposal changed after the owner saw it; show it again.')
      : refuse('proposal_version: The task changed after you read it; read it again with get_task.');
  const previous = maintenanceOf(task);
  const identity = JSON.stringify(op);
  const same = previous?.identity === identity && previous?.by === actor;
  const gate = task.type === 'gate';
  const performed = op.action === 'owner_performed';
  const declined = op.action === 'declined';
  if (
    ownerAnswer &&
    [previous, ...eventsOf(previous)].some((event) => {
      if (!isRecord(event)) return false;
      const disputed = event.disputed;
      return (
        isRecord(disputed) &&
        (event.source === op.source || (Array.isArray(disputed.sources) && disputed.sources.includes(op.source!)))
      );
    })
  )
    return refuseAnswer(
      'source',
      'The owner disputed the answer recorded from this source; record their new answer with its own source.',
    );
  if (declined && !gate)
    return refuseAnswer('action', `declined is for an approval, and ${task.id} is not one; send action answer.`);
  if (performed && !gate)
    return refuseAnswer(
      'action',
      `owner_performed is for an approval, and ${task.id} is not one; send action answer, or completed with evidence.`,
    );
  const retiring = ['completed', 'obsolete', 'superseded', 'duplicate'].includes(op.action);
  const closed = task.status === 'closed';
  // An approval in force that still covers the gate's request as it stands now.
  const approved =
    gate && previous?.permission === 'approved-scope-only' && !previous.disputed && previous.scope === requestOf(task);
  // On a closed approval only the owner's report that they did the action may
  // follow: any other answer recorded there would replace the owner's.
  if (closed && !same && !(approved && performed)) {
    if (!ownerAnswer)
      return refuse('status is closed. Use update_task with status open before recording a different disposition.');
    if (!gate)
      return refuseAnswer(
        'task',
        `${task.id} is closed; reopen it with update_task status open, then record the answer.`,
      );
    return refuseAnswer(
      'task',
      performed
        ? `${task.id}'s request changed after it was approved, or its approval was withdrawn; the owner's report does not complete it.`
        : `${task.id} is already answered and closed; only owner_performed may follow its approval.`,
    );
  }
  if (gate && ['routine', 'release', 'completed'].includes(op.action)) {
    return refuse(
      'action cannot complete an approval or make it routine from implementation evidence. Record the owner’s answer, owner_performed with their completed result, or obsolete to retire an unnecessary request.',
    );
  }
  if (op.action === 'completed' && task.type === 'decision') {
    return refuse(
      'A completed implementation does not prove a business decision was approved. Record its owner answer or why the decision is obsolete.',
    );
  }
  const holder = task.assignee ?? '';
  if (!ownerAnswer && op.action !== 'release' && holder && !sameActor(holder, actor)) {
    return refuse(`Check ${holder}’s activity and release its abandoned assignment before maintaining this task.`);
  }
  if (op.action === 'release' && holder !== op.holder && !(same && holder === '')) {
    return refuse('The assignment changed. Check its current holder before releasing it.');
  }

  const draft = new Draft(task);
  /** The owner answer's own effect on the task, applied after the dependents'. */
  let answer: (() => void) | null = null;
  if (ownerAnswer) {
    if (!isDecision(task) && !same && !(gate && approved))
      return refuseAnswer(
        'task',
        `${task.id} does not wait on a person’s answer; close completed work with close_task and its evidence.`,
      );
    const settled = same && task.status === 'open' && !task.labels.includes('human');
    if (gate) {
      if (op.option !== undefined)
        return refuseAnswer(
          'option',
          `${task.id} is an approval, which takes no option; send action answer to approve it, or declined.`,
        );
      decisionClose(task, input, 'task');
      if (!closed) {
        const reason = declined
          ? 'Owner declined the recorded scope; the action must not happen'
          : performed
            ? 'Approved and done by the owner'
            : 'Owner approved the recorded scope';
        answer = () => {
          draft.close = { reason, resolution: declined ? 'wont-do' : 'done' };
        };
      }
    } else {
      const option = op.option;
      if (option !== undefined) {
        const offered = offeredOf(task)?.options.map((entry) => entry.key) ?? [];
        if (offered.length === 0) return refuseAnswer('option', `${task.id} offers no options; leave option out.`);
        if (!offered.includes(option))
          return refuseAnswer(
            'option',
            `${task.id} offers ${listed(offered.map((key) => `(${key})`))}, not (${option}).`,
          );
      }
      if (!closed && !settled) {
        if (task.type === 'decision') decisionClose(task, input, 'task');
        // A pick hands the task back to agents, who close it with the implementation.
        answer =
          option === undefined
            ? () => draft.handBack(true)
            : () => {
                pickInto(draft, option, undefined, input, input.owner, at, false, false, 'task');
              };
      }
    }
  }

  const events = eventsOf(previous);
  if (!same && events.length >= 64)
    return refuse(
      'events already contains 64 recorded dispositions. Keep the history and request owner review before adding another.',
    );
  if (!same) {
    // The owner's words are kept as `response`, the name NoticeOS's record gave them.
    const { quote, ...fields } = op;
    draft.metadata[MAINTENANCE] = {
      identity,
      by: actor,
      at,
      ...(fields as unknown as JsonObject),
      ...(ownerAnswer ? askedAndAnswered(task, op.option, quote) : {}),
      events: withPrevious(previous),
      ...(ownerAnswer ? { verification: 'agent-recorded', answerMode: 'relayed' } : {}),
      ...(ownerAnswer && gate
        ? { outcome: declined ? 'declined' : performed ? 'owner-performed' : 'approved', approved: !declined }
        : {}),
      ...(performed ? { performedBy: input.owner, recordedBy: actor } : {}),
      permission: op.action === 'answer' && gate ? 'approved-scope-only' : 'none',
    };
  }
  const note = ownerAnswer
    ? answerNote(op, task, actor)
    : `Task maintenance: ${op.action}. ${op.explanation}\nEvidence: ${op.evidence}` +
      (op.action === 'release' ? `\nActivity checked: ${op.activityCheck}\nProgress preserved: ${op.progress}` : '') +
      (gate && retiring ? '\nRequest retired. No permission to perform the action was granted.' : '');
  if (!comments.some((comment) => comment.author === actor && comment.text === note)) draft.comment = note;
  if (op.action === 'duplicate') {
    if (!duplicate || duplicate.id !== op.duplicateOf || duplicate.status === 'closed') {
      return refuse('The duplicate must name an open task retaining the complete scope.');
    }
    if (
      gate &&
      (duplicate.type !== 'gate' || duplicate.awaitType !== 'human' || duplicate.description !== task.description)
    ) {
      return refuse('Duplicate approvals must retain exactly the same requested scope.');
    }
    // A link the two have, of any type, stays as it is.
    if (![...task.dependencies, ...task.dependents].some((link) => link.taskId === op.duplicateOf))
      draft.addLinks.push({ taskId: op.duplicateOf!, type: 'related' });
  }
  if (gate && (retiring || declined) && !closed) {
    for (const dependent of waiting(input)) {
      const other = draft.other(dependent);
      if (op.action === 'duplicate' && !dependent.dependencies.some((link) => link.taskId === op.duplicateOf))
        other.addLinks.push({ taskId: op.duplicateOf!, type: 'blocks' });
      other.comment =
        `Approval request ${task.id} ${declined ? 'declined' : 'retired'}${op.explanation === undefined ? '' : `: ${op.explanation}`}. ` +
        'The action must not happen without a new action-specific owner approval. Continue only the remaining authorized work. No permission granted.' +
        `\nExcluded action: ${task.description}`;
      if (op.action !== 'duplicate' && handedBackWith(dependent)) other.handBack(true);
    }
  }
  if (!closed && retiring) {
    const resolution: TaskResolution =
      op.action === 'duplicate'
        ? 'duplicate'
        : op.action === 'obsolete' || op.action === 'superseded'
          ? 'no-longer-needed'
          : 'already-handled';
    // Every open child and approval still needs its own disposition.
    decisionClose(task, input);
    draft.close = {
      reason: `${op.explanation}\nEvidence: ${op.evidence}`,
      resolution,
      ...(op.duplicateOf === undefined ? {} : { duplicateOf: op.duplicateOf }),
    };
  } else if (ownerAnswer) {
    if (gate && !closed && !declined) handBackOnApproval(draft, input);
    answer?.();
  } else if (!closed && (op.action === 'routine' || op.action === 'release') && !(same && holder === '')) {
    draft.handBack(op.action === 'routine', op.action === 'release' && task.status !== 'in_progress');
  }
  return draft.write();
}

// ─── Running them ─────────────────────────────────────────────────────────────

/** What a decision on `task` reads besides it, in one read of the tasks it touches. */
async function surroundings(context: WriteContext, project: Project, task: Task): Promise<Surroundings> {
  const { engine } = context;
  const blockerIds = task.dependencies
    .filter((link) => link.type === 'blocks' && link.status !== 'closed')
    .map((link) => link.taskId);
  const dependentIds = task.dependents
    .filter((link) => link.type === 'blocks' && link.status !== 'closed')
    .map((link) => link.taskId);
  const ids = [...new Set([...blockerIds, ...dependentIds])];
  // A read takes at most a page of ids; an approval can hold more tasks than that.
  const pages = Array.from({ length: Math.ceil(ids.length / TASK_LIMITS.page) }, (_, index) =>
    ids.slice(index * TASK_LIMITS.page, (index + 1) * TASK_LIMITS.page),
  );
  const [comments, read, children] = await Promise.all([
    engine.listComments(project.id, task.id),
    Promise.all(pages.map((page) => engine.getTasks(project.id, page))),
    engine.listBoard(project.id, { statuses: OPEN_STATUSES, parentId: task.id }),
  ]);
  const tasks = read.flat();
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
  const found = (ids: readonly string[]) => ids.flatMap((id) => byId.get(id) ?? []);
  return {
    comments,
    blockers: found(blockerIds),
    dependents: found(dependentIds),
    children: children.map((child) => child.id),
  };
}

/** The refusal of a person's answer to a proposal that changed after their page showed it. */
function changedSinceShown(id: string): Refused {
  return new Refused(
    'state',
    `refused: proposalVersion: The proposal changed after the owner saw it; show it again. ${NOT_RECORDED}`,
    `${id} changed after this page showed it. Read it again, then answer; your answer was not recorded.`,
    'proposalVersion',
  );
}

/**
 * A person's decision, run as one write: refused unless the sender is a person
 * signed in to the web app who may change the project, and, when `shown`
 * names the proposal version their page showed, unless that is still the
 * task's proposal.
 */
async function decide(
  context: WriteContext,
  projectId: string,
  taskId: string,
  plan: (task: Task, around: Surroundings, deciding: Deciding) => TaskWrite | null,
  retryRequest: RetryRequest | undefined,
  shown?: string,
): Promise<Written> {
  const { principal } = context;
  if (!principal.scopes.includes(SCOPES.decide)) throw notAPerson();
  const project = await projectOf(context, projectId, 'write');
  const task = await taskOf(context, project, taskId);
  const retry = await retryOf(principal, retryRequest);
  const replay = await recorded(context, project, retry);
  if (replay !== null) return { project, result: replay };
  const actor = actorOf(principal, undefined);
  const result = await changing(context, project, task, actor, retry, async (current) => {
    const proposalVersion = await proposalVersionOf(current);
    if (shown !== undefined && shown !== proposalVersion) throw changedSinceShown(current.id);
    const around = await surroundings(context, project, current);
    return plan(current, around, { actor: actor.name, at: context.now(), proposalVersion });
  });
  return { project, result };
}

/** The refusal a decision from anyone but a person signed in to the web app meets. */
export function notAPerson(): Refused {
  return new Refused(
    'forbidden',
    'refused: only a person signed in to the web app answers a decision, approves an approval or disputes one. Record an existing owner answer with reconcile_task.',
    'Only a person signed in to Ntasks answers a decision, approves an approval or disputes one. Answer it in the Ntasks web app.',
  );
}

export function respond(
  context: WriteContext,
  projectId: string,
  taskId: string,
  response: string,
  retry?: RetryRequest,
  shown?: string,
): Promise<Written> {
  return decide(
    context,
    projectId,
    taskId,
    (task, around, deciding) => responseWrite(task, response, around, deciding),
    retry,
    shown,
  );
}

export function choose(
  context: WriteContext,
  projectId: string,
  taskId: string,
  option: TaskChoiceKey,
  note: string | undefined,
  retry?: RetryRequest,
  shown?: string,
): Promise<Written> {
  return decide(
    context,
    projectId,
    taskId,
    (task, around, deciding) => choiceWrite(task, option, note, around, deciding),
    retry,
    shown,
  );
}

export async function dismiss(
  context: WriteContext,
  projectId: string,
  taskId: string,
  dismissal: Parameters<typeof dismissalWrite>[1],
  retry?: RetryRequest,
  shown?: string,
): Promise<Written> {
  if (dismissal.duplicateOf !== undefined) {
    if (!context.principal.scopes.includes(SCOPES.decide)) throw notAPerson();
    await tasksIn(context, await projectOf(context, projectId, 'write'), [dismissal.duplicateOf]);
  }
  return decide(context, projectId, taskId, (task) => dismissalWrite(task, dismissal), retry, shown);
}

export function approve(
  context: WriteContext,
  projectId: string,
  taskId: string,
  reason: string | undefined,
  retry?: RetryRequest,
  shown?: string,
): Promise<Written> {
  return decide(
    context,
    projectId,
    taskId,
    (task, around, deciding) => approvalWrite(task, reason, around, deciding),
    retry,
    shown,
  );
}

export function dispute(
  context: WriteContext,
  projectId: string,
  taskId: string,
  retry?: RetryRequest,
): Promise<Written> {
  return decide(
    context,
    projectId,
    taskId,
    (task, around, deciding) => disputeWrite(task, around, deciding.actor, deciding.at),
    retry,
  );
}

/**
 * Records an owner answer an agent relays, or evidence-backed maintenance,
 * for the sender. The answer is recorded as relayed by the sender, against
 * the proposal version the owner saw; the owner can dispute a relayed
 * approval.
 */
export async function reconcileTask(
  context: WriteContext,
  projectId: string,
  operation: TaskMaintenance,
  retryRequest: RetryRequest,
): Promise<Written> {
  checkMaintenance(operation);
  const project = await projectOf(context, projectId, 'write');
  const task = await taskOf(context, project, operation.taskId);
  const retry = await retryOf(context.principal, retryRequest);
  const replay = await recorded(context, project, retry);
  if (replay !== null) return { project, result: replay };
  const actor = actorOf(context.principal, operation.model);
  const result = await changing(context, project, task, actor, retry, async (current) => {
    const [around, duplicate, proposalVersion] = await Promise.all([
      surroundings(context, project, current),
      operation.duplicateOf === undefined ? null : context.engine.getTask(project.id, operation.duplicateOf),
      proposalVersionOf(current),
    ]);
    return maintenanceWrite({
      ...around,
      operation,
      task: current,
      proposalVersion,
      ...(duplicate === null ? {} : { duplicate }),
      actor: actor.name,
      owner: context.principal.person ?? actor.name,
      at: context.now(),
    });
  });
  return { project, result };
}

/** The task as a sender who may not see every project reads it after a write. */
export async function seen(context: WriteContext, task: Task): Promise<Task> {
  return (await linksSeenBy(context)).task(task);
}
