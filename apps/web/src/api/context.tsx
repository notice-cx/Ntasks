import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { createAnswerQueue, type AnswerQueue } from '@/lib/answer-queue';
import type { TasksApi } from './client';

interface TasksRuntime {
  api: TasksApi;
  answers: AnswerQueue;
}

const Runtime = createContext<TasksRuntime | null>(null);

/** The API every page reads and writes through, and the Undo window answers wait in. */
export function TasksApiProvider({ api, children }: { api: TasksApi; children: ReactNode }) {
  const answers = useMemo(() => createAnswerQueue(typeof window === 'undefined' ? undefined : window), []);
  useEffect(() => () => answers.dispose(), [answers]);
  const value = useMemo(() => ({ api, answers }), [api, answers]);
  return <Runtime.Provider value={value}>{children}</Runtime.Provider>;
}

function useRuntime(): TasksRuntime {
  const runtime = useContext(Runtime);
  if (!runtime) throw new Error('TasksApiProvider is missing above this component.');
  return runtime;
}

export function useTasksApi(): TasksApi {
  return useRuntime().api;
}

export function useAnswerQueue(): AnswerQueue {
  return useRuntime().answers;
}
