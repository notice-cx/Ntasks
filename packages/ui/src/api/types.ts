/**
 * What the Tasks API answers, as the app reads it. These are the HTTP shapes
 * of NoticeOS's `/api/tasks` (its `LiveTask`, `LiveTasksPayload` and
 * `LiveTaskDetail`), which the Ntasks API keeps so both apps read one format.
 * Statuses, types and link types stay strings here: a value this build has
 * never seen is drawn as itself instead of breaking the page.
 */
import type { TaskResolution, TaskStep, TaskWork } from '@ntasks/domain';

export type { StepMark, StepMarking, TaskStep } from '@ntasks/domain';

/** Option keys, in the order options are shown. */
export const TASK_CHOICE_KEYS = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
export type TaskChoiceKey = (typeof TASK_CHOICE_KEYS)[number];

export interface TaskChoiceOption {
  readonly key: TaskChoiceKey;
  /** One line: the words on the option's button. */
  readonly label: string;
  readonly detail?: string;
  /** On exactly one option of a set. */
  readonly recommended?: true;
}

/** The options a decision offers a person. */
export interface TaskChoices {
  readonly question: string;
  readonly options: readonly TaskChoiceOption[];
}

/** A person's pick, as the choose operation records it. */
export interface TaskChoice {
  readonly option: TaskChoiceKey;
  /** The option's label when it was chosen. */
  readonly label: string;
  readonly by: string;
  readonly at: string;
  readonly note?: string;
}

/** The latest answer recorded on a task. */
export interface TaskAnswer {
  /** A letter on a task with choices, `approve`, `done` or `decline` on an approval, `done` or `decline` on a
   * request to do steps, null when it chose none. `done` is the person's report that they did it themselves. */
  readonly option: string | null;
  /** The person's words, as given. */
  readonly quote: string | null;
  /** Where the person said it, as the agent or service that relayed it named it. */
  readonly source: string | null;
  readonly recordedBy: string;
  /** An agent or a service recorded it for the person; false when the person answered here. */
  readonly relayed: boolean;
  /** The version of the proposal it answered. */
  readonly proposalVersion: string | null;
  readonly at: string;
  readonly disputedBy: string | null;
}

/** One link from a task to another task. */
export interface TaskDependency {
  /** The task on the other end. */
  id: string;
  /** `blocks`, `parent-child`, `related`, `discovered-from`, `duplicates`, `supersedes`, `merges-after`, or a type this build does not know. */
  type: string;
  /** Present when the read carried it (a task's own read); null on a list row. */
  title: string | null;
  /** The other task's status, when the read carried it. */
  status: string | null;
}

/** A page outside Ntasks a task links to, such as a pull request. */
export interface TaskExternalLink {
  url: string;
  title: string;
  /** `pull-request`, `document`, `other`, a kind this build does not know, or null. */
  kind: string | null;
}

/** A custom field's value: text, a number, a date or URL as text, an option, a list of options, or yes or no. */
export type TaskFieldValue = string | number | boolean | string[];

/** A custom field a project defines, as `GET /api/fields` lists it. */
export interface TaskField {
  /** Names the field in a task's `fields` and in a board's filter. */
  key: string;
  name: string;
  /** `text`, `number`, `date`, `single-choice`, `multiple-choice`, `url`, `yes-no`, or a type this build does not know. */
  type: string;
  /** A choice field's options, in order; null for any other type. */
  options: string[] | null;
  createdAt: string;
  /** When it was retired: it keeps the values tasks carry and takes no new ones. Null while it is in use. */
  retiredAt: string | null;
}

/** One project's custom fields, retired ones included, in the order they were defined. */
export interface ProjectFields {
  /** The project's key. */
  project: string;
  fields: TaskField[];
}

/** A board's filter by custom field: each field's key and the one value a task must hold, as the address writes it. */
export type FieldFilters = Readonly<Record<string, string>>;

/** Where a closed task's change is, as the server records it. */
export interface TaskDelivery {
  /** `built`, `merged`, `live`, or a stage this build does not know. */
  stage: string;
  commit: string | null;
  /** The pull request's URL. */
  pullRequest: string | null;
  mergeCommit: string | null;
  builtAt: string;
  mergedAt: string | null;
  liveAt: string | null;
}

/** A person's acceptance of a task as done on their own call, as its close records it. */
export interface TaskAcceptance {
  /** The person who accepted it. */
  by: string;
  /** The client id of the connected app they accepted it through. */
  app?: string;
  /** The agent or service that recorded it for them, where they said it, and their words. */
  relayed?: { by: string; source: string; quote: string };
  /** Each criterion of the task's Done when, in order: met, or waived when false. */
  criteria: { text: string; met: boolean }[];
}

/** One task, as a board row and a task page read it. */
export interface LiveTask {
  id: string;
  title: string;
  status: string;
  /** 0 is the most urgent, 4 the least. */
  priority: number;
  issueType: string;
  assignee: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  createdAt: string | null;
  /** The epic this task belongs to, or null. */
  parent: string | null;
  deferUntil: string | null;
  /** When the work is due, when the server sends it; null when it has no due date. */
  dueAt?: string | null;
  choices?: TaskChoices | null;
  choice?: TaskChoice | null;
  /** While the task waits on a person, the version of the proposal they answer,
   * which an answer sends back; null otherwise, and absent when the server sends none. */
  proposalVersion?: string | null;
  /** The latest answer recorded on it, when the server sends one. */
  answer?: TaskAnswer | null;
  /** How a closed task's close ended; null on a task that is not closed. */
  resolution?: TaskResolution | null;
  duplicateOf?: string | null;
  /** Empty when the task carries none. */
  description: string;
  acceptance: string;
  /** Markdown, empty when the task carries none, when the server sends them. */
  notes?: string;
  design?: string;
  /** Whole minutes; null when nobody estimated it. */
  estimateMinutes?: number | null;
  labels: string[];
  /** Someone can start it now, as the server worked it out. */
  ready: boolean;
  dependencies: TaskDependency[];
  /** The links other tasks hold onto this one, in any project the reader reaches; a server without the API version in workers/api/api-versions/2026-11-10T0513Z-touches-merge-order.json leaves it out. */
  dependents?: TaskDependency[];
  /** Ordered by URL, when the server sends them. */
  externalLinks?: TaskExternalLink[];
  /** The values of its project's custom fields, by field key, when the server sends them. */
  fields?: Record<string, TaskFieldValue>;
  /** How many comments the task carries; the bodies come with the task's own read. */
  comments: number;
  /** Fields other systems attach, stored and returned as given. */
  metadata: Record<string, unknown> | null;
  /** When someone claimed it, null while nobody has. */
  startedAt: string | null;
  /** The close's evidence: a commit, a link, or why nothing shipped. */
  closeReason: string | null;
  /** `human` on an approval a person answers; null on every other task. */
  awaitType: string | null;
  /** On a request that a person do steps: the steps, with who ticked each, their notes and where they got
   * stuck. Null on every other task, and absent when the server sends none. */
  steps?: readonly TaskStep[] | null;
  /** Who filed the task and the model they named, when the server sends them; null on a task imported without them. */
  filedBy?: string | null;
  filedModel?: string | null;
  /** Who closed the task and the model they named, when the server sends them. */
  closedBy?: string | null;
  closedModel?: string | null;
  /** The model the assignee named when they claimed the task, when the server sends it. */
  assigneeModel?: string | null;
  /** Where a closed task's change is; null when it has none. */
  delivery?: TaskDelivery | null;
  /** The URL a close as done named to show the work, when the server sends it. */
  closeLink?: string | null;
  /** `none` for a task, bug, feature or chore closed as done with no commit, pull request or link. */
  proof?: 'none' | null;
  /** On a task a person accepted as done on their own call, when the server sends it. */
  closeAcceptance?: TaskAcceptance | null;
  /** The helper agent the assignee works through, shown as `claude for page-rebuild-2`, when the server sends it. */
  for?: string | null;
  /** What the assignee recorded about the work in hand, such as its branch and next step, when the server sends it. */
  work?: TaskWork;
  /** When the assignee last changed or commented on the task, when the server sends it. */
  lastActivityAt?: string | null;
  /** In progress and held, with no holder activity for a day or none recorded, as of the read, when the server sends it. */
  stalled?: boolean;
}

/** An epic with its all-time child progress. */
export interface LiveEpic {
  id: string;
  title: string;
  status: string;
  priority: number;
  total: number;
  closed: number;
  /** Open, with every child closed. */
  eligibleForClose: boolean;
}

/** A person the API names, for a task field that holds their id. */
export interface TaskActor {
  readonly principalId: string;
  readonly displayName: string;
}

/** One project's board: its open, in-progress, blocked and parked tasks, and its recent closes. */
export interface LiveTasksPayload {
  actors?: readonly TaskActor[];
  /** The project's key. */
  project: string;
  prefix: string;
  repo: string;
  /** When the server read the tasks. */
  readAt: string;
  /** The earliest close time the closed tasks in `tasks` cover. */
  closedSince?: string;
  /** The latest change the board reflects: the change feed starts after it. */
  lastSeq?: number;
  tasks: LiveTask[];
  /** Null when the server could not read the epics' progress. */
  epics: LiveEpic[] | null;
}

/** A task a search found, with its project's key. */
export type FoundTask = LiveTask & { project: string };

/** What a search of every project this sign-in reaches found. */
export interface TaskSearch {
  readAt: string;
  /** How many tasks matched; `tasks` holds the most urgent of them. */
  total: number;
  tasks: FoundTask[];
}

/** A task a shipped change closed. */
export interface WinTask {
  readonly id: string;
  readonly title: string;
}

/** A change that merged or went live: its pull request, or its commit when it has none, with the tasks it closed. */
export interface ShippedWin {
  readonly kind: 'shipped';
  readonly at: string;
  readonly projectId: string;
  /** `merged`, `live`, or a stage this build does not know. */
  readonly stage: string;
  readonly pullRequest: string | null;
  readonly commit: string | null;
  readonly tasks: readonly WinTask[];
}

/** A person's answer to a task's choices. */
export interface DecidedWin {
  readonly kind: 'decided';
  readonly at: string;
  readonly projectId: string;
  readonly id: string;
  readonly title: string;
  readonly option: string;
  readonly label: string;
  /** The person who answered. */
  readonly by: string;
}

/** An epic closed as done, with how many of its tasks closed as done. */
export interface FinishedWin {
  readonly kind: 'finished';
  readonly at: string;
  readonly projectId: string;
  readonly id: string;
  readonly title: string;
  readonly done: number;
}

export type Win = ShippedWin | DecidedWin | FinishedWin;

/** One UTC day's wins, by kind. */
export interface WinsDay {
  /** YYYY-MM-DD. */
  readonly day: string;
  readonly shipped: number;
  readonly decided: number;
  readonly finished: number;
}

/** Seven days of wins (docs/api.md, "Wins"). */
export interface WinsPage {
  readonly readAt: string;
  /** The time zone the days are cut in; an Ntasks older than API version 10 names none and cuts them in UTC. */
  readonly timeZone?: string;
  /** The first instant covered: the first day's midnight in `timeZone`. */
  readonly from: string;
  /** The instant after the last covered: the next day's midnight in `timeZone`. */
  readonly to: string;
  /** The `before` that reads the seven days before these, or null at the oldest the server keeps. */
  readonly earlier: string | null;
  readonly projects: number;
  /** Whether any change shipped before `from`; when none did, merges may not have been recorded yet. */
  readonly shippedBefore: boolean;
  readonly totals: {
    readonly shipped: number;
    readonly decided: number;
    readonly finished: number;
    readonly approved: number;
  };
  /** Each day, oldest first. */
  readonly days: readonly WinsDay[];
  /** Every win, newest first. */
  readonly wins: readonly Win[];
}

/** One day of the burn-down. Every count is null on a day that ended before anything was recorded. */
export interface BurndownDay {
  /** YYYY-MM-DD. */
  readonly day: string;
  /** The tasks not closed at the day's end; for today, now. */
  readonly open: number | null;
  readonly created: number | null;
  /** The tasks closed as done. */
  readonly done: number | null;
  /** The tasks closed any other way: won't do, duplicate, can't reproduce, already handled or no longer needed. */
  readonly closedNotDone: number | null;
}

/** The last eight weeks of open, created and closed tasks (docs/api.md, "Burn-down"). */
export interface BurndownPage {
  readonly readAt: string;
  /** The time zone the days are cut in. */
  readonly timeZone: string;
  /** The first day's midnight in `timeZone`. */
  readonly from: string;
  /** Tomorrow's midnight in `timeZone`. */
  readonly to: string;
  readonly projects: number;
  /** The first day with a record, or null when none of these days has one. */
  readonly recordedFrom: string | null;
  /** Each day, oldest first. */
  readonly days: readonly BurndownDay[];
}

/** One change to a task, as the change feed lists it. */
export interface TaskChange {
  /** Orders every change in the installation. */
  seq: number;
  /** The project's id, as the project list gives it. */
  projectId: string;
  taskId: string;
}

/** The changes after a sequence number, and the number to ask after next. */
export interface ChangesPage {
  events: TaskChange[];
  lastSeq: number;
}

export interface TaskComment {
  id: string;
  author: string;
  text: string;
  createdAt: string | null;
  /** Pinned as a fact later work needs; a server before API version 7 leaves it out. */
  pinned?: boolean;
}

/** One of the parent's other children that closed: how it ended, why, and what proves it. */
export interface ClosedSibling {
  id: string;
  title: string;
  resolution: TaskResolution;
  closedAt: string;
  closedBy: string | null;
  closeReason: string | null;
  commit: string | null;
  pullRequest: string | null;
  closeLink: string | null;
}

/** What a task's parent holds for it: its newest pinned comments and most recently closed other children, with the totals. */
export interface ParentContext {
  id: string;
  title: string;
  type: string;
  status: string;
  pinned: Omit<TaskComment, 'pinned'>[];
  pinnedTotal: number;
  closedSiblings: ClosedSibling[];
  closedSiblingsTotal: number;
}

/** One task and its comments: the task page's read. */
export interface LiveTaskDetail {
  actors?: readonly TaskActor[];
  project: string;
  prefix: string;
  repo: string;
  readAt: string;
  task: LiveTask;
  comments: TaskComment[];
  /** The version of the task's proposal, whatever it waits on, when the server sends it: an acceptance names it. */
  proposalVersion?: string | null;
  /** What its parent holds for it; null when it has none, and left out by a server before API version 7. */
  parent?: ParentContext | null;
}

/** What creating a task answers with. */
export interface TaskCreated {
  id: string;
  project: string;
}

/** What this sign-in may do. */
export interface TasksCapabilities {
  live: boolean;
  writable?: boolean;
  /** Every read and write names its project. */
  projectSelection?: boolean;
  /** The write operations offered; absent means all of them. */
  operations?: readonly string[];
  /** The fields an update may change; absent means all of them. */
  editableFields?: readonly string[];
  reason: string | null;
}

/** One project, as the project list names it. */
export interface TaskProject {
  projectId: string;
  /** The key the app addresses the project by in its addresses and reads. */
  logicalKey: string;
  displayName: string;
  prefix: string;
  /** Its changes go live by a deploy, when the server says; merged is its tasks' last stage otherwise. */
  deploys?: boolean;
  /** It takes no new tasks, and the app leaves it out of the sidebar and the board; its tasks stay readable. */
  disabled?: boolean;
  /** Its website, when the server says. */
  websiteUrl?: string | null;
  /** The address of the icon read from its website, on the API's origin; null or absent when it has none. */
  icon?: string | null;
}

/** An owner's change to a project: each field it names, and only those. */
export interface ProjectEdit {
  displayName?: string;
  deploys?: boolean;
  disabled?: boolean;
  /** An http or https address, or null to clear it; saving one reads its icon. */
  websiteUrl?: string | null;
}

/** A new task. */
export interface NewTask {
  /** The project's key. */
  project: string;
  title: string;
  description?: string;
  type?: string;
  priority?: number;
  labels?: string[];
  parent?: string;
  acceptance?: string;
  metadata?: Record<string, unknown>;
}

/** The fields an edit may change. */
export interface TaskEdit {
  /** Take the task: the sender becomes its assignee and it moves to in progress. */
  claim?: true;
  status?: string;
  priority?: number;
  assignee?: string;
  parent?: string;
  /** A date, `YYYY-MM-DD`; the empty string clears it. */
  defer?: string;
  title?: string;
  description?: string;
  acceptance?: string;
  /** Markdown; the empty string clears it. */
  notes?: string;
  design?: string;
  /** Whole minutes; null takes the estimate off. */
  estimateMinutes?: number | null;
  /** A date, `YYYY-MM-DD`; null takes the due date off. */
  dueAt?: string | null;
  addLabels?: string[];
  removeLabels?: string[];
  /** Pages to link to; a URL the task already links to takes the new title and kind. */
  addExternalLinks?: NewExternalLink[];
  /** The URLs of links to take off. */
  removeExternalLinks?: string[];
  /** Links to other tasks, sent with no other field. Two tasks hold one link, so a new type replaces the pair's. */
  addLinks?: NewTaskLink[];
  /** The task ids whose link with this task to take off, whichever way it points. */
  removeLinks?: string[];
  /** Custom field values by key; null takes a value off. */
  fields?: Record<string, TaskFieldValue | null>;
}

/** A link to another task, as a write sends it: `blocks` (this task waits on that one), `related`,
 * `discovered-from`, `duplicates`, `supersedes` or `merges-after`. */
export interface NewTaskLink {
  taskId: string;
  type: string;
}

/** A page a task links to, as a write sends it. */
export interface NewExternalLink {
  url: string;
  title: string;
  /** `pull-request`, `document` or `other`; left out when none is given. */
  kind?: string;
}

/** How a close ended when it is not done, and for a duplicate the other task. */
export interface CloseOptions {
  resolution?: TaskResolution;
  duplicateOf?: string;
}

/** What a person may do in a workspace. Both read, write and decide; an owner also manages its members and projects. */
export type WorkspaceRole = 'owner' | 'member';

/** One workspace the sign-in reaches, as `GET /api/workspaces` lists it. */
export interface Workspace {
  workspaceId: string;
  name: string;
  role: WorkspaceRole;
}

/** Who is signed in, as `GET /api/access/me` answers. */
export interface Account {
  name: string;
  /** One of the deployment's admins, who alone create workspaces. */
  deploymentAdmin: boolean;
  /** The time zone the person chose in Settings, an IANA name; null uses the browser's. */
  timeZone: string | null;
}

/** A new project, as `POST /api/tasks/projects` takes it. */
export interface NewProject {
  name: string;
  /** Starts every task id in the project: lowercase letters and digits. */
  prefix: string;
}

/** A person in the workspace. */
export interface WorkspaceMember {
  userId: string;
  name: string;
  /** The GitHub account they sign in with, when the server names it. */
  githubLogin: string | null;
  role: WorkspaceRole;
}

/** A GitHub account invited to the workspace that has not signed in yet. */
export interface WorkspaceInvitation {
  invitationId: string;
  githubLogin: string;
  role: WorkspaceRole;
  createdAt: string | null;
}

/** The workspace's members and its pending invitations, as `GET /api/access/members` answers. */
export interface WorkspaceMembers {
  members: WorkspaceMember[];
  invitations: WorkspaceInvitation[];
}

/** An invitation, as `POST /api/access/invitations` takes it. */
export interface NewInvitation {
  githubLogin: string;
  role: WorkspaceRole;
}

/** A connected app of the workspace, as `GET /api/access/apps` lists it: one that acts as whoever signs in to it. */
export interface ConnectedApp {
  clientId: string;
  name: string;
  redirectUris: string[];
  createdAt: string | null;
  /** When the person reading signed in to it, or null when they have not. */
  connectedAt: string | null;
}

/** The workspace's GitHub connection, as `GET /api/access/github` shows it to an owner: never a secret. */
export interface GitHubWebhook {
  /** Where GitHub sends deliveries: the webhook's Payload URL. */
  url: string;
  /** Whether a secret is saved by hand that deliveries can be checked against. */
  secretSaved: boolean;
  /** The check runs and deployment environments typed by hand whose success means a change is live. */
  deployChecks: string[];
  /** When the webhook set up by hand was last saved, or null when there is none. */
  updatedAt: string | null;
  /** The workspace's GitHub App, made with Connect GitHub, or null before it is. */
  app: GitHubApp | null;
  /** Where an owner installed the app. */
  installations: GitHubInstallation[];
  /** The deploy checks deliveries showed, each counted or switched off. */
  detected: DetectedDeploy[];
}

/** The workspace's GitHub App: its page, and where to install it. */
export interface GitHubApp {
  slug: string;
  url: string;
  createdAt: string;
  /** GitHub's page that installs the app on an account the person picks, such as an organization. */
  installUrl: string;
  /** GitHub's page that installs the app on the person's own account. */
  accountInstallUrl: string;
}

export interface GitHubInstallation {
  installationId: number;
  /** The GitHub account it is installed on, such as an organization's name. */
  account: string;
  accountType: string;
  createdAt: string;
}

/** A check run or deployment environment that counted as a deploy, and whether it still counts. */
export interface DetectedDeploy {
  name: string;
  on: boolean;
  seenAt: string;
}

/** Where the browser posts the manifest that makes the workspace's GitHub App. */
export interface GitHubAppStart {
  action: string;
  manifest: string;
}

/** What an owner saves with `POST /api/access/github`: a new secret, the deploy checks, or both. */
export interface GitHubWebhookSettings {
  secret?: string;
  deployChecks?: string[];
}

/** A connected app, as `POST /api/access/apps` takes it. */
export interface NewApp {
  name: string;
  redirectUris: string[];
}

/** A service credential's reach in one project: to read its tasks, or to read and change them. */
export interface ServiceGrant {
  projectId: string;
  access: 'read' | 'write';
}

/** A credential a service, such as a NoticeOS installation or a nightly backup, signs in with. Never its token. */
export interface ServiceCredential {
  id: string;
  name: string;
  createdAt: string;
  /** When an owner revoked it; its token is refused from then on. */
  revokedAt: string | null;
  grants: ServiceGrant[];
  /** It reads the workspace's whole store for a backup. */
  backup: boolean;
  /** It loads rows into the workspace's store while the store is empty. */
  restore: boolean;
}

/** A service credential, as `POST /api/access/services` takes it. One with no grants needs backup or restore. */
export interface NewServiceCredential {
  name: string;
  grants: ServiceGrant[];
  backup: boolean;
  restore: boolean;
}

/** A credential just made, with the token the server shows this once. */
export interface MadeServiceCredential extends ServiceCredential {
  token: string;
}
