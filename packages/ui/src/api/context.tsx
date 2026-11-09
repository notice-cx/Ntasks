import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { createAnswerQueue, type AnswerQueue } from '../lib/answer-queue';
import { SIGN_IN_PATH, type TasksApi } from './client';
import type { TokenSource } from './connection';

interface TasksRuntime {
  api: TasksApi;
  answers: AnswerQueue;
  signIn: TokenSource['signIn'];
}

const Runtime = createContext<TasksRuntime | null>(null);

/** The API every page reads and writes through, the Undo window answers wait in, and what Sign in does. */
export function TasksApiProvider({
  api,
  signIn = SIGN_IN_PATH,
  children,
}: {
  api: TasksApi;
  signIn?: TokenSource['signIn'];
  children: ReactNode;
}) {
  const answers = useMemo(() => createAnswerQueue(), []);
  // Attached in an effect, so a render React discards attaches nothing and a remount attaches again.
  useEffect(() => answers.attach(window), [answers]);
  const value = useMemo(() => ({ api, answers, signIn }), [api, answers, signIn]);
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

export function useSignIn(): TokenSource['signIn'] {
  return useRuntime().signIn;
}
