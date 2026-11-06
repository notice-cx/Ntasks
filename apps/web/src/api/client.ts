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
 */
import type { TaskResolution } from '@ntasks/domain';
import type {
  ChangesPage,
  CloseOptions,
  LiveTaskDetail,
  LiveTasksPayload,
  NewTask,
  TaskChoiceKey,
  TaskCreated,
  TaskEdit,
  TaskProject,
  TasksCapabilities,
} from './types';

export interface WriteOptions {
  /** Send the write while the page is leaving. */
  keepalive?: boolean;
  /** The retry key. A second attempt at the same submission passes the key
   * the first attempt used, so the server applies it once even when the first
   * attempt's answer was lost; without one, the write gets a new key. */
  idempotencyKey?: string;
}

export interface TasksApi {
  capabilities(signal?: AbortSignal): Promise<TasksCapabilities>;
  projects(signal?: AbortSignal): Promise<readonly TaskProject[]>;
  /** One project's board: unfinished tasks and the last week's closes. */
  board(project: string, signal?: AbortSignal): Promise<LiveTasksPayload>;
  task(id: string, project: string, signal?: AbortSignal): Promise<LiveTaskDetail>;
  /** Every change after sequence number `after`, in every project this sign-in reaches, oldest first. */
  changes(after: number, signal?: AbortSignal): Promise<ChangesPage>;
  createTask(input: NewTask, options?: WriteOptions): Promise<TaskCreated>;
  updateTask(id: string, project: string, edit: TaskEdit, options?: WriteOptions): Promise<void>;
  /** A close needs its reason: the evidence, or why nothing shipped. No resolution means done. */
  closeTask(id: string, project: string, reason: string, options?: CloseOptions & WriteOptions): Promise<void>;
  comment(id: string, project: string, text: string, options?: WriteOptions): Promise<void>;
  /** Answer a task waiting on a person: a decision closes with the answer, any other task goes back to ready work. */
  respond(id: string, project: string, response: string, options?: WriteOptions): Promise<void>;
  /** Pick one of a decision's options, with an optional note. */
  choose(id: string, project: string, option: TaskChoiceKey, note?: string, options?: WriteOptions): Promise<void>;
  /** Decline a task waiting on a person. It closes as Won't do unless another resolution is named. */
  dismiss(id: string, project: string, reason?: string, options?: CloseOptions & WriteOptions): Promise<void>;
  /** Reopen an approval whose recorded answer the person disputes. */
  dispute(id: string, project: string): Promise<void>;
  /** Approve the action an approval names. */
  resolveGate(id: string, project: string, reason?: string, options?: WriteOptions): Promise<void>;
}

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
  return failures < 3 && !(error instanceof ApiError && error.status < 500);
}

/** A refused request, with the server's own sentence when it sent one. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
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
  try {
    const body: unknown = await response.json();
    if (isRecord(body)) {
      code = typeof body.error === 'string' ? body.error : null;
      detail = typeof body.detail === 'string' && body.detail.trim() !== '' ? body.detail : null;
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
  return new ApiError(sentence, response.status, code);
}

function readProjects(payload: unknown): readonly TaskProject[] {
  if (!isRecord(payload) || !Array.isArray(payload.projects)) throw new Error('The project list could not be read.');
  return Object.freeze(
    payload.projects.map((row: unknown) => {
      if (
        !isRecord(row) ||
        typeof row.projectId !== 'string' ||
        typeof row.logicalKey !== 'string' ||
        typeof row.displayName !== 'string' ||
        typeof row.prefix !== 'string'
      ) {
        throw new Error('The project list could not be read.');
      }
      return Object.freeze({
        projectId: row.projectId,
        logicalKey: row.logicalKey,
        displayName: row.displayName,
        prefix: row.prefix,
      });
    }),
  );
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

/** The Tasks API over HTTP, on the page's own origin. */
export function createHttpTasksApi(fetch: Fetch): TasksApi {
  /** The last project list read, which every request names its project's id
   * from. Several requests share it, so it is read without any one caller's
   * signal. */
  let catalog: Promise<readonly TaskProject[]> | undefined;

  /** Reads the list again, so a project added since appears. */
  function readCatalog(): Promise<readonly TaskProject[]> {
    const read = (async () => {
      const response = await fetch('/api/tasks/projects', { headers: JSON_READ });
      if (!response.ok) throw await refusal(response, 'The project list');
      return readProjects(await response.json());
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

  async function read<T>(path: string, what: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(path, { headers: JSON_READ, ...(signal ? { signal } : {}) });
    if (!response.ok) throw await refusal(response, what);
    return (await response.json()) as T;
  }

  /** Every write carries a retry key: the caller's, for a second attempt at
   * one submission, else a new one. */
  async function write(
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
    async board(project, signal) {
      const params = new URLSearchParams({ project: await projectId(project, signal) });
      return read<LiveTasksPayload>(`/api/tasks?${params}`, 'The task list', signal);
    },
    async changes(after, signal) {
      const page = await read<unknown>(
        `/api/changes?${new URLSearchParams({ after: String(after) })}`,
        'The change list',
        signal,
      );
      if (!isRecord(page) || !Array.isArray(page.events) || typeof page.lastSeq !== 'number') {
        throw new Error('The change list could not be read.');
      }
      return page as unknown as ChangesPage;
    },
    async task(id, project, signal) {
      const params = new URLSearchParams({ project: await projectId(project, signal) });
      return read<LiveTaskDetail>(`${taskPath(id)}?${params}`, `Task ${id}`, signal);
    },
    async createTask({ project, ...input }, options) {
      const response = await write(
        'POST',
        '/api/tasks',
        { ...input, projectId: await projectId(project) },
        'The new task',
        options,
      );
      const created: unknown = await response.json();
      if (!isRecord(created) || typeof created.id !== 'string')
        throw new Error('The new task was filed, but its id could not be read.');
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
      await act(id, project, 'respond', { response }, sending);
    },
    async choose(id, project, option, note, sending = {}) {
      await act(
        id,
        project,
        'choose',
        { option, ...(note === undefined || note.trim() === '' ? {} : { note }) },
        sending,
      );
    },
    async dismiss(id, project, reason, { resolution, duplicateOf, ...sending } = {}) {
      await act(
        id,
        project,
        'dismiss',
        { ...(reason === undefined ? {} : { reason }), ...ended(resolution, 'wont-do', duplicateOf) },
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
        { ...(reason === undefined ? {} : { reason }), projectId: await projectId(project) },
        `Approval ${id}`,
        sending,
      );
    },
  };
}
