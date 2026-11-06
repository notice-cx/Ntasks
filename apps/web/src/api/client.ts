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

/** A write that may still be sent while the page is leaving. */
export interface WriteOptions {
  keepalive?: boolean;
}

export interface TasksApi {
  capabilities(signal?: AbortSignal): Promise<TasksCapabilities>;
  projects(signal?: AbortSignal): Promise<readonly TaskProject[]>;
  /** One project's board: unfinished tasks and the last week's closes. */
  board(project: string, signal?: AbortSignal): Promise<LiveTasksPayload>;
  task(id: string, project: string, signal?: AbortSignal): Promise<LiveTaskDetail>;
  createTask(input: NewTask): Promise<TaskCreated>;
  updateTask(id: string, project: string, edit: TaskEdit): Promise<void>;
  /** A close needs its reason: the evidence, or why nothing shipped. No resolution means done. */
  closeTask(id: string, project: string, reason: string, options?: CloseOptions & WriteOptions): Promise<void>;
  comment(id: string, project: string, text: string): Promise<void>;
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
    (response.status === 404
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

/** The Tasks API over HTTP, on the page's own origin. */
export function createHttpTasksApi(fetch: Fetch): TasksApi {
  /** The last project list read, which every request names its project's id from. */
  let catalog: Promise<readonly TaskProject[]> | undefined;

  /** Reads the list again, so a project added since appears. */
  function projects(signal?: AbortSignal): Promise<readonly TaskProject[]> {
    const read = (async () => {
      const response = await fetch('/api/tasks/projects', { headers: JSON_READ, ...(signal ? { signal } : {}) });
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
    let found = (await (catalog ?? projects(signal))).find((row) => row.logicalKey === project);
    // A key the last list did not hold may name a project added since.
    found ??= (await projects(signal)).find((row) => row.logicalKey === project);
    if (!found) throw new ApiError(`No project named ${project}.`, 404, 'unknown_project');
    return found.projectId;
  }

  async function read<T>(path: string, what: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(path, { headers: JSON_READ, ...(signal ? { signal } : {}) });
    if (!response.ok) throw await refusal(response, what);
    return (await response.json()) as T;
  }

  /** A write carries a fresh retry key, so the server applies it once even if
   * the request is sent again after a dropped answer. */
  async function write(
    method: 'POST' | 'PATCH',
    path: string,
    body: Record<string, unknown>,
    what: string,
    keepalive = false,
  ): Promise<Response> {
    const response = await fetch(path, {
      method,
      headers: { ...JSON_READ, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
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
    keepalive?: boolean,
  ): Promise<void> {
    await write(
      'POST',
      taskPath(id, action),
      { ...payload, projectId: await projectId(project) },
      `Task ${id}`,
      keepalive,
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
    projects,
    async board(project, signal) {
      const params = new URLSearchParams({ project: await projectId(project, signal) });
      return read<LiveTasksPayload>(`/api/tasks?${params}`, 'The task list', signal);
    },
    async task(id, project, signal) {
      const params = new URLSearchParams({ project: await projectId(project, signal) });
      return read<LiveTaskDetail>(`${taskPath(id)}?${params}`, `Task ${id}`, signal);
    },
    async createTask({ project, ...input }) {
      const response = await write(
        'POST',
        '/api/tasks',
        { ...input, projectId: await projectId(project) },
        'The new task',
      );
      const created: unknown = await response.json();
      if (!isRecord(created) || typeof created.id !== 'string')
        throw new Error('The new task was filed, but its id could not be read.');
      return { id: created.id, project };
    },
    async updateTask(id, project, edit) {
      await write('PATCH', taskPath(id), { ...edit, projectId: await projectId(project) }, `Task ${id}`);
    },
    async closeTask(id, project, reason, { resolution, duplicateOf, keepalive } = {}) {
      await act(id, project, 'close', { reason, ...ended(resolution, 'done', duplicateOf) }, keepalive);
    },
    async comment(id, project, text) {
      await act(id, project, 'comments', { text });
    },
    async respond(id, project, response, { keepalive } = {}) {
      await act(id, project, 'respond', { response }, keepalive);
    },
    async choose(id, project, option, note, { keepalive } = {}) {
      await act(
        id,
        project,
        'choose',
        { option, ...(note === undefined || note.trim() === '' ? {} : { note }) },
        keepalive,
      );
    },
    async dismiss(id, project, reason, { resolution, duplicateOf, keepalive } = {}) {
      await act(
        id,
        project,
        'dismiss',
        { ...(reason === undefined ? {} : { reason }), ...ended(resolution, 'wont-do', duplicateOf) },
        keepalive,
      );
    },
    async dispute(id, project) {
      await act(id, project, 'dispute', {});
    },
    async resolveGate(id, project, reason, { keepalive } = {}) {
      const path = `/api/gates/${encodeURIComponent(id)}/resolve`;
      await write(
        'POST',
        path,
        { ...(reason === undefined ? {} : { reason }), projectId: await projectId(project) },
        `Approval ${id}`,
        keepalive,
      );
    },
  };
}
