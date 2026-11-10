/**
 * Every read and write the app makes goes through one `TasksApi`. The HTTP
 * client below speaks NoticeOS's `/api/tasks` format, which the Ntasks API
 * keeps; `fixture.ts` answers the same calls from data held in the page, for
 * development and tests while no API serves them.
 *
 * The app names a project by its key (`TaskProject.logicalKey`), in its
 * addresses and its caches. The HTTP client looks the key up in the project
 * list and sends the project's id: `?project=<id>` on a read and `projectId`
 * in a write's body. A key the list does not hold is refused here, before
 * any request, so a typed address can never reach another project.
 *
 * Every call but the four about the sign-in and its workspaces (`workspaces`,
 * `account`, `createWorkspace` and `renameWorkspace`, which names its
 * workspace in its body) is made in the workspace `selectWorkspace` chose,
 * and names it in the `x-ntasks-workspace` header. A call takes the workspace
 * selected when it starts, so a call still running after a switch finishes
 * in the workspace it began in.
 */
import type { TaskResolution } from '@ntasks/domain';
import type {
  Account,
  ChangesPage,
  CloseOptions,
  ConnectedApp,
  GitHubWebhook,
  GitHubWebhookSettings,
  FieldFilters,
  LiveTaskDetail,
  LiveTasksPayload,
  NewApp,
  NewInvitation,
  NewProject,
  NewTask,
  ProjectFields,
  StepMarking,
  TaskChoiceKey,
  TaskCreated,
  TaskEdit,
  TaskField,
  TaskProject,
  TaskSearch,
  WinsPage,
  TasksCapabilities,
  Workspace,
  WorkspaceMembers,
  WorkspaceRole,
} from './types';

/** The header that names the workspace a call is made in. */
export const WORKSPACE_HEADER = 'x-ntasks-workspace';

export interface WriteOptions {
  /** Send the write while the page is leaving. */
  keepalive?: boolean;
  /** The retry key. A second attempt at the same submission passes the key
   * the first attempt used, so the server applies it once even when the first
   * attempt's answer was lost; without one, the write gets a new key. */
  idempotencyKey?: string;
}

export interface AnswerOptions {
  /** The proposal version the page showed. The server refuses the answer once
   * the task's proposal has changed from it; null sends none. */
  proposalVersion?: string | null;
}

export interface TasksApi {
  /** The workspace every call after this one is made in; null names none, as a sender who reaches one may. */
  selectWorkspace(workspaceId: string | null): void;
  /** The workspaces this sign-in reaches, with its role in each. */
  workspaces(signal?: AbortSignal): Promise<readonly Workspace[]>;
  /** Who is signed in. */
  account(signal?: AbortSignal): Promise<Account>;
  /** Only the deployment's admins may create a workspace; its creator becomes its owner. */
  createWorkspace(name: string, options?: WriteOptions): Promise<Workspace>;
  /** Only the workspace's owners may rename it. */
  renameWorkspace(workspaceId: string, name: string, options?: WriteOptions): Promise<Workspace>;
  capabilities(signal?: AbortSignal): Promise<TasksCapabilities>;
  projects(signal?: AbortSignal): Promise<readonly TaskProject[]>;
  /** One project's board: unfinished tasks and the last week's closes; with
   * `fields`, only the tasks holding each value. */
  board(project: string, signal?: AbortSignal, fields?: FieldFilters): Promise<LiveTasksPayload>;
  /** One project's closed tasks whose change is built or merged, whenever they closed. */
  delivery(project: string, signal?: AbortSignal): Promise<LiveTasksPayload>;
  task(id: string, project: string, signal?: AbortSignal): Promise<LiveTaskDetail>;
  /** The tasks of every project this sign-in reaches whose id, title, description, acceptance or labels hold
   * every word of `text`, among unfinished tasks and the last week's closes; a task id names its task first,
   * closed at any time. */
  search(text: string, signal?: AbortSignal): Promise<TaskSearch>;
  /** The project's custom fields, retired ones included. */
  fields(project: string, signal?: AbortSignal): Promise<ProjectFields>;
  /** Every change after sequence number `after`, in every project this sign-in reaches, oldest first. */
  changes(after: number, signal?: AbortSignal): Promise<ChangesPage>;
  /** Seven days of wins: changes shipped, answers given and epics finished, in one project or every one this
   * sign-in reaches. Without `before`, today and the six days before it; with it (YYYY-MM-DD), the seven
   * days before that day. */
  wins(options: { project?: string; before?: string }, signal?: AbortSignal): Promise<WinsPage>;
  createTask(input: NewTask, options?: WriteOptions): Promise<TaskCreated>;
  updateTask(id: string, project: string, edit: TaskEdit, options?: WriteOptions): Promise<void>;
  /** A close needs its reason: the evidence, or why nothing shipped. No resolution means done. */
  closeTask(id: string, project: string, reason: string, options?: CloseOptions & WriteOptions): Promise<void>;
  comment(id: string, project: string, text: string, options?: WriteOptions): Promise<void>;
  /** Answer a task waiting on a person: a decision closes with the answer, any other task goes back to ready work. */
  respond(id: string, project: string, response: string, options?: WriteOptions & AnswerOptions): Promise<void>;
  /** Pick one of a decision's options, with an optional note. */
  choose(
    id: string,
    project: string,
    option: TaskChoiceKey,
    note?: string,
    options?: WriteOptions & AnswerOptions,
  ): Promise<void>;
  /** Decline a task waiting on a person. It closes as Won't do unless another resolution is named. */
  dismiss(
    id: string,
    project: string,
    reason?: string,
    options?: CloseOptions & WriteOptions & AnswerOptions,
  ): Promise<void>;
  /** Close a task as done on the person's own call: `met` names the criteria of its Done when that are met,
   * by place from 1, and the rest are recorded as waived. It needs the proposal version the page showed. */
  accept(
    id: string,
    project: string,
    met: readonly number[],
    options?: { reason?: string } & WriteOptions & AnswerOptions,
  ): Promise<void>;
  /** Reopen an approval, or a task accepted as done, whose answer an agent recorded and the person disputes. */
  dispute(id: string, project: string): Promise<void>;
  /** Approve the action an approval names. */
  resolveGate(id: string, project: string, reason?: string, options?: WriteOptions & AnswerOptions): Promise<void>;
  /** Tick, untick, note or mark as stuck one step of a request to do steps. */
  markStep(id: string, project: string, marking: StepMarking, options?: WriteOptions & AnswerOptions): Promise<void>;
  /** Only the workspace's owners may create a project. */
  createProject(input: NewProject, options?: WriteOptions): Promise<void>;
  /** Says whether a project's changes go live by a deploy: an owner's setting. */
  setDeploys(project: string, deploys: boolean): Promise<void>;
  /** The workspace's members and pending invitations; only its owners may read them. */
  members(signal?: AbortSignal): Promise<WorkspaceMembers>;
  /** Invite a GitHub account: it joins the workspace when it first signs in. */
  invite(input: NewInvitation, options?: WriteOptions): Promise<void>;
  revokeInvitation(invitationId: string, options?: WriteOptions): Promise<void>;
  removeMember(userId: string, options?: WriteOptions): Promise<void>;
  /** The workspace's connected apps, each with whether the person signed in to it. */
  apps(signal?: AbortSignal): Promise<ConnectedApp[]>;
  /** Register an app that acts as whoever signs in to it; only the workspace's owners may. */
  registerApp(input: NewApp, options?: WriteOptions): Promise<ConnectedApp>;
  /** End the person's own sign-in to an app: its tokens stop working at once. */
  revokeApp(clientId: string): Promise<void>;
  /** Remove an app for everyone; only the workspace's owners may. */
  removeApp(clientId: string): Promise<void>;
  /** The workspace's GitHub webhook, without its secret; only its owners may read it. */
  githubWebhook(signal?: AbortSignal): Promise<GitHubWebhook>;
  /** Save the webhook's secret, its deploy checks or both; only the workspace's owners may. */
  saveGitHubWebhook(settings: GitHubWebhookSettings): Promise<GitHubWebhook>;
  /** Remove the webhook, after which GitHub's deliveries are refused; only the workspace's owners may. */
  removeGitHubWebhook(): Promise<void>;
}

/** The calls made in one workspace. */
type WorkspaceCalls = Omit<
  TasksApi,
  'selectWorkspace' | 'workspaces' | 'account' | 'createWorkspace' | 'renameWorkspace'
>;

/** Where the owner signs in: the Worker's own page, outside this app. */
export const SIGN_IN_PATH = '/sign-in';

/** Whether a refusal means nobody is signed in, so the next step is signing in. */
export function needsSignIn(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/**
 * Whether a failed read is worth trying again: a lost connection or a server
 * error may pass, but a refusal (sign in, not found, a bad request) answers
 * the same way every time, and retrying only delays saying so.
 */
export function retryRead(failures: number, error: unknown): boolean {
  if (error instanceof UnreadableAnswer) return false;
  return failures < 3 && !(error instanceof ApiError && error.status < 500);
}

/** An answer whose shape this app does not know. The server sends the same one again, so it is not retried. */
export class UnreadableAnswer extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableAnswer';
  }
}

/** A refused request, with the server's own sentence when it sent one. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** The body field the refusal is about, when the server named one. */
  readonly field: string | null;
  constructor(message: string, status: number, code: string | null, field: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/**
 * Which of a form's fields a refusal is about, so its words show under that
 * field: the field the server named, else the one its sentence starts with,
 * as in "prefix must be lowercase letters and digits". Null when it names
 * none of them, or the request failed for another reason.
 */
export function refusedField<Name extends string>(error: unknown, fields: readonly Name[]): Name | null {
  if (!(error instanceof ApiError) || error.status >= 500) return null;
  const named = (error.field ?? /^\s*([A-Za-z]+)/u.exec(error.message)?.[1] ?? '').toLowerCase();
  return fields.find((field) => field.toLowerCase() === named) ?? null;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const JSON_READ = { accept: 'application/json' } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The words a refusal is shown with: the server's `detail` when it wrote one. */
async function refusal(response: Response, what: string): Promise<ApiError> {
  let code: string | null = null;
  let detail: string | null = null;
  let field: string | null = null;
  try {
    const body: unknown = await response.json();
    if (isRecord(body)) {
      code = typeof body.error === 'string' ? body.error : null;
      detail = typeof body.detail === 'string' && body.detail.trim() !== '' ? body.detail : null;
      field = typeof body.field === 'string' ? body.field : null;
    }
  } catch {
    // A body that is not JSON carries no sentence of its own.
  }
  const sentence =
    detail ??
    (response.status === 401
      ? 'Sign in to see your tasks.'
      : response.status === 404
        ? `${what}: not found.`
        : response.status === 401 || response.status === 403
          ? `${what}: this sign-in may not do that.`
          : `${what}: the server answered ${response.status}.`);
  return new ApiError(sentence, response.status, code, field);
}

/** A successful answer's body. A body that is not JSON is an `UnreadableAnswer`, which is not retried. */
async function answerJson(response: Response, unreadable: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new UnreadableAnswer(unreadable);
    throw error;
  }
}

function readProjects(payload: unknown): readonly TaskProject[] {
  if (!isRecord(payload) || !Array.isArray(payload.projects))
    throw new UnreadableAnswer('The project list could not be read.');
  return Object.freeze(
    payload.projects.map((row: unknown) => {
      if (
        !isRecord(row) ||
        typeof row.projectId !== 'string' ||
        typeof row.logicalKey !== 'string' ||
        typeof row.displayName !== 'string' ||
        typeof row.prefix !== 'string'
      ) {
        throw new UnreadableAnswer('The project list could not be read.');
      }
      return Object.freeze({
        projectId: row.projectId,
        logicalKey: row.logicalKey,
        displayName: row.displayName,
        prefix: row.prefix,
        ...(typeof row.deploys === 'boolean' ? { deploys: row.deploys } : {}),
      });
    }),
  );
}

function readFields(payload: unknown, project: string): ProjectFields {
  const unreadable = () => new UnreadableAnswer(`The fields of ${project} could not be read.`);
  if (!isRecord(payload) || !Array.isArray(payload.fields)) throw unreadable();
  const fields = payload.fields.map((row: unknown): TaskField => {
    if (
      !isRecord(row) ||
      typeof row.key !== 'string' ||
      typeof row.name !== 'string' ||
      typeof row.type !== 'string' ||
      !(row.options === null || (Array.isArray(row.options) && row.options.every((o) => typeof o === 'string'))) ||
      !(row.retiredAt === null || typeof row.retiredAt === 'string')
    ) {
      throw unreadable();
    }
    return {
      key: row.key,
      name: row.name,
      type: row.type,
      options: row.options === null ? null : [...(row.options as string[])],
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
      retiredAt: row.retiredAt,
    };
  });
  return { project, fields };
}

function readCapabilities(payload: unknown): TasksCapabilities {
  const record = isRecord(payload) ? payload : {};
  const strings = (value: unknown) =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? (value as string[]) : undefined;
  const operations = strings(record.operations);
  const editableFields = strings(record.editableFields);
  return {
    live: record.live === true,
    ...(typeof record.writable === 'boolean' ? { writable: record.writable } : {}),
    ...(typeof record.projectSelection === 'boolean' ? { projectSelection: record.projectSelection } : {}),
    ...(operations ? { operations } : {}),
    ...(editableFields ? { editableFields } : {}),
    reason: typeof record.reason === 'string' ? record.reason : null,
  };
}

/** A role this build does not know grants nothing more than a member's. */
function readRole(value: unknown): WorkspaceRole {
  return value === 'owner' ? 'owner' : 'member';
}

function readWorkspace(row: unknown, unreadable: string): Workspace {
  if (!isRecord(row) || typeof row.workspaceId !== 'string' || typeof row.name !== 'string')
    throw new UnreadableAnswer(unreadable);
  return { workspaceId: row.workspaceId, name: row.name, role: readRole(row.role) };
}

function readWorkspaces(payload: unknown): readonly Workspace[] {
  const unreadable = 'The workspace list could not be read.';
  if (!isRecord(payload) || !Array.isArray(payload.workspaces)) throw new UnreadableAnswer(unreadable);
  return Object.freeze(payload.workspaces.map((row: unknown) => Object.freeze(readWorkspace(row, unreadable))));
}

function readAccount(payload: unknown): Account {
  if (!isRecord(payload)) throw new UnreadableAnswer('The sign-in could not be read.');
  return {
    name: typeof payload.name === 'string' ? payload.name : '',
    deploymentAdmin: payload.deploymentAdmin === true,
  };
}

function readMembers(payload: unknown): WorkspaceMembers {
  const unreadable = () => new UnreadableAnswer('The member list could not be read.');
  if (!isRecord(payload) || !Array.isArray(payload.members) || !Array.isArray(payload.invitations)) throw unreadable();
  return {
    members: payload.members.map((row: unknown) => {
      if (!isRecord(row) || typeof row.userId !== 'string' || typeof row.name !== 'string') throw unreadable();
      return {
        userId: row.userId,
        name: row.name,
        githubLogin: typeof row.githubLogin === 'string' ? row.githubLogin : null,
        role: readRole(row.role),
      };
    }),
    invitations: payload.invitations.map((row: unknown) => {
      if (!isRecord(row) || typeof row.invitationId !== 'string' || typeof row.githubLogin !== 'string')
        throw unreadable();
      return {
        invitationId: row.invitationId,
        githubLogin: row.githubLogin,
        role: readRole(row.role),
        createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
      };
    }),
  };
}

function readApp(row: unknown, unreadable: string): ConnectedApp {
  if (!isRecord(row) || typeof row.clientId !== 'string' || typeof row.name !== 'string')
    throw new UnreadableAnswer(unreadable);
  return {
    clientId: row.clientId,
    name: row.name,
    redirectUris: Array.isArray(row.redirectUris)
      ? row.redirectUris.filter((uri): uri is string => typeof uri === 'string')
      : [],
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
    connectedAt: typeof row.connectedAt === 'string' ? row.connectedAt : null,
  };
}

/** The webhook in an answer of `GET` or `POST /api/access/github`; `unreadable` says what failed when it is not there. */
function readGitHubWebhook(payload: unknown, unreadable: string): GitHubWebhook {
  const row = isRecord(payload) ? payload.github : null;
  if (!isRecord(row) || typeof row.url !== 'string' || typeof row.secretSaved !== 'boolean')
    throw new UnreadableAnswer(unreadable);
  return {
    url: row.url,
    secretSaved: row.secretSaved,
    deployChecks: Array.isArray(row.deployChecks)
      ? row.deployChecks.filter((name): name is string => typeof name === 'string')
      : [],
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
  };
}

function readApps(payload: unknown): ConnectedApp[] {
  const unreadable = 'The app list could not be read.';
  if (!isRecord(payload) || !Array.isArray(payload.apps)) throw new UnreadableAnswer(unreadable);
  return payload.apps.map((row: unknown) => readApp(row, unreadable));
}

/** Waits for `promise`, or stops waiting when `signal` aborts. The promise
 * itself runs on, so a cancelled caller never fails its other waiters. */
function until<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason as Error);
    signal.addEventListener('abort', stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(error as Error);
      },
    );
  });
}

/** `fetch`, with every request naming `workspace`. */
function inWorkspace(fetch: Fetch, workspace: string | null): Fetch {
  if (workspace === null) return fetch;
  return (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set(WORKSPACE_HEADER, workspace);
    return fetch(input, { ...init, headers });
  };
}

async function readJson<T>(fetch: Fetch, path: string, what: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { headers: JSON_READ, ...(signal ? { signal } : {}) });
  if (!response.ok) throw await refusal(response, what);
  return (await answerJson(response, `${what}: the answer could not be read.`)) as T;
}

/** Every write carries a retry key: the caller's, for a second attempt at
 * one submission, else a new one. */
async function writeJson(
  fetch: Fetch,
  method: 'POST' | 'PATCH',
  path: string,
  body: Record<string, unknown>,
  what: string,
  { keepalive = false, idempotencyKey }: WriteOptions = {},
): Promise<Response> {
  const response = await fetch(path, {
    method,
    headers: {
      ...JSON_READ,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey ?? crypto.randomUUID(),
    },
    body: JSON.stringify(body),
    ...(keepalive ? { keepalive: true } : {}),
  });
  if (!response.ok) throw await refusal(response, what);
  return response;
}

/** The Tasks API over HTTP, on the page's own origin. */
export function createHttpTasksApi(fetch: Fetch): TasksApi {
  let selected: string | null = null;
  /** Each workspace's calls, made once, so each keeps its own project list. */
  const scopes = new Map<string | null, WorkspaceCalls>();

  /** The calls in the workspace selected now. */
  function scope(): WorkspaceCalls {
    let calls = scopes.get(selected);
    if (calls === undefined) {
      calls = workspaceCalls(inWorkspace(fetch, selected));
      scopes.set(selected, calls);
    }
    return calls;
  }

  return {
    selectWorkspace(workspaceId) {
      selected = workspaceId;
    },
    async workspaces(signal) {
      return readWorkspaces(await readJson<unknown>(fetch, '/api/workspaces', 'The workspace list', signal));
    },
    async account(signal) {
      return readAccount(await readJson<unknown>(fetch, '/api/access/me', 'The sign-in', signal));
    },
    async createWorkspace(name, options) {
      const response = await writeJson(fetch, 'POST', '/api/workspaces', { name }, 'The new workspace', options);
      const unreadable = 'The workspace was created, but the answer could not be read.';
      const created = await answerJson(response, unreadable);
      return readWorkspace(isRecord(created) ? created.workspace : null, unreadable);
    },
    async renameWorkspace(workspaceId, name, options) {
      const body = { workspaceId, name };
      const response = await writeJson(fetch, 'PATCH', '/api/workspaces', body, 'The new name', options);
      const unreadable = 'The workspace was renamed, but the answer could not be read.';
      const renamed = await answerJson(response, unreadable);
      return readWorkspace(isRecord(renamed) ? renamed.workspace : null, unreadable);
    },
    capabilities: (signal) => scope().capabilities(signal),
    projects: (signal) => scope().projects(signal),
    board: (project, signal, fields) => scope().board(project, signal, fields),
    delivery: (project, signal) => scope().delivery(project, signal),
    task: (id, project, signal) => scope().task(id, project, signal),
    search: (text, signal) => scope().search(text, signal),
    fields: (project, signal) => scope().fields(project, signal),
    changes: (after, signal) => scope().changes(after, signal),
    wins: (options, signal) => scope().wins(options, signal),
    createTask: (input, options) => scope().createTask(input, options),
    updateTask: (id, project, edit, options) => scope().updateTask(id, project, edit, options),
    closeTask: (id, project, reason, options) => scope().closeTask(id, project, reason, options),
    comment: (id, project, text, options) => scope().comment(id, project, text, options),
    respond: (id, project, response, options) => scope().respond(id, project, response, options),
    choose: (id, project, option, note, options) => scope().choose(id, project, option, note, options),
    dismiss: (id, project, reason, options) => scope().dismiss(id, project, reason, options),
    accept: (id, project, met, options) => scope().accept(id, project, met, options),
    dispute: (id, project) => scope().dispute(id, project),
    resolveGate: (id, project, reason, options) => scope().resolveGate(id, project, reason, options),
    markStep: (id, project, marking, options) => scope().markStep(id, project, marking, options),
    createProject: (input, options) => scope().createProject(input, options),
    setDeploys: (project, deploys) => scope().setDeploys(project, deploys),
    members: (signal) => scope().members(signal),
    invite: (input, options) => scope().invite(input, options),
    revokeInvitation: (invitationId, options) => scope().revokeInvitation(invitationId, options),
    removeMember: (userId, options) => scope().removeMember(userId, options),
    apps: (signal) => scope().apps(signal),
    registerApp: (input, options) => scope().registerApp(input, options),
    revokeApp: (clientId) => scope().revokeApp(clientId),
    removeApp: (clientId) => scope().removeApp(clientId),
    githubWebhook: (signal) => scope().githubWebhook(signal),
    saveGitHubWebhook: (settings) => scope().saveGitHubWebhook(settings),
    removeGitHubWebhook: () => scope().removeGitHubWebhook(),
  };
}

/** The calls in one workspace, each request made through `fetch`, which names it. */
function workspaceCalls(fetch: Fetch): WorkspaceCalls {
  /** The last project list read, which every request names its project's id
   * from. Several requests share it, so it is read without any one caller's
   * signal. */
  let catalog: Promise<readonly TaskProject[]> | undefined;

  /** Reads the list again, so a project added since appears. */
  function readCatalog(): Promise<readonly TaskProject[]> {
    const read = (async () => {
      const response = await fetch('/api/tasks/projects', { headers: JSON_READ });
      if (!response.ok) throw await refusal(response, 'The project list');
      return readProjects(await answerJson(response, 'The project list could not be read.'));
    })();
    catalog = read;
    // A failed read is not kept: the next request asks again.
    read.catch(() => {
      if (catalog === read) catalog = undefined;
    });
    return read;
  }

  async function projectId(project: string, signal?: AbortSignal): Promise<string> {
    let found = (await until(catalog ?? readCatalog(), signal)).find((row) => row.logicalKey === project);
    // A key the last list did not hold may name a project added since.
    found ??= (await until(readCatalog(), signal)).find((row) => row.logicalKey === project);
    if (!found) throw new ApiError(`No project named ${project}.`, 404, 'unknown_project');
    return found.projectId;
  }

  const read = <T>(path: string, what: string, signal?: AbortSignal) => readJson<T>(fetch, path, what, signal);
  const write = (
    method: 'POST' | 'PATCH',
    path: string,
    body: Record<string, unknown>,
    what: string,
    options?: WriteOptions,
  ) => writeJson(fetch, method, path, body, what, options);

  const taskPath = (id: string, action?: string) =>
    `/api/tasks/${encodeURIComponent(id)}${action === undefined ? '' : `/${action}`}`;

  async function act(
    id: string,
    project: string,
    action: string,
    payload: Record<string, unknown>,
    options?: WriteOptions,
  ): Promise<void> {
    await write(
      'POST',
      taskPath(id, action),
      { ...payload, projectId: await projectId(project) },
      `Task ${id}`,
      options,
    );
  }

  /** The body field naming the proposal version an answer's page showed, when it names one. */
  function shownIn({ proposalVersion }: AnswerOptions) {
    return typeof proposalVersion === 'string' ? { proposalVersion } : {};
  }

  function ended(resolution: TaskResolution | undefined, unmarked: TaskResolution, duplicateOf: string | undefined) {
    return {
      ...(resolution === undefined || resolution === unmarked ? {} : { resolution }),
      ...(duplicateOf === undefined ? {} : { duplicateOf }),
    };
  }

  return {
    async capabilities(signal) {
      return readCapabilities(await read<unknown>('/api/tasks/capabilities', 'What this sign-in may do', signal));
    },
    projects: (signal) => until(readCatalog(), signal),
    async board(project, signal, fields = {}) {
      const params = new URLSearchParams({ project: await projectId(project, signal) });
      for (const [key, value] of Object.entries(fields)) params.append(`field.${key}`, value);
      return read<LiveTasksPayload>(`/api/tasks?${params}`, 'The task list', signal);
    },
    async delivery(project, signal) {
      const params = new URLSearchParams({ project: await projectId(project, signal), stage: 'built,merged' });
      return read<LiveTasksPayload>(`/api/tasks?${params}`, 'The task list', signal);
    },
    async fields(project, signal) {
      const params = new URLSearchParams({ project: await projectId(project, signal) });
      return readFields(await read<unknown>(`/api/fields?${params}`, `The fields of ${project}`, signal), project);
    },
    async changes(after, signal) {
      const page = await read<unknown>(
        `/api/changes?${new URLSearchParams({ after: String(after) })}`,
        'The change list',
        signal,
      );
      if (!isRecord(page) || !Array.isArray(page.events) || typeof page.lastSeq !== 'number') {
        throw new UnreadableAnswer('The change list could not be read.');
      }
      return page as unknown as ChangesPage;
    },
    async task(id, project, signal) {
      const params = new URLSearchParams({ project: await projectId(project, signal) });
      return read<LiveTaskDetail>(`${taskPath(id)}?${params}`, `Task ${id}`, signal);
    },
    async wins({ project, before }, signal) {
      const params = new URLSearchParams();
      if (project !== undefined) params.set('project', await projectId(project, signal));
      if (before !== undefined) params.set('before', before);
      const query = params.size > 0 ? `?${params}` : '';
      const page = await read<unknown>(`/api/tasks/wins${query}`, 'The wins', signal);
      if (!isRecord(page) || !Array.isArray(page.wins) || !Array.isArray(page.days) || !isRecord(page.totals)) {
        throw new UnreadableAnswer('The wins could not be read.');
      }
      return page as unknown as WinsPage;
    },
    async search(text, signal) {
      const found = await read<unknown>(`/api/tasks/search?${new URLSearchParams({ q: text })}`, 'The search', signal);
      if (!isRecord(found) || !Array.isArray(found.tasks) || typeof found.total !== 'number') {
        throw new UnreadableAnswer('The search could not be read.');
      }
      return found as unknown as TaskSearch;
    },
    async createTask({ project, ...input }, options) {
      const response = await write(
        'POST',
        '/api/tasks',
        { ...input, projectId: await projectId(project) },
        'The new task',
        options,
      );
      const unreadable = 'The new task was filed, but its id could not be read.';
      const created = await answerJson(response, unreadable);
      if (!isRecord(created) || typeof created.id !== 'string') throw new UnreadableAnswer(unreadable);
      return { id: created.id, project };
    },
    async updateTask(id, project, edit, options) {
      await write('PATCH', taskPath(id), { ...edit, projectId: await projectId(project) }, `Task ${id}`, options);
    },
    async closeTask(id, project, reason, { resolution, duplicateOf, ...sending } = {}) {
      await act(id, project, 'close', { reason, ...ended(resolution, 'done', duplicateOf) }, sending);
    },
    async comment(id, project, text, options) {
      await act(id, project, 'comments', { text }, options);
    },
    async respond(id, project, response, sending = {}) {
      await act(id, project, 'respond', { response, ...shownIn(sending) }, sending);
    },
    async choose(id, project, option, note, sending = {}) {
      await act(
        id,
        project,
        'choose',
        { option, ...(note === undefined || note.trim() === '' ? {} : { note }), ...shownIn(sending) },
        sending,
      );
    },
    async dismiss(id, project, reason, { resolution, duplicateOf, ...sending } = {}) {
      await act(
        id,
        project,
        'dismiss',
        {
          ...(reason === undefined ? {} : { reason }),
          ...ended(resolution, 'wont-do', duplicateOf),
          ...shownIn(sending),
        },
        sending,
      );
    },
    async accept(id, project, met, { reason, ...sending } = {}) {
      await act(
        id,
        project,
        'accept',
        { met, ...(reason === undefined ? {} : { reason }), ...shownIn(sending) },
        sending,
      );
    },
    async dispute(id, project) {
      await act(id, project, 'dispute', {});
    },
    async resolveGate(id, project, reason, sending = {}) {
      const path = `/api/gates/${encodeURIComponent(id)}/resolve`;
      await write(
        'POST',
        path,
        { ...(reason === undefined ? {} : { reason }), ...shownIn(sending), projectId: await projectId(project) },
        `Approval ${id}`,
        sending,
      );
    },
    async markStep(id, project, marking, sending = {}) {
      const path = `/api/gates/${encodeURIComponent(id)}/steps`;
      await write(
        'POST',
        path,
        { ...marking, ...shownIn(sending), projectId: await projectId(project) },
        `Step ${marking.step} of ${id}`,
        sending,
      );
    },
    async createProject({ name, prefix }, options) {
      await write('POST', '/api/tasks/projects', { name, prefix }, 'The new project', options);
    },
    async setDeploys(project, deploys) {
      await write('PATCH', '/api/tasks/projects', { projectId: await projectId(project), deploys }, project);
    },
    async members(signal) {
      return readMembers(await read<unknown>('/api/access/members', 'The member list', signal));
    },
    async invite({ githubLogin, role }, options) {
      await write('POST', '/api/access/invitations', { githubLogin, role }, 'The invitation', options);
    },
    async revokeInvitation(invitationId, options) {
      const path = `/api/access/invitations/${encodeURIComponent(invitationId)}/revoke`;
      await write('POST', path, {}, 'The invitation', options);
    },
    async removeMember(userId, options) {
      const path = `/api/access/members/${encodeURIComponent(userId)}/remove`;
      await write('POST', path, {}, 'The member', options);
    },
    async apps(signal) {
      return readApps(await read<unknown>('/api/access/apps', 'The app list', signal));
    },
    async registerApp({ name, redirectUris }, options) {
      const response = await write('POST', '/api/access/apps', { name, redirectUris }, 'The app', options);
      const unreadable = 'The app was registered, but the answer could not be read.';
      const answer = await answerJson(response, unreadable);
      return readApp(isRecord(answer) ? answer.app : null, unreadable);
    },
    async revokeApp(clientId) {
      await write('POST', `/api/access/apps/${encodeURIComponent(clientId)}/revoke`, {}, 'The app');
    },
    async removeApp(clientId) {
      await write('POST', `/api/access/apps/${encodeURIComponent(clientId)}/remove`, {}, 'The app');
    },
    async githubWebhook(signal) {
      const answer = await read<unknown>('/api/access/github', 'The GitHub webhook', signal);
      return readGitHubWebhook(answer, 'The GitHub webhook could not be read.');
    },
    async saveGitHubWebhook(settings) {
      const response = await write('POST', '/api/access/github', { ...settings }, 'The GitHub webhook');
      const unreadable = 'The GitHub webhook was saved, but the answer could not be read.';
      return readGitHubWebhook(await answerJson(response, unreadable), unreadable);
    },
    async removeGitHubWebhook() {
      await write('POST', '/api/access/github/remove', {}, 'The GitHub webhook');
    },
  };
}
