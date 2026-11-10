/**
 * The protocol's operations as the checks call them, the same over every
 * binding. `mcp.ts` and `http.ts` implement them: each sends the binding's
 * own call and reads its answer into these shapes. An operation a binding
 * does not offer throws `NotOffered`, which the runner records instead of a
 * failure.
 */
import type { BindingName, SenderRole } from './target.ts';

export type Role = SenderRole;

/** What kind of refusal a server answered, read from its binding's words. */
export type RefusalKind =
  /** An argument is missing, unknown or out of range. */
  | 'invalid'
  /** The task's state, the sender's reach or a rule stops the change. */
  | 'refused'
  /** The idempotency key was first used for a different change. */
  | 'conflict'
  /** The server did not complete the change. */
  | 'unavailable'
  /** The sender lacks the scope the operation needs. */
  | 'scope'
  /** The sender may read the project but not change it. */
  | 'forbidden'
  /** The workspace, project or task does not exist for this sender. */
  | 'not_found'
  | 'unauthorized'
  | 'other';

export interface Refusal {
  readonly kind: RefusalKind;
  /** The refusal as the binding answered it: an MCP result's text, or an HTTP body. */
  readonly text: string;
  readonly status?: number;
  /** The HTTP body's `error` code. */
  readonly code?: string;
  /** Whether the answer is a refusal the binding's rules allow: an MCP error result, or an HTTP body with an `error` code. */
  readonly wellFormed: boolean;
}

export type Outcome<T> =
  | { readonly ok: true; readonly value: T; readonly refusal?: undefined }
  | { readonly ok: false; readonly refusal: Refusal; readonly value?: undefined };

export class NotOffered extends Error {
  readonly binding: BindingName;
  readonly operation: string;

  constructor(binding: BindingName, operation: string) {
    super(`${binding} offers no way to ${operation}`);
    this.binding = binding;
    this.operation = operation;
  }
}

/** A check needs a sender the target names none of, on a binding that offers the call. */
export class MissingSender extends Error {
  readonly role: string;

  constructor(role: string) {
    super(`the target names no ${role}`);
    this.role = role;
  }
}

/** A task as a read answers it. Fields a server leaves out read as their empty value. */
export type Task = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly type: string;
  readonly assignee?: string | null;
  readonly labels?: readonly string[];
  readonly ready?: boolean;
  readonly resolution?: string | null;
  readonly closeReason?: string | null;
  readonly closeLink?: string | null;
  readonly proof?: string | null;
  readonly delivery?: Delivery | null;
  readonly answer?: Answer | null;
  readonly choice?: Readonly<Record<string, unknown>> | null;
  readonly dependencies?: readonly { readonly id: string; readonly type: string }[];
  readonly for?: string | null;
  readonly work?: Readonly<Record<string, string>> | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
  readonly createdAt?: string;
  readonly duplicateOf?: string | null;
  readonly steps?: readonly Step[] | null;
  readonly closeAcceptance?: Acceptance | null;
  /** In progress and held, with no holder activity for the server's period, or none recorded (STATE-16). */
  readonly stalled?: boolean;
};

/** A close as done on a person's call: each criterion met or waived, and who passed it on. */
export interface Acceptance {
  readonly by: string;
  readonly relayed?: { readonly by: string; readonly source: string; readonly quote: string } | null;
  readonly criteria: readonly { readonly text: string; readonly met: boolean }[];
}

/** One step of a request to do steps, with the person's marks on it. */
export interface Step {
  readonly text: string;
  readonly command: string | null;
  readonly done: { readonly by: string; readonly at: string } | null;
  readonly note: { readonly text: string; readonly by: string } | null;
  readonly stuck: { readonly reason: string; readonly by: string } | null;
}

export interface StepsRequest {
  readonly title: string;
  readonly context: string;
  readonly steps: readonly { readonly text: string; readonly command?: string }[];
}

export interface Delivery {
  readonly stage: 'built' | 'merged' | 'live';
  readonly commit?: string | null;
  readonly pullRequest?: string | null;
  readonly mergeCommit?: string | null;
}

export interface Answer {
  readonly option: string | null;
  readonly quote: string | null;
  readonly source: string | null;
  readonly recordedBy: string;
  readonly relayed: boolean;
  readonly proposalVersion: string;
  readonly disputedBy: string | null;
}

export interface Comment {
  readonly id?: string;
  readonly author: string;
  readonly text: string;
}

export interface TaskRead {
  readonly task: Task;
  readonly comments: readonly Comment[];
  readonly proposalVersion: string | null;
}

export interface HistoryEvent {
  readonly revision: string;
  readonly at: string;
  readonly actor: string;
  readonly model: string | null;
  readonly actions: readonly string[];
  readonly fields: Readonly<Record<string, { readonly old: unknown; readonly new: unknown }>>;
}

export interface Project {
  readonly projectId: string;
  readonly prefix: string;
  readonly deploys: boolean;
}

/** What a write answered: the task it wrote and, where the binding answers them, its version and whether it was replayed. */
export interface Written {
  readonly id: string;
  readonly version: number | null;
  readonly replayed: boolean | null;
  readonly status?: string;
  readonly assignee?: string | null;
  readonly raw: unknown;
}

export interface WriteOptions {
  readonly key?: string;
  readonly model?: string;
}

export type WorkDetails = Partial<
  Readonly<Record<'session' | 'worktree' | 'branch' | 'pr' | 'commit' | 'next', string>>
>;

export interface Choices {
  readonly question: string;
  readonly options: readonly { readonly key: string; readonly label: string; readonly recommended?: boolean }[];
}

export interface NewTask {
  /** The project, `main` when left out. */
  readonly project?: string;
  readonly title: string;
  readonly description?: string;
  /** What proves it done; each list item or line is a criterion. */
  readonly acceptance?: string;
  readonly type?: string;
  readonly labels?: readonly string[];
  readonly parent?: string;
  readonly choices?: Choices;
  /** Tasks it waits on through a `blocks` link. */
  readonly dependsOn?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Filed claimed by the sender. */
  readonly claim?: boolean;
}

export interface Change {
  readonly title?: string;
  readonly description?: string;
  readonly status?: string;
  /** `""` releases the task. */
  readonly assignee?: string;
  readonly parent?: string;
  /** A time to defer the task to, or `""` to clear it. */
  readonly defer?: string;
  readonly addLabels?: readonly string[];
  readonly removeLabels?: readonly string[];
  readonly choices?: Choices | null;
}

export interface Close {
  readonly reason: string;
  readonly resolution?: string;
  readonly duplicateOf?: string;
  readonly commit?: string;
  readonly pr?: string;
  readonly link?: string;
}

export type LinkType = 'blocks' | 'related' | 'discovered-from' | 'duplicates' | 'supersedes';

/** An answer or a request's maintenance, relayed by a sender other than the person. */
export interface Relay {
  readonly action:
    | 'answer'
    | 'declined'
    | 'owner_performed'
    | 'completed'
    | 'obsolete'
    | 'superseded'
    | 'duplicate'
    | 'routine'
    | 'release'
    | 'accepted';
  readonly proposalVersion: string;
  /** With `accepted`: the numbers of the criteria the person found met. */
  readonly met?: readonly number[];
  readonly option?: string;
  readonly quote?: string;
  readonly source?: string;
  readonly explanation?: string;
  readonly evidence?: string;
  readonly duplicateOf?: string;
  readonly holder?: string;
  readonly inactive?: boolean;
  readonly activityCheck?: string;
  readonly progress?: string;
}

/** A person's own decision, made in the server's own interface. */
export type Decision =
  | { readonly kind: 'choose'; readonly option: string; readonly note?: string; readonly proposalVersion?: string }
  | { readonly kind: 'respond'; readonly response: string; readonly proposalVersion?: string }
  | { readonly kind: 'dismiss'; readonly reason?: string; readonly resolution?: string }
  | { readonly kind: 'approve'; readonly reason?: string; readonly proposalVersion?: string }
  | { readonly kind: 'dispute' }
  /** Frees a task someone holds, on the person's own call (AUTH-9); `holder` is the holder the person was shown. */
  | { readonly kind: 'release'; readonly holder?: string }
  | {
      readonly kind: 'accept';
      /** The numbers of the criteria the person found met, from 1. */
      readonly met: readonly number[];
      readonly proposalVersion?: string;
      readonly reason?: string;
    }
  | {
      readonly kind: 'step';
      /** The step's place, from 1. */
      readonly step: number;
      readonly done?: boolean;
      readonly note?: string | null;
      readonly stuck?: string | null;
    };

export interface Signal {
  readonly repository: string;
  readonly stage: 'merged' | 'live';
  readonly pullRequests?: readonly string[];
  readonly commits?: readonly string[];
}

/** The protocol's operations, for one sender over one binding. */
export interface Api {
  readonly binding: BindingName;
  readonly role: Role;
  projects(): Promise<Outcome<readonly Project[]>>;
  create(task: NewTask, options?: WriteOptions): Promise<Outcome<Written>>;
  read(task: string): Promise<Outcome<TaskRead>>;
  history(task: string): Promise<Outcome<readonly HistoryEvent[]>>;
  /** The ids of the project's ready tasks. */
  ready(project?: string): Promise<Outcome<readonly string[]>>;
  /** The ids of the project's stalled tasks. */
  stalled(project?: string): Promise<Outcome<readonly string[]>>;
  claim(
    task: string,
    options?: WriteOptions & { readonly work?: WorkDetails; readonly for?: string },
  ): Promise<Outcome<Written>>;
  /** Claims the open task whose work details or pull-request link name `pr`. */
  claimByPullRequest(pr: string, options?: WriteOptions): Promise<Outcome<Written>>;
  update(task: string, change: Change, options?: WriteOptions): Promise<Outcome<Written>>;
  comment(
    task: string,
    text: string,
    options?: WriteOptions & { readonly work?: WorkDetails; readonly for?: string },
  ): Promise<Outcome<Written>>;
  close(task: string, close: Close, options?: WriteOptions): Promise<Outcome<Written>>;
  /** Sets the one link between two tasks, or removes it when `type` is null. */
  link(task: string, to: string, type: LinkType | null): Promise<Outcome<unknown>>;
  requestApproval(
    task: string,
    request: string,
  ): Promise<Outcome<{ readonly approval: string; readonly created: boolean }>>;
  /** Asks a person to do steps; the task waits on the request. */
  requestSteps(
    task: string,
    request: StepsRequest,
  ): Promise<Outcome<{ readonly request: string; readonly created: boolean }>>;
  relay(task: string, relay: Relay, options?: WriteOptions): Promise<Outcome<Written>>;
  decide(task: string, decision: Decision, options?: WriteOptions): Promise<Outcome<Task>>;
  signal(
    signal: Signal,
  ): Promise<Outcome<{ readonly moved: readonly { readonly id: string; readonly stage: string }[] }>>;
  /** Changes a task's title through an argument the binding does not name, `titel`. */
  misnamed(task: string): Promise<Outcome<unknown>>;
  /** Connects afresh, as a new session does, and answers what the server tells it. */
  connect(): Promise<Outcome<{ readonly instructions: string }>>;
}
