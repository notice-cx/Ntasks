/**
 * The operations over the HTTP binding (http-binding.md): each is one route
 * under the binding's path. The binding has no route that links two tasks,
 * asks for an approval, relays an answer, records work details on a comment,
 * claims by pull request or lists held tasks on connect, so those are not
 * offered; nor does a write name a model. A task's type may arrive as
 * `issueType`, the name the HTTP routes answer it under.
 */
import {
  NotOffered,
  type Api,
  type HistoryEvent,
  type Outcome,
  type Project,
  type RefusalKind,
  type Role,
  type Task,
  type TaskRead,
  type Written,
} from './api.ts';
import { addressOf, type Target } from './target.ts';
import { sendJson, type HttpAnswer, type Trace } from './transport.ts';

/** The project a task id belongs to, by the prefix that starts it. */
export type ProjectOf = (task: string) => string;

const KINDS: Readonly<Record<string, RefusalKind>> = {
  invalid_request: 'invalid',
  workspace_required: 'invalid',
  unauthorized: 'unauthorized',
  invalid_token: 'unauthorized',
  insufficient_scope: 'scope',
  forbidden: 'forbidden',
  not_found: 'not_found',
  task_refused: 'refused',
  idempotency_conflict: 'conflict',
  unavailable: 'unavailable',
};

const defined = (body: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));

/** A task as the routes answer it, with its type under the protocol's name. */
export function taskOf(value: Record<string, unknown>): Task {
  const { issueType, ...rest } = value;
  return { ...rest, type: (rest.type ?? issueType) as string } as Task;
}

export function httpApi(target: Target, role: Role, projectOf: ProjectOf, trace?: Trace): Api {
  const sender = target.senders[role];
  if (!sender) throw new Error(`the target names no ${role}`);
  const binding = target.bindings.http;
  if (!binding) throw new Error('the target offers no HTTP binding');
  const base = binding.path.replace(/\/$/u, '');
  const headers: Record<string, string> = {
    ...sender.headers,
    ...(target.workspace === undefined ? {} : { 'x-ntasks-workspace': target.workspace }),
  };
  const notOffered = (operation: string) => Promise.reject(new NotOffered('http', operation));

  const send = async (
    method: string,
    path: string,
    options: { body?: Record<string, unknown>; query?: Record<string, string>; key?: string; model?: string } = {},
  ): Promise<Outcome<Record<string, unknown>>> => {
    if (options.model !== undefined) throw new NotOffered('http', 'name the model a write is made by');
    const url = addressOf(target, `${base}${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
    const answer: HttpAnswer = await sendJson(url, {
      method,
      headers: { ...headers, ...(options.key === undefined ? {} : { 'idempotency-key': options.key }) },
      ...(options.body === undefined ? {} : { body: defined(options.body) }),
      ...(trace === undefined ? {} : { trace }),
    });
    const body = (answer.body ?? {}) as Record<string, unknown>;
    if (answer.status >= 200 && answer.status < 300) return { ok: true, value: body };
    const code = typeof body.error === 'string' ? body.error : undefined;
    return {
      ok: false,
      refusal: {
        kind: (code === undefined ? undefined : KINDS[code]) ?? 'other',
        text: JSON.stringify(answer.body),
        status: answer.status,
        ...(code === undefined ? {} : { code }),
        wellFormed: code !== undefined,
      },
    };
  };

  const map = async <T>(
    outcome: Promise<Outcome<Record<string, unknown>>>,
    read: (value: Record<string, unknown>) => T,
  ): Promise<Outcome<T>> => {
    const answered = await outcome;
    return answered.ok ? { ok: true, value: read(answered.value) } : answered;
  };

  const writtenTask = (value: Record<string, unknown>): Written => {
    const task = taskOf((value.task ?? {}) as Record<string, unknown>);
    return {
      id: task.id,
      version: typeof task.version === 'number' ? task.version : null,
      replayed: typeof value.replayed === 'boolean' ? value.replayed : null,
      status: task.status,
      assignee: task.assignee ?? null,
      raw: value,
    };
  };

  const projectId = (task: string) => projectOf(task);

  return {
    binding: 'http',
    role,
    projects: () =>
      map(send('GET', '/tasks/projects'), (value) =>
        (value.projects as Project[]).map((project) => ({
          projectId: project.projectId,
          prefix: project.prefix,
          deploys: project.deploys === true,
        })),
      ),
    create: (task, options = {}) => {
      if (task.choices !== undefined) return notOffered('file a task with choices');
      if (task.dependsOn !== undefined) return notOffered('file a task with links');
      if (task.claim !== undefined) return notOffered('file a task claimed');
      return map(
        send('POST', '/tasks', {
          body: {
            projectId: task.project ?? target.projects.main,
            title: task.title,
            description: task.description,
            acceptance: task.acceptance,
            type: task.type,
            labels: task.labels,
            parent: task.parent,
            metadata: task.metadata,
          },
          ...options,
        }),
        (value) => ({ id: String(value.id), version: null, replayed: null, raw: value }),
      );
    },
    read: (task) =>
      map(
        send('GET', `/tasks/${encodeURIComponent(task)}`, { query: { project: projectId(task) } }),
        (value): TaskRead => ({
          task: taskOf(value.task as Record<string, unknown>),
          comments: (value.comments ?? []) as TaskRead['comments'],
          proposalVersion: (value.proposalVersion ?? null) as string | null,
        }),
      ),
    history: (task) =>
      map(
        send('GET', `/tasks/${encodeURIComponent(task)}/history`, {
          query: { project: projectId(task), limit: '200' },
        }),
        (value) => value.changes as HistoryEvent[],
      ),
    ready: (project) =>
      map(send('GET', '/tasks', { query: { project: project ?? target.projects.main } }), (value) =>
        (value.tasks as { id: string; ready?: boolean }[]).filter((task) => task.ready === true).map((task) => task.id),
      ),
    stalled: (project) =>
      map(send('GET', '/tasks', { query: { project: project ?? target.projects.main } }), (value) =>
        (value.tasks as { id: string; stalled?: boolean }[])
          .filter((task) => task.stalled === true)
          .map((task) => task.id),
      ),
    claim: (task, options = {}) =>
      map(
        send('PATCH', `/tasks/${encodeURIComponent(task)}`, {
          body: { projectId: projectId(task), claim: true, for: options.for, work: options.work },
          ...(options.key === undefined ? {} : { key: options.key }),
          ...(options.model === undefined ? {} : { model: options.model }),
        }),
        writtenTask,
      ),
    claimByPullRequest: () => notOffered('claim a task by its pull request'),
    update: (task, change, options = {}) => {
      if (change.choices !== undefined) return notOffered("change a task's choices");
      return map(
        send('PATCH', `/tasks/${encodeURIComponent(task)}`, {
          body: {
            projectId: projectId(task),
            title: change.title,
            description: change.description,
            status: change.status,
            assignee: change.assignee,
            parent: change.parent,
            defer: change.defer,
            addLabels: change.addLabels,
            removeLabels: change.removeLabels,
          },
          ...options,
        }),
        writtenTask,
      );
    },
    comment: (task, text, options = {}) => {
      if (options.work !== undefined || options.for !== undefined)
        return notOffered('record work details on a comment');
      return map(
        send('POST', `/tasks/${encodeURIComponent(task)}/comments`, {
          body: { projectId: projectId(task), text },
          ...(options.key === undefined ? {} : { key: options.key }),
          ...(options.model === undefined ? {} : { model: options.model }),
        }),
        (value) => ({
          id: task,
          version: null,
          replayed: typeof value.replayed === 'boolean' ? value.replayed : null,
          raw: value,
        }),
      );
    },
    close: (task, close, options = {}) =>
      map(
        send('POST', `/tasks/${encodeURIComponent(task)}/close`, {
          body: {
            projectId: projectId(task),
            reason: close.reason,
            resolution: close.resolution,
            duplicateOf: close.duplicateOf,
            commit: close.commit,
            pullRequest: close.pr,
            link: close.link,
          },
          ...options,
        }),
        writtenTask,
      ),
    misnamed: (task) =>
      send('PATCH', `/tasks/${encodeURIComponent(task)}`, {
        body: { projectId: projectId(task), titel: 'A misspelt argument' },
      }),
    link: () => notOffered('link two tasks'),
    requestApproval: () => notOffered('ask for an approval'),
    requestSteps: () => notOffered('ask a person to do steps'),
    relay: () => notOffered('record a relayed answer'),
    decide: (task, decision, options = {}) => {
      const project = projectId(task);
      const id = encodeURIComponent(task);
      const [path, body]: [string, Record<string, unknown>] =
        decision.kind === 'choose'
          ? [
              `/tasks/${id}/choose`,
              { option: decision.option, note: decision.note, proposalVersion: decision.proposalVersion },
            ]
          : decision.kind === 'respond'
            ? [`/tasks/${id}/respond`, { response: decision.response, proposalVersion: decision.proposalVersion }]
            : decision.kind === 'dismiss'
              ? [`/tasks/${id}/dismiss`, { reason: decision.reason, resolution: decision.resolution }]
              : decision.kind === 'approve'
                ? [`/gates/${id}/resolve`, { reason: decision.reason, proposalVersion: decision.proposalVersion }]
                : decision.kind === 'accept'
                  ? [
                      `/tasks/${id}/accept`,
                      { met: decision.met, proposalVersion: decision.proposalVersion, reason: decision.reason },
                    ]
                  : decision.kind === 'step'
                    ? [
                        `/gates/${id}/steps`,
                        { step: decision.step, done: decision.done, note: decision.note, stuck: decision.stuck },
                      ]
                    : decision.kind === 'release'
                      ? [`/tasks/${id}/release`, { holder: decision.holder }]
                      : [`/tasks/${id}/dispute`, {}];
      return map(send('POST', path, { body: { projectId: project, ...body }, ...options }), (value) =>
        taskOf(value.task as Record<string, unknown>),
      );
    },
    signal: (signal) =>
      map(
        send('POST', '/delivery', {
          body: {
            repository: signal.repository,
            stage: signal.stage,
            pullRequests: signal.pullRequests,
            commits: signal.commits,
          },
        }),
        (value) => ({ moved: value.moved as { id: string; stage: string }[] }),
      ),
    connect: () => notOffered('tell a connecting agent the tasks it holds'),
  };
}
