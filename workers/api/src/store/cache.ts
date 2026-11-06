/**
 * Reads the task store answers from memory. A board, the epics and the
 * project list stay true until a write changes a task or a deferred task's
 * time comes, so between those they are read from the database once and then
 * served from memory, at no rows read. Every write goes through this engine,
 * which is what lets it know when to forget.
 */
import type { TaskEngine } from '@ntasks/domain';

/** How many answers it keeps; the oldest goes first. */
const ENTRIES = 64;

export function cachedReads(engine: TaskEngine, now: () => string): TaskEngine {
  let entries = new Map<string, Promise<unknown>>();
  /** When ready work next changes without a write; null when no deferral is ahead. */
  let until: Promise<string | null> | null = null;

  const forget = () => {
    entries = new Map();
    until = null;
  };

  async function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    until ??= engine.nextDeferralAfter(now());
    const expires = await until;
    if (expires !== null && now() >= expires) forget();
    // A write meanwhile replaced the map; this answer then belongs to no map.
    const current = entries;
    const found = current.get(key);
    if (found) return found as Promise<T>;
    if (current.size >= ENTRIES) current.delete(current.keys().next().value!);
    // Frozen, so no caller can reorder a list another caller is served.
    const answer = read().then((value) => (Array.isArray(value) ? Object.freeze(value) : value));
    current.set(key, answer);
    answer.catch(() => current.delete(key));
    return answer;
  }

  /** A write, after which every cached answer is forgotten, whether it landed or was refused. */
  function writes<A extends unknown[], R>(write: (...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      try {
        return await write(...args);
      } finally {
        forget();
      }
    };
  }

  return Object.freeze({
    ...engine,
    listProjects: () => cached('projects', () => engine.listProjects()),
    listBoard: (projectId, query) =>
      cached(JSON.stringify(['board', projectId, query]), () => engine.listBoard(projectId, query)),
    listEpics: (projectId) => cached(JSON.stringify(['epics', projectId]), () => engine.listEpics(projectId)),
    createProject: writes(engine.createProject),
    createTask: writes(engine.createTask),
    writeTask: writes(engine.writeTask),
    addComment: writes(engine.addComment),
  } satisfies TaskEngine);
}
