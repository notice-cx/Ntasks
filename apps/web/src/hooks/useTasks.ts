/**
 * The pages' reads and writes, over the one `TasksApi`. Every write refreshes
 * the board and the task page it changed. Answers to decisions wait in the
 * Undo window (`lib/answer-queue.ts`) before they are sent.
 */
import { useMutation, useQueries, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAnswerQueue, useTasksApi } from '@/api/context';
import type { TasksApi } from '@/api/client';
import type { CloseOptions, LiveTaskDetail, LiveTasksPayload, NewTask, TaskChoiceKey, TaskEdit, TaskProject, TasksCapabilities } from '@/api/types';
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

export const READ_ONLY = 'This sign-in can read tasks but not change them.';

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
  return writesAvailable(capabilities) && (capabilities.operations === undefined || capabilities.operations.includes(operation));
}

export function fieldAvailable(capabilities: TasksCapabilities, field: string): boolean {
  return operationAvailable(capabilities, 'update') && (capabilities.editableFields === undefined || capabilities.editableFields.includes(field));
}

export function useTaskProjects() {
  const api = useTasksApi();
  return useQuery<readonly TaskProject[]>({
    queryKey: ['task-projects'],
    queryFn: ({ signal }) => api.projects(signal),
    staleTime: 60_000,
  });
}

/** Every named project's board, in the order given. */
export function useBoards(projects: readonly string[]): UseQueryResult<LiveTasksPayload, Error>[] {
  const api = useTasksApi();
  return useQueries({
    queries: projects.map((project) => ({
      queryKey: ['tasks', project],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.board(project, signal),
      staleTime: 15_000,
    })),
  });
}

export function useTask(id: string, project: string | null) {
  const api = useTasksApi();
  return useQuery<LiveTaskDetail>({
    queryKey: ['task', project, id],
    queryFn: ({ signal }) => api.task(id, project as string, signal),
    enabled: project !== null && id !== '',
    staleTime: 15_000,
    retry: (count, error) => count < 2 && !(error instanceof Error && 'status' in error && error.status === 404),
  });
}

/** What every write invalidates: the boards and the task pages. */
export function useTaskRefresh(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(async () => {
    await Promise.all([['tasks'], ['task']].map((queryKey) => client.invalidateQueries({ queryKey })));
  }, [client]);
}

export function useCreateTask() {
  const api = useTasksApi();
  const refresh = useTaskRefresh();
  return useMutation({ mutationFn: (input: NewTask) => api.createTask(input), onSuccess: () => refresh() });
}

export function useUpdateTask() {
  const api = useTasksApi();
  const refresh = useTaskRefresh();
  return useMutation({
    mutationFn: ({ id, project, edit }: { id: string; project: string; edit: TaskEdit }) => api.updateTask(id, project, edit),
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
    mutationFn: ({ id, project, text }: { id: string; project: string; text: string }) => api.comment(id, project, text),
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
        return api.closeTask(answer.id, answer.project, closeAsReason(answer), { ...write, resolution: answer.resolution, ...other });
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
  return useCallback((answer: InboxAnswer) => {
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
          action: { label: 'Open', onClick: () => navigate(taskPath(answer.id)) },
        });
      },
      onUndo: () => toast.dismiss(toastId),
    });
  }, [api, queue, refresh, navigate]);
}

/** Whether a task's row stays hidden while its answer waits or is on its way. */
export function useAnswerHides(): (id: string, readAt: string | null) => boolean {
  const queue = useAnswerQueue();
  useSyncExternalStore(queue.subscribe, queue.version, queue.version);
  return queue.hides;
}
