/**
 * What counts as the owner's authority: a person's own answers, picks,
 * dismissals, approvals and disputes, and the owner answers an agent records
 * with reconcile_task. The rules and their sentences are NoticeOS's
 * (maintenanceSteps, disputeSteps, choiceSteps, answerSteps, replyOption,
 * approvesGate and commentProposalMatches in scripts/hosted-task-command.mts
 * there). NoticeOS ran each decision as several task-client commands; here
 * each is one TaskWrite, so the record, its comment, the close or hand-back
 * and the changes to the tasks waiting on it land together or not at all.
 */
import {
  TASK_LIMITS,
  type Json,
  type JsonObject,
  type Project,
  type Task,
  type TaskComment,
  type TaskEvent,
  type TaskFieldChanges,
  type TaskResolution,
  type TaskWrite,
} from '@ntasks/domain';
import { listed } from './args.ts';
import { SCOPES } from './auth.ts';
import { linksSeenBy, projectOf, taskOf, tasksIn } from './lookup.ts';
import { askedOf, choiceName, choicesOf, TASK_CHOICE_KEYS, type TaskChoiceKey } from './noticeos-fields.ts';
import { Refused } from './refused.ts';
import { allEvents } from './service.ts';
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
import { proposalOf } from './views.ts';

/** The metadata key the record of a task's last maintenance is kept under. */
export const MAINTENANCE = 'noticeos_maintenance';

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

/**
 * A disposition an agent records: an existing owner answer with its source,
 * or maintenance with evidence. Its keys are in the order NoticeOS's tool
 * built them, since a record keeps `JSON.stringify` of it as its identity.
 */
export interface TaskMaintenance {
  readonly kind: 'maintain';
  readonly taskId: string;
  readonly action: MaintenanceAction;
  /** The proposal get_task returned, which the owner saw. */
  readonly proposal: string;
  readonly explanation: string;
  readonly evidence: string;
  readonly model?: string;
  /** The owner's exact words, who they are, where they said it and what they authorized. */
  readonly response?: string;
  readonly owner?: string;
  readonly source?: string;
  readonly scope?: string;
  /** A chat answer the agent witnessed or relays: recorded as the agent's, not independently authenticated. */
  readonly answerMode?: 'direct' | 'relayed';
  readonly question?: string;
  /** The numbered proposal a batch reply selects, kept in its source. */
  readonly approvalItem?: number;
  /** The stored option the owner's exact decision-card reply names. */
  readonly option?: TaskChoiceKey;
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

/** Why the task's own state refuses a decision, as NoticeOS named it to an
 * agent (stateRefusal) and to a person (decisionRefusal). */
type StateReason =
  | { readonly kind: 'closed' }
  | { readonly kind: 'gate'; readonly gates: readonly string[]; readonly human: boolean }
  | { readonly kind: 'children'; readonly children: readonly string[] }
  | { readonly kind: 'chosen'; readonly chosen: string | null }
  | { readonly kind: 'no-choices' }
  | { readonly kind: 'no-option'; readonly option: string; readonly offered: readonly string[] };

function refuseState(id: string, reason: StateReason): never {
  switch (reason.kind) {
    case 'closed':
      throw new Refused(
        'state',
        `refused: ${id} is already closed; get_task shows its close reason.`,
        `${id} is already closed.`,
      );
    case 'gate':
      throw new Refused(
        'state',
        reason.human
          ? `refused: ${id} waits on approval ${listed(reason.gates)}, which is still open. Use reconcile_task on the gate with the owner’s scoped answer, or action declined with their refusal; then close ${id} with implementation evidence. A declined action must not happen.`
          : `refused: ${id} waits on gate ${listed(reason.gates)}, which is still open. Close ${id} after it resolves.`,
        `${id} waits on approval ${listed(reason.gates)}. Approve it first.`,
      );
    case 'children':
      throw new Refused(
        'state',
        `refused: ${id} has open children: ${listed(reason.children)}. Close them first, or give them another parent with update_task.`,
        `${id} has open tasks under it: ${listed(reason.children)}.`,
      );
    case 'chosen':
      throw new Refused(
        'state',
        `refused: ${id} already carries a person's choice${reason.chosen === null ? '' : `, ${reason.chosen}`}, and its choices ` +
          'stay as they were when it was made. get_task shows the choice; file work that remains with create_task.',
        reason.chosen === null ? `${id} already has a choice.` : `${id} already has a choice: ${reason.chosen}.`,
      );
    case 'no-choices':
      throw new Refused('state', `refused: ${id} offers no choices.`, `${id} offers no options to choose from.`);
    case 'no-option':
      throw new Refused(
        'state',
        `refused: ${id} offers no option (${reason.option}).`,
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

/** Whether `owner` names the recording sender itself, with or without the
 * kind its actor starts with. An agent that registered under the name of the
 * person it acts for (`person`) may still record that person's answer. */
function selfAnswer(owner: string, actor: string, person: string | undefined): boolean {
  if (sameActor(owner, actor)) return true;
  return sameActor(owner, actor.replace(/^(?:agent|service):/u, '')) && owner !== person;
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

/** A task's choices as a pick reads them: the options and the one recommended. */
interface Offered {
  readonly options: readonly { readonly key: TaskChoiceKey; readonly label: string; readonly recommended?: boolean }[];
}
function offeredOf(task: Task): Offered | null {
  return choicesOf(task.choices) as Offered | null;
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

/** The record of the task's last maintenance, or undefined. */
function maintenanceOf(task: Task): JsonObject | undefined {
  const value = task.metadata[MAINTENANCE];
  return isRecord(value) ? value : undefined;
}

// ─── Comments as the source of an answer ──────────────────────────────────────

/** A task's proposal at each of its versions, oldest first, rebuilt from its history. */
function proposalsOf(events: readonly TaskEvent[]): { readonly at: number; readonly proposal: string }[] {
  const state: Record<string, Json> = {};
  const versions: { at: number; proposal: string }[] = [];
  for (const event of events) {
    if (event.kind === 'commented') continue;
    Object.assign(state, event.changes);
    versions.push({
      at: Date.parse(event.at),
      proposal: proposalOf({
        id: stringOf(state.id) || event.taskId,
        title: stringOf(state.title),
        description: stringOf(state.description),
        acceptance: stringOf(state.acceptance),
        type: (state.type ?? 'task') as Task['type'],
        choices: isRecord(state.choices) ? state.choices : null,
      }),
    });
  }
  return versions;
}

/**
 * Whether the comment an answer names as its source was written against the
 * proposal the answer names. A later edit of the task cannot turn an old "A"
 * into approval of replacement options, and a comment whose proposal the
 * history cannot show is not taken.
 */
export function commentProposalMatches(
  operation: TaskMaintenance,
  task: Task,
  comments: readonly TaskComment[],
  history: readonly TaskEvent[],
): boolean {
  if (!operation.source?.startsWith('comment:')) return true;
  const comment = comments.find((entry) => entry.id === operation.source!.slice(8));
  const at = Date.parse(stringOf(comment?.createdAt));
  const updated = Date.parse(task.updatedAt);
  if (!Number.isFinite(at)) return false;
  if (Number.isFinite(updated) && at > updated) return true;
  const versions = proposalsOf(history)
    .filter((version) => Number.isFinite(version.at) && version.at <= at)
    .sort((a, b) => b.at - a.at);
  const latest = versions[0];
  if (!latest) return false;
  // Two versions at one instant with different proposals cannot show which the owner saw.
  return versions
    .filter((version) => version.at === latest.at)
    .every((version) => version.proposal === operation.proposal);
}

/** Only an owner-authored comment answer, older than the task's last change, needs the task's history. */
export function commentNeedsProposalHistory(
  operation: TaskMaintenance,
  task: Task,
  comments: readonly TaskComment[],
): boolean {
  if (operation.answerMode !== undefined || !operation.source?.startsWith('comment:')) return false;
  const source = comments.find((comment) => comment.id === operation.source!.slice(8));
  return (
    source?.author === operation.owner &&
    source?.text === operation.response &&
    !commentProposalMatches(operation, task, comments, [])
  );
}

// ─── Reading an owner's reply ─────────────────────────────────────────────────

function preservesWords(source: string, words: string): boolean {
  return (
    [
      ['"', '"'],
      ['“', '”'],
      ["'", "'"],
    ].some(([left, right]) => source.includes(`${left}${words}${right}`)) ||
    source
      .split('\n')
      .some((line) => ['Question: ', 'Reply: ', 'Answer: ', 'Result: '].some((prefix) => line === prefix + words))
  );
}

/** A relay keeps the owner's words; this admits only clear assent within the question's scope. */
function approvesGate(operation: TaskMaintenance, source?: TaskComment): boolean {
  const reply = operation.response!.trim().replace(/[.!]$/u, '');
  if (/\?|\b(?:if|unless|until|provided|maybe|perhaps|not|don't|do not)\b/iu.test(reply.replace(/\([^)]*\)/gu, '')))
    return false;
  if (/^(?:yes|approve|approved|yes[, ]+(?:your |the )?recommendation)$/iu.test(reply)) return true;
  const batch = /^all except (.+)$/iu.exec(reply);
  if (batch && operation.approvalItem !== undefined && source) {
    if (!/^all except \d+(?:\s*(?:,|and)\s*\d+)*$/iu.test(reply.replace(/\s*\([^)]*\)/gu, ''))) return false;
    const total = /\ball\s+(\d+)\b/iu.exec(operation.question ?? '')?.[1];
    const named = [...batch[1]!.matchAll(/(?:^|[, ]+)\b(\d+)\b(?:\s*\([^)]*\))?/gu)].map((match) => Number(match[1]));
    return (
      total !== undefined &&
      operation.approvalItem <= Number(total) &&
      named.length > 0 &&
      !named.includes(operation.approvalItem) &&
      new RegExp(`\\bitem ${operation.approvalItem}\\b`, 'iu').test(source.text)
    );
  }
  const named = /^yes[, ]+(.+)$/iu.exec(reply)?.[1];
  if (!named || operation.answerMode !== 'relayed') return false;
  const request = `${operation.question} ${operation.scope}`.toLowerCase();
  return named.split(/\s+(?:and|then)\s+|,\s*/u).every((part) => {
    const words = part.toLowerCase().trim();
    return words.length > 0 && request.includes(words);
  });
}

/**
 * The option a short reply picks, read against the choices the owner saw; null
 * for a reply that gives a direction without picking. A directly witnessed
 * card selection (`selected`) may map a clearer label to its option. A reply
 * that is uncertain, or picks against the selection, is refused, and the
 * question stays open.
 */
export function replyOption(
  response: string,
  choices: Offered | null,
  taskId?: string,
  selected?: TaskChoiceKey,
): TaskChoiceKey | null {
  if (
    /\?|\b(?:not sure|unsure|maybe|perhaps|need more|need to think|can you explain|what do you mean)\b|^(?:whatever|anything|either|you choose|you decide|no preference)[.!]?$/iu.test(
      response.trim(),
    )
  ) {
    return refuse('This reply leaves the decision unresolved. Ask one clarification covering only the uncertainty.');
  }
  if (selected !== undefined && !choices?.options.some((option) => option.key === selected)) {
    return refuse('The selected option is not in this task’s proposal.');
  }
  if (choices === null) return null;
  const matched = (option: TaskChoiceKey): TaskChoiceKey => {
    if (selected !== undefined && option !== selected)
      return refuse('The selected option conflicts with the owner’s answer.');
    return option;
  };
  const reply = response.trim().replace(/[.!]$/u, '').toLowerCase();
  // Question UIs may append recommendation markers and descriptions to a label.
  const cardLabel = reply
    .split(/\s+[—–]\s+/u)[0]!
    .replace(/\s*\(recommended\)/gu, '')
    .trim();
  const batch = /^([a-f]) for (.+)$/u.exec(reply);
  const named: readonly string[] = batch?.[2]?.match(/[a-z0-9]+-{1,2}[a-z0-9]+(?:\.[0-9]+)*/giu) ?? [];
  const letter =
    /^\(?([a-f])\)?$/u.exec(cardLabel)?.[1] ??
    (selected !== undefined ? /^\(?([a-f])[).:]\s+/u.exec(cardLabel)?.[1] : undefined) ??
    (taskId && named.includes(taskId.toLowerCase()) ? batch?.[1] : undefined);
  if (letter) {
    if (choices.options.some((option) => option.key === letter)) return matched(letter as TaskChoiceKey);
    return refuse('That letter is not an offered option. Ask which offered option the owner means.');
  }
  if (
    /^(?:yes[, ]+)?(?:your |the )?recommendation(?: please)?$/u.test(reply) ||
    /^(?:yes[, ]+)?(?:go with |use |do )(?:your |the )?recommendation$/u.test(reply)
  ) {
    return matched(choices.options.find((option) => option.recommended)!.key);
  }
  const label = choices.options.find((option) => option.label.toLowerCase() === cardLabel);
  if (label) return matched(label.key);
  if (/^(?:yes|no|ok|okay|sure|approved|go ahead|that one|all|both)$/u.test(reply)) {
    return refuse('This reply does not identify an option. Ask one clarification naming only the unresolved choice.');
  }
  if (batch)
    return refuse('This reply does not name this task. Ask one clarification covering only the unresolved choice.');
  if (selected !== undefined && /^(?:no[, ]|not\b|don't\b|do not\b)/u.test(reply)) {
    return refuse('This reply does not identify an option. Keep the unresolved choice open.');
  }
  if (selected !== undefined) return selected;
  if (
    !/^(?:please )?(?:use|build|keep|switch|remove|add|set|return|make|change|stop|start|leave|ship|do not|don't|skip|choose|go with|move|enable|disable|create|proceed|implement|replace|rename|align|put|show|hide|include|exclude|reduce|increase|retain|drop|combine|split|follow|apply|send|publish|defer|wait|accept|reject|cancel|continue|schedule|run|review|record|close|reopen)\b|^(?:i (?:want|approve|choose|prefer)|let's|let us|we should)\b/u.test(
      reply,
    )
  ) {
    return refuse(
      'This reply does not give a clear direction. Ask one clarification covering only the unresolved choice.',
    );
  }
  return null;
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
function decisionClose(task: Task, around: Surroundings): void {
  const gates = around.blockers.filter((blocker) => blocker.type === 'gate');
  if (gates.length > 0)
    refuseState(task.id, {
      kind: 'gate',
      gates: gates.map((gate) => gate.id),
      human: gates.every((gate) => gate.awaitType === 'human'),
    });
  if (around.children.length > 0) refuseState(task.id, { kind: 'children', children: around.children });
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
 * A person's pick (choiceSteps): the pick, its comment, then a decision's
 * close or any other task's hand-back. A second pick is refused; the same
 * person sending the same option again finishes a pick recorded without its
 * comment or its close, such as one imported from Beads.
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
): void {
  const task = draft.task;
  const closed = task.status === 'closed';
  let pick: RecordedPick;
  const chosen = chosenOn(task);
  if (chosen !== undefined) {
    const earlier = pickOf(task.choice);
    if (earlier === null || earlier.option !== option || !sameActor(earlier.by, actor))
      return refuseState(task.id, { kind: 'chosen', chosen });
    pick = earlier;
    const commented = around.comments.some(
      (entry) => sameActor(entry.author, actor) && entry.text === choiceComment(earlier),
    );
    if (closed || (!decision && commented && !task.labels.includes('human')))
      return refuseState(task.id, { kind: 'chosen', chosen });
    if (!commented && withComment) draft.comment = choiceComment(earlier);
  } else {
    if (closed) refuseState(task.id, { kind: 'closed' });
    const choices = offeredOf(task);
    if (choices === null) return refuseState(task.id, { kind: 'no-choices' });
    const offered = choices.options.find((entry) => entry.key === option);
    if (offered === undefined)
      return refuseState(task.id, {
        kind: 'no-option',
        option,
        offered: choices.options.map((entry) => entry.key),
      });
    pick = { option: offered.key, label: offered.label, by: actor, at, ...(note === undefined ? {} : { note }) };
    draft.set.choice = pick as unknown as JsonObject;
    if (withComment) draft.comment = choiceComment(pick);
  }
  if (decision) {
    decisionClose(task, around);
    draft.close = { reason: `Chose (${pick.option}) ${pick.label}`, resolution: 'done' };
  } else draft.handBack(true);
}

// ─── A person's own decisions ─────────────────────────────────────────────────

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

/** A person's free answer: a reply that picks one of the task's options is
 * that pick; any other closes a decision on it, or goes back to ready work
 * with it as a comment. */
export function responseWrite(
  task: Task,
  response: string,
  around: Surroundings,
  actor: string,
  at: string,
): TaskWrite | null {
  asked(task);
  const draft = new Draft(task);
  const option = replyOption(response, offeredOf(task), task.id);
  if (option !== null) {
    pickInto(draft, option, undefined, around, actor, at, task.type === 'decision', true);
  } else if (task.type === 'decision') {
    decisionClose(task, around);
    draft.comment = `${RESPONDED}${response}`;
    draft.close = { reason: 'Responded', resolution: 'done' };
  } else {
    draft.comment = `${ANSWERED}${response}`;
    draft.handBack(true);
  }
  return draft.write();
}

/** A person's pick of one of the task's options. */
export function choiceWrite(
  task: Task,
  option: TaskChoiceKey,
  note: string | undefined,
  around: Surroundings,
  actor: string,
  at: string,
): TaskWrite | null {
  if (task.type === 'gate')
    throw new Refused(
      'state',
      `refused: ${task.id} is an approval; a person approves it.`,
      `${task.id} is an approval: approve it instead.`,
    );
  const draft = new Draft(task);
  pickInto(draft, option, note, around, actor, at, task.type === 'decision', true);
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
 * an approval an agent relays. An approval an agent relayed on it before is
 * marked as answered by this one, so it can no longer be disputed.
 */
export function approvalWrite(
  task: Task,
  reason: string | undefined,
  around: Surroundings,
  actor: string,
  at: string,
): TaskWrite | null {
  if (task.status === 'closed') refuseState(task.id, { kind: 'closed' });
  if (task.type !== 'gate' || task.awaitType !== 'human')
    throw new Refused('state', `refused: ${task.id} is not an approval.`, `${task.id} is not an approval.`);
  const draft = new Draft(task);
  draft.close = { reason: reason ?? 'Approved', resolution: 'done' };
  const previous = maintenanceOf(task);
  if (previous?.verification === 'agent-recorded')
    draft.metadata[MAINTENANCE] = { ...previous, approvedDirectly: { by: actor, at } };
  handBackOnApproval(draft, around);
  return draft.write();
}

/**
 * A person disputing an approval an agent recorded for them: its authority is
 * withdrawn, the gate opens again, and every task waiting on it is told to
 * stop the recorded action until a new approval. Once the person approved the
 * gate directly, nothing relayed is left to dispute.
 */
export function disputeWrite(task: Task, around: Surroundings, actor: string, at: string): TaskWrite | null {
  const previous = maintenanceOf(task);
  if (
    task.type !== 'gate' ||
    previous === undefined ||
    previous.verification !== 'agent-recorded' ||
    (previous.approved !== true && !previous.disputed)
  )
    refuse('dispute requires a recorded agent-relayed approval on this gate.');
  const direct = previous.approvedDirectly;
  if (isRecord(direct))
    refuse(
      `${task.id} was approved directly by ${stringOf(direct.by)}; a dispute withdraws only an approval an agent relayed.`,
    );
  const draft = new Draft(task);
  const events = Array.isArray(previous.events) ? previous.events.filter(isRecord) : [];
  const sources = [
    ...new Set([previous, ...events].filter((event) => event.approved === true).map((event) => event.source ?? null)),
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

// ─── An owner answer an agent records ─────────────────────────────────────────

/** The checks of a disposition's fields together, before any read: what a
 * malformed call names (the command check in NoticeOS's planner). */
export function checkMaintenance(op: TaskMaintenance): void {
  const ownerAnswer = op.action === 'answer' || op.action === 'declined' || op.action === 'owner_performed';
  if (ownerAnswer) {
    for (const [field, value] of [
      ['response', op.response],
      ['owner', op.owner],
      ['source', op.source],
      ['scope', op.scope],
    ] as const) {
      if (value === undefined)
        refuse(
          `${field} is required, must be text without control characters and must fit within ${field === 'owner' ? 128 : field === 'source' ? 512 : 1000} characters. Send that field again with the same owner words.`,
        );
    }
    // A source names a comment or an explicitly linked conversation.
    if (!/^(?:comment:[\w-]+$|https:\/\/|codex:\/\/threads\/|claude-code:session\/[\w-]+$)/u.test(op.source!))
      refuse(
        'source must identify comment:<id>, an https:// or codex://threads/ conversation, or claude-code:session/<session id> with answer_mode relayed.',
      );
    if (op.answerMode !== undefined) {
      if (op.action !== 'owner_performed' && op.question === undefined)
        refuse(
          'question is required, must be text without control characters and must fit within 1000 characters. Send that field again with the same owner words.',
        );
      let source: URL;
      try {
        source = new URL(op.source!);
      } catch {
        return refuse('source must identify the original chat or a task comment holding the exact relay.');
      }
      const chat =
        !source.username &&
        !source.password &&
        !!source.hostname &&
        source.pathname !== '/' &&
        (source.protocol === 'https:' || (source.protocol === 'codex:' && source.hostname === 'threads'));
      if (op.answerMode === 'direct' && !chat)
        refuse(
          'A direct answer requires its chat conversation URL as source. Send the https:// or codex://threads/ URL; use source-verified mode for an owner-authored task comment.',
        );
      if (
        op.answerMode === 'relayed' &&
        !op.source!.startsWith('comment:') &&
        !op.source!.startsWith('claude-code:session/') &&
        !chat
      )
        refuse(
          'source for a relay must identify a chat conversation, claude-code:session/<session id>, or comment:<id> preserving its exact words.',
        );
    } else if (op.question !== undefined || op.option !== undefined) {
      refuse('question and option require answerMode direct or relayed.');
    }
    if (
      op.approvalItem !== undefined &&
      (op.answerMode !== 'relayed' || !Number.isInteger(op.approvalItem) || op.approvalItem < 1 || op.approvalItem > 99)
    )
      refuse(
        'approvalItem must be a numbered proposal from 1 to 99, with answerMode relayed and its original source comment.',
      );
  } else if (
    [op.response, op.owner, op.source, op.scope, op.answerMode, op.question, op.option, op.approvalItem].some(
      (value) => value !== undefined,
    )
  ) {
    refuse(
      'Owner-answer fields require action answer, declined or owner_performed. Omit those fields for maintenance without an owner answer.',
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
          `${field} is required, must be text without control characters and must fit within ${limit} characters. Send that field again with the same owner words.`,
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
  /** The task `duplicateOf` names, as read; undefined when it names none or none was found. */
  readonly duplicate?: Task;
  readonly actor: string;
  /** The actor of the person the sender acts for, when it acts for one. */
  readonly person?: string;
  readonly at: string;
  /** Whether the answer's source shows the owner said it: the server's check, never the caller's. */
  readonly ownerVerified: boolean;
}

/**
 * The one write that records an existing owner answer or evidence-backed
 * maintenance (maintenanceSteps), or null when it is recorded already. The
 * caller verifies a linked conversation; this checks task comments, the
 * proposal's identity and the holder. Retiring a request records no
 * permission and leaves its action blocked.
 */
export function maintenanceWrite(input: MaintenanceInput): TaskWrite | null {
  const { operation: op, task, comments, actor, person, at, duplicate, ownerVerified } = input;
  if (task.id !== op.taskId || proposalOf(task) !== op.proposal) {
    return refuse('The proposal changed. Read it again and match the owner’s answer to the proposal they saw.');
  }
  const previous = maintenanceOf(task);
  const identity = JSON.stringify(op);
  const same = previous?.identity === identity && previous?.by === actor;
  const gate = task.type === 'gate';
  const performed = op.action === 'owner_performed';
  const ownerAnswer = op.action === 'answer' || op.action === 'declined' || performed;
  const declined = op.action === 'declined';
  const past = Array.isArray(previous?.events) ? previous.events.filter(isRecord) : [];
  if (
    ownerAnswer &&
    [previous, ...past].some((event) => {
      const disputed = event?.disputed;
      return (
        isRecord(disputed) &&
        (event?.source === op.source || (Array.isArray(disputed.sources) && disputed.sources.includes(op.source!)))
      );
    })
  ) {
    return refuse(
      'source and response refer to an approval the owner disputed. Record a new owner answer with its new source; the old relay cannot close this gate again.',
    );
  }
  if (declined && !gate)
    return refuse(
      'The declined outcome is only for an approval gate. Send action answer with the owner’s choice for a decision task.',
    );
  const retiring = ['completed', 'obsolete', 'superseded', 'duplicate'].includes(op.action);
  const closed = task.status === 'closed';
  const approved =
    previous?.permission === 'approved-scope-only' && previous?.scope === op.scope && !previous?.disputed;
  if (closed && !same && !(gate && approved && (performed || op.action === 'answer')))
    return refuse('status is closed. Use update_task with status open before recording a different disposition.');
  if (performed && !gate)
    return refuse('action owner_performed requires an approval gate; use completed for ordinary completed work.');
  if (gate && ['routine', 'release', 'completed'].includes(op.action)) {
    return refuse(
      'action cannot complete an approval or make it routine from implementation evidence. Use answer for the owner’s scoped approval, owner_performed with their exact completed result, or obsolete to retire an unnecessary request.',
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
    if (selfAnswer(op.owner!, actor, person))
      return refuse(
        'An agent cannot supply its own answer as the owner’s. Send the human owner’s identity and original answer source.',
      );
    let source: TaskComment | undefined;
    if (op.source!.startsWith('comment:')) {
      const id = op.source!.slice(8);
      source = comments.find((comment) => comment.id === id);
      if (!source) return refuse(`source comment ${id} was not found on this task. Use get_task to read its comments.`);
      if (op.answerMode === 'relayed') {
        if (!preservesWords(source.text, op.response!) || (!performed && !preservesWords(source.text, op.question!))) {
          return refuse(
            'source comment must contain response and question word for word. Preserve the original words when recording a relay.',
          );
        }
      } else if (source.author !== op.owner || source.text !== op.response) {
        return refuse(
          `source comment ${id} does not match owner and exact response (author: ${source.author.slice(0, 80)}). For an agent comment quoting chat, use answer_mode relayed with the exact question and reply.`,
        );
      }
    }
    if (!ownerVerified && op.answerMode !== 'direct' && op.answerMode !== 'relayed')
      return refuse(
        'source could not authenticate the owner answer. For chat use answer_mode direct with its URL, or relayed with the original session reference or comment, question and reply.',
      );
    if (!isDecision(task) && !same && !(gate && approved))
      return refuse(
        'This task has no unresolved human request. Read get_task; use close_task with implementation evidence for completed work.',
      );
    const option = gate ? null : replyOption(op.response!, offeredOf(task), op.taskId, op.option);
    const settled = same && task.status === 'open' && !task.labels.includes('human');
    if (gate) {
      const scope = askedOf(task.description);
      if (!scope || op.scope !== scope)
        return refuse('Approval scope must exactly match this gate’s requested action, environment and verification.');
      if (!performed && op.answerMode && !op.question!.includes(scope) && !(op.answerMode === 'relayed' && source)) {
        return refuse(
          'question must include this approval’s complete action, environment and verification, or cite a relayed source comment preserving the original question.',
        );
      }
      if (performed) {
        if (
          /\?|\b(?:if|unless|until|maybe|perhaps|failed|incomplete|will)\b|\bnot (?:done|finished|complete)/iu.test(
            op.response!,
          ) ||
          !/^(?:I (?:have )?(?:completed|finished|uploaded|ran|performed)|UPLOAD DONE:|Completed:|Finished:)/iu.test(
            op.response!.trim(),
          )
        ) {
          return refuse(
            'response must be the owner’s exact completed result, including what succeeded. A plan, conditional result or implementation evidence is insufficient for owner_performed.',
          );
        }
      } else if (
        declined
          ? /\b(?:if|unless|until|provided|maybe|perhaps)\b/iu.test(op.response!) ||
            !/^(?:no|decline|declined|reject|rejected|cancel|cancelled|skip\b[^?]*|do not\b[^?]*|don't\b[^?]*)[.!]?$/iu.test(
              op.response!.trim(),
            )
          : !approvesGate(op, source)
      ) {
        if (declined)
          return refuse(
            'This reply does not explicitly decline the named action. Send the owner’s exact refusal and scope; keep the action blocked while uncertain.',
          );
        return refuse(
          'response is not an explicit approval within the exact question and scope. Conditional, negative, ambiguous or broader answers remain blocked.',
        );
      }
      decisionClose(task, input);
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
    } else if (option !== null && !closed && !settled) {
      if (task.type === 'decision') decisionClose(task, input);
      // The pick is the owner's, as a task that goes back to agents records it.
      answer = () => pickInto(draft, option, undefined, input, op.owner!, at, false, false);
    } else if (!closed && !settled) {
      if (task.type === 'decision') decisionClose(task, input);
      answer = () => draft.handBack(true);
    }
  }

  const events = Array.isArray(previous?.events) ? previous.events : [];
  if (!same && events.length >= 64)
    return refuse(
      'events already contains 64 recorded dispositions. Keep the history and request owner review before adding another.',
    );
  if (!same) {
    const kept =
      previous === undefined ? [] : [Object.fromEntries(Object.entries(previous).filter(([key]) => key !== 'events'))];
    draft.metadata[MAINTENANCE] = {
      identity,
      by: actor,
      at,
      ...(op as unknown as JsonObject),
      events: [...events, ...kept] as Json[],
      ...(ownerAnswer ? { verification: op.answerMode ? 'agent-recorded' : 'source-verified' } : {}),
      ...(ownerAnswer && gate
        ? { outcome: declined ? 'declined' : performed ? 'owner-performed' : 'approved', approved: !declined }
        : {}),
      ...(performed ? { performedBy: op.owner!, recordedBy: actor } : {}),
      ...(declined ? { outcome: 'declined' } : {}),
      permission: op.action === 'answer' && gate ? 'approved-scope-only' : 'none',
    };
  }
  const note =
    `Task maintenance: ${op.action}. ${op.explanation}\nEvidence: ${op.evidence}` +
    (ownerAnswer ? `\nOwner: ${op.owner}\nSource: ${op.source}\nAnswer: ${op.response}\nScope: ${op.scope}` : '') +
    (op.answerMode
      ? `${op.question ? `\nQuestion: ${op.question}` : ''}\nRecorded by: ${actor} (relayed by an agent; not independently authenticated)`
      : '') +
    (op.action === 'release' ? `\nActivity checked: ${op.activityCheck}\nProgress preserved: ${op.progress}` : '') +
    (gate && retiring ? '\nRequest retired. No permission to perform the action was granted.' : '') +
    (declined
      ? '\nApproval declined. The recorded action must not happen. Continue only the remaining authorized work.'
      : '');
  if (note.length > 4096)
    return refuse(
      'The combined decision record is too long for a task comment. Shorten the explanation and evidence while preserving the exact question, answer and scope.',
    );
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
        `Approval request ${task.id} ${declined ? 'declined' : 'retired'}: ${op.explanation}. ` +
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

/** A person's decision, run as one write: refused unless the sender is a person
 * signed in to the web app who may change the project. */
async function decide(
  context: WriteContext,
  projectId: string,
  taskId: string,
  plan: (task: Task, around: Surroundings, actor: string, at: string) => TaskWrite | null,
  retryRequest: RetryRequest | undefined,
): Promise<Written> {
  const { principal } = context;
  if (!principal.scopes.includes(SCOPES.decide)) throw notAPerson();
  const project = await projectOf(context, projectId, 'write');
  const task = await taskOf(context, project, taskId);
  const retry = await retryOf(principal, retryRequest);
  const replay = await recorded(context, project, retry);
  if (replay !== null) return { project, result: replay };
  const actor = actorOf(principal, undefined);
  const result = await changing(context, project, task, actor, retry, async (current) =>
    plan(current, await surroundings(context, project, current), actor.name, context.now()),
  );
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
): Promise<Written> {
  return decide(
    context,
    projectId,
    taskId,
    (task, around, actor, at) => responseWrite(task, response, around, actor, at),
    retry,
  );
}

export function choose(
  context: WriteContext,
  projectId: string,
  taskId: string,
  option: TaskChoiceKey,
  note: string | undefined,
  retry?: RetryRequest,
): Promise<Written> {
  return decide(
    context,
    projectId,
    taskId,
    (task, around, actor, at) => choiceWrite(task, option, note, around, actor, at),
    retry,
  );
}

export async function dismiss(
  context: WriteContext,
  projectId: string,
  taskId: string,
  dismissal: Parameters<typeof dismissalWrite>[1],
  retry?: RetryRequest,
): Promise<Written> {
  if (dismissal.duplicateOf !== undefined) {
    if (!context.principal.scopes.includes(SCOPES.decide)) throw notAPerson();
    await tasksIn(context, await projectOf(context, projectId, 'write'), [dismissal.duplicateOf]);
  }
  return decide(context, projectId, taskId, (task) => dismissalWrite(task, dismissal), retry);
}

export function approve(
  context: WriteContext,
  projectId: string,
  taskId: string,
  reason: string | undefined,
  retry?: RetryRequest,
): Promise<Written> {
  return decide(
    context,
    projectId,
    taskId,
    (task, around, actor, at) => approvalWrite(task, reason, around, actor, at),
    retry,
  );
}

export function dispute(
  context: WriteContext,
  projectId: string,
  taskId: string,
  retry?: RetryRequest,
): Promise<Written> {
  return decide(context, projectId, taskId, (task, around, actor, at) => disputeWrite(task, around, actor, at), retry);
}

/**
 * Records an existing owner answer or evidence-backed maintenance, for the
 * agent that sends it. A comment the answer names is checked against the
 * proposal the owner saw, read from the task's history when the task changed
 * after it, and counts as the owner's own words only when the person the
 * agent acts for wrote it.
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
    const around = await surroundings(context, project, current);
    const duplicate =
      operation.duplicateOf === undefined
        ? undefined
        : ((await context.engine.getTask(project.id, operation.duplicateOf)) ?? undefined);
    const history = commentNeedsProposalHistory(operation, current, around.comments)
      ? await allEvents(context.engine, project.id, current.id)
      : [];
    const ownerAnswer =
      operation.action === 'answer' || operation.action === 'declined' || operation.action === 'owner_performed';
    const person = context.principal.person;
    const ownerVerified =
      ownerAnswer &&
      operation.answerMode === undefined &&
      operation.source!.startsWith('comment:') &&
      person !== undefined &&
      operation.owner === person &&
      commentProposalMatches(operation, current, around.comments, history);
    return maintenanceWrite({
      ...around,
      operation,
      task: current,
      ...(duplicate === undefined ? {} : { duplicate }),
      actor: actor.name,
      ...(person === undefined ? {} : { person }),
      at: context.now(),
      ownerVerified,
    });
  });
  return { project, result };
}

/** The task as a sender who may not see every project reads it after a write. */
export async function seen(context: WriteContext, task: Task): Promise<Task> {
  return (await linksSeenBy(context)).task(task);
}
