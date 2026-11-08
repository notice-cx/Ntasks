/**
 * The pages' reads and writes, over the one `TasksApi`. Every write refreshes
 * the board and the task page it changed. Answers to decisions wait in the
 * Undo window (`lib/answer-queue.ts`) before they are sent.
 */
import { useMutation, useQueries, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAnswerQueue, useTasksApi } from '@/api/context';
import type { TasksApi } from '@/api/client';
import type {
  CloseOptions,
  FieldFilters,
  LiveTaskDetail,
  LiveTasksPayload,
  NewTask,
  ProjectFields,
  TaskChoiceKey,
  TaskEdit,
  TaskProject,
  TasksCapabilities,
} from '@/api/types';
import { UNDO_WINDOW_MS } from '@/lib/answer-queue';
import { choiceName, closeAsReason, RESOLUTION_LABELS, type NotDone } from '@/lib/task-model';
import { taskPath } from '@/lib/task-path';

/** Until the answer arrives, nothing is offered as writable: a button that
 * appears and then cannot work is a write the person believes happened. */
const UNANSWERED: TasksCapabilities = { live: false, writable: false, reason: null };

export function useCapabilities(): TasksCapabilities {
  const api = useTasksApi();
  const { data } = useQuery({
    queryKey: ['tasks-capabilities'],
    queryFn: ({ signal }) => api.capabilities(signal),
    staleTime: Infinity,
    retry: false,
  });
  return data ?? UNANSWERED;
}

export function writesAvailable(capabilities: TasksCapabilities): boolean {
  return capabilities.live && capabilities.writable !== false;
}

export const READ_ONLY = 'Read-only: tasks cannot be changed here.';

/**
 * Why a verb is unavailable, as the words written beside it: null when it is
 * available, `unavailable` when this sign-in may not use it, and the empty
 * string while the answer has not arrived, which disables the verb without
 * claiming a reason it does not know yet.
 */
export function verbReason(capabilities: TasksCapabilities, available: boolean, unavailable: string): string | null {
  if (!capabilities.live) return '';
  if (capabilities.writable === false) return READ_ONLY;
  return available ? null : unavailable;
}

export function operationAvailable(capabilities: TasksCapabilities, operation: string): boolean {
  return (
    writesAvailable(capabilities) &&
    (capabilities.operations === undefined || capabilities.operations.includes(operation))
  );
}

export function fieldAvailable(capabilities: TasksCapabilities, field: string): boolean {
  return (
    operationAvailable(capabilities, 'update') &&
    (capabilities.editableFields === undefined || capabilities.editableFields.includes(field))
  );
}

export function useTaskProjects() {
  const api = useTasksApi();
  return useQuery<readonly TaskProject[]>({
    queryKey: ['task-projects'],
    queryFn: ({ signal }) => api.projects(signal),
    staleTime: 60_000,
  });
}

/**
 * Every named project's board, in the order given. A board is the API's most
 * expensive read (about two database rows per task), so it is read when a
 * page opens, after a write, and when the change feed names a change in its
 * project; never on a timer, and never just because the window regained
 * focus. The app's frame reads every board once and runs the one change feed
 * (`BoardsProvider`); a page that asks for a board here shares that read.
 */
export function useBoards(projects: readonly string[]): UseQueryResult<LiveTasksPayload, Error>[] {
  const api = useTasksApi();
  return useQueries({
    queries: projects.map((project) => ({
      queryKey: ['tasks', project],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.board(project, signal),
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    })),
  });
}

/**
 * Each named project's closed tasks whose change is built or merged, read
 * while `enabled`. They share the board's key as their prefix, so whatever
 * reads a project's board again reads these again too.
 */
export function useDeliveryBoards(
  projects: readonly string[],
  enabled: boolean,
): UseQueryResult<LiveTasksPayload, Error>[] {
  const api = useTasksApi();
  return useQueries({
    queries: projects.map((project) => ({
      queryKey: ['tasks', project, 'delivery'],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.delivery(project, signal),
      enabled,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    })),
  });
}

/**
 * One project's board with only the tasks holding each value of `fields`,
 * which the server filters. It shares the board's key as its prefix, so
 * whatever reads a project's board again reads this again too.
 */
export function useFilteredBoard(project: string | null, fields: FieldFilters) {
  const api = useTasksApi();
  return useQuery<LiveTasksPayload>({
    queryKey: ['tasks', project, { fields }],
    queryFn: ({ signal }) => api.board(project as string, signal, fields),
    enabled: project !== null && Object.keys(fields).length > 0,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}

/** A project's custom fields, retired ones included. Fields are defined rarely, so a read lasts a minute. */
export function useProjectFields(project: string | null) {
  const api = useTasksApi();
  return useQuery<ProjectFields>({
    queryKey: ['fields', project],
    queryFn: ({ signal }) => api.fields(project as string, signal),
    enabled: project !== null,
    staleTime: 60_000,
  });
}

export function useTask(id: string, project: string | null) {
  const api = useTasksApi();
  return useQuery<LiveTaskDetail>({
    queryKey: ['task', project, id],
    queryFn: ({ signal }) => api.task(id, project as string, signal),
    enabled: project !== null && id !== '',
    staleTime: 15_000,
  });
}

/**
 * What every write refreshes: the boards and the task pages. A read already on
 * its way started before the write and may answer with what the server held
 * before it, so it is cancelled first and every refresh is a new read.
 */
export function useTaskRefresh(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(async () => {
    const keys = [['tasks'], ['task']];
    await Promise.all(keys.map((queryKey) => client.cancelQueries({ queryKey })));
    await Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
  }, [client]);
}

/**
 * A retry key per submission. Pressing again with the same content after a
 * failure reuses the key, so a write the server applied but whose answer was
 * lost is not applied twice; changed content is a new submission with a new
 * key, and `done` forgets the key once the write succeeds.
 */
export function useRetryKey(): { keyFor: (content: string) => string; done: () => void } {
  const last = useRef<{ content: string; key: string } | null>(null);
  return useMemo(
    () => ({
      keyFor: (content: string) => {
        if (last.current?.content !== content) last.current = { content, key: crypto.randomUUID() };
        return last.current.key;
      },
      done: () => {
        last.current = null;
      },
    }),
    [],
  );
}

export function useCreateTask() {
  const api = useTasksApi();
  const refresh = useTaskRefresh();
  return useMutation({
    mutationFn: ({ input, idempotencyKey }: { input: NewTask; idempotencyKey?: string }) =>
      api.createTask(input, idempotencyKey === undefined ? undefined : { idempotencyKey }),
    onSuccess: () => refresh(),
  });
}

export function useUpdateTask() {
  const api = useTasksApi();
  const refresh = useTaskRefresh();
  return useMutation({
    mutationFn: ({
      id,
      project,
      edit,
      idempotencyKey,
    }: {
      id: string;
      project: string;
      edit: TaskEdit;
      idempotencyKey?: string;
    }) => api.updateTask(id, project, edit, idempotencyKey === undefined ? undefined : { idempotencyKey }),
    onSuccess: () => refresh(),
  });
}

export function useClaimTask() {
  const api = useTasksApi();
  const refresh = useTaskRefresh();
  return useMutation({
    mutationFn: ({ id, project }: { id: string; project: string }) => api.updateTask(id, project, { claim: true }),
    onSuccess: () => refresh(),
  });
}

export function useCloseTask() {
  const api = useTasksApi();
  const refresh = useTaskRefresh();
  return useMutation({
    mutationFn: ({ id, project, reason, ...options }: { id: string; project: string; reason: string } & CloseOptions) =>
      api.closeTask(id, project, reason, options),
    onSuccess: () => refresh(),
  });
}

export function useCommentOnTask() {
  const api = useTasksApi();
  const refresh = useTaskRefresh();
  return useMutation({
    mutationFn: ({
      id,
      project,
      text,
      idempotencyKey,
    }: {
      id: string;
      project: string;
      text: string;
      idempotencyKey?: string;
    }) => api.comment(id, project, text, idempotencyKey === undefined ? undefined : { idempotencyKey }),
    onSuccess: () => refresh(),
  });
}

export function useDisputeTask() {
  const api = useTasksApi();
  const refresh = useTaskRefresh();
  return useMutation({
    mutationFn: ({ id, project }: { id: string; project: string }) => api.dispute(id, project),
    onSuccess: () => refresh(),
  });
}

/** One answer from a person, as one press made it. */
export type InboxAnswer = { readonly id: string; readonly title: string; readonly project: string } & (
  | { kind: 'approve' }
  | { kind: 'answer'; text: string }
  | { kind: 'choose'; option: TaskChoiceKey; label?: string; note?: string }
  /** A close where nothing shipped. A task waiting on a person is declined
   * (`via: "dismiss"`) with the resolution; any other task is closed with it. */
  | { kind: 'close'; resolution: NotDone; note?: string; duplicateOf?: string; via?: 'dismiss' }
);

/** The API call for one answer. */
export function sendInboxAnswer(api: TasksApi, answer: InboxAnswer, keepalive = false): Promise<void> {
  const write = keepalive ? { keepalive: true } : {};
  switch (answer.kind) {
    case 'approve':
      return api.resolveGate(answer.id, answer.project, undefined, write);
    case 'answer':
      return api.respond(answer.id, answer.project, answer.text, write);
    case 'choose':
      return api.choose(answer.id, answer.project, answer.option, answer.note, write);
    case 'close': {
      const other = answer.duplicateOf === undefined ? {} : { duplicateOf: answer.duplicateOf };
      if (answer.via !== 'dismiss') {
        return api.closeTask(answer.id, answer.project, closeAsReason(answer), {
          ...write,
          resolution: answer.resolution,
          ...other,
        });
      }
      const note = answer.note?.trim() ? answer.note.trim() : undefined;
      return api.dismiss(answer.id, answer.project, note, { ...write, resolution: answer.resolution, ...other });
    }
  }
}

const ANSWERED: Record<InboxAnswer['kind'], string> = {
  approve: 'Approved',
  answer: 'Answered',
  choose: 'Chosen',
  close: 'Closed',
};

/** The toast's heading: a pick names its option and a close its resolution,
 * so Undo is offered against what was sent. */
function answeredAs(answer: InboxAnswer): string {
  if (answer.kind === 'choose' && answer.label !== undefined) return `Chose ${choiceName(answer.option, answer.label)}`;
  if (answer.kind === 'close') return `Closed as ${RESOLUTION_LABELS[answer.resolution]}`;
  return ANSWERED[answer.kind];
}

let toastCount = 0;

/**
 * Answer one decision. The toast names the task and carries Undo for the
 * window; the call follows; a refusal comes back in the server's words with
 * a way to open the task.
 */
export function useInboxAnswer(): (answer: InboxAnswer) => void {
  const api = useTasksApi();
  const queue = useAnswerQueue();
  const refresh = useTaskRefresh();
  const navigate = useNavigate();
  return useCallback(
    (answer: InboxAnswer) => {
      const captured = Object.freeze({ ...answer });
      toastCount += 1;
      const toastId = `answer-${toastCount}`;
      toast.success(answeredAs(answer), {
        id: toastId,
        description: answer.title,
        duration: UNDO_WINDOW_MS,
        action: { label: 'Undo', onClick: () => queue.undoGroup(toastId) },
      });
      queue.schedule({
        id: answer.id,
        group: toastId,
        send: (keepalive) => sendInboxAnswer(api, captured, keepalive),
        onSent: () => {
          toast.dismiss(toastId);
          void refresh();
        },
        onFailed: (error) => {
          toast.dismiss(toastId);
          toast.error(error instanceof Error && error.message !== '' ? error.message : `Could not send ${answer.id}`, {
            action: { label: 'Open', onClick: () => void navigate(taskPath(answer.id)) },
          });
        },
        onUndo: () => toast.dismiss(toastId),
      });
    },
    [api, queue, refresh, navigate],
  );
}

/** Whether a task's row stays hidden while its answer waits or is on its way. */
export function useAnswerHides(): (id: string, fetchedAt: number | null) => boolean {
  const queue = useAnswerQueue();
  useSyncExternalStore(queue.subscribe, queue.version, queue.version);
  return queue.hides;
}
