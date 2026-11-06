/**
 * Reads the task store answers from memory. A board, the epics and the
 * project list stay true until a write changes a task or a deferred task's
 * time comes, so between those they are read from the database once and then
 * served from memory, at no rows read. Every write goes through this engine,
 * which is what lets it know when to forget.
 */
import type { TaskEngine } from '@ntasks/domain';

/** How much the cache may hold. An object has 128 MB in all, which its
 * requests need too. */
export interface CacheLimits {
  /** The most answers it keeps; the oldest goes first. */
  readonly entries: number;
  /** The most bytes of answers it keeps, as their JSON measures them. */
  readonly bytes: number;
  /** An answer larger than this is served but not kept. */
  readonly entryBytes: number;
}

export const CACHE_LIMITS: CacheLimits = Object.freeze({ entries: 64, bytes: 32 * 2 ** 20, entryBytes: 8 * 2 ** 20 });

/** One generation of answers; a write starts a new one. */
interface Generation {
  readonly answers: Map<string, Promise<unknown>>;
  readonly sizes: Map<string, number>;
  bytes: number;
}

/** About how many bytes an answer holds in memory: two per character of its JSON. */
function sizeOf(value: unknown): number {
  return JSON.stringify(value).length * 2;
}

export function cachedReads(engine: TaskEngine, now: () => string, limits: CacheLimits = CACHE_LIMITS): TaskEngine {
  const fresh = (): Generation => ({ answers: new Map(), sizes: new Map(), bytes: 0 });
  let generation = fresh();
  /** When ready work next changes without a write; null when no deferral is ahead. */
  let until: Promise<string | null> | null = null;

  const forget = () => {
    generation = fresh();
    until = null;
  };

  /** Drops the oldest answers until the kept ones fit. */
  function trim(kept: Generation) {
    for (const key of kept.answers.keys()) {
      if (kept.answers.size <= limits.entries && kept.bytes <= limits.bytes) break;
      kept.answers.delete(key);
      kept.bytes -= kept.sizes.get(key) ?? 0;
      kept.sizes.delete(key);
    }
  }

  async function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    until ??= engine.nextDeferralAfter(now());
    const expires = await until;
    if (expires !== null && now() >= expires) forget();
    // A write meanwhile starts a new generation; this answer then belongs to none.
    const current = generation;
    const found = current.answers.get(key);
    if (found) return found as Promise<T>;
    // Frozen, so no caller can reorder a list another caller is served.
    const answer = read().then((value) => (Array.isArray(value) ? Object.freeze(value) : value));
    current.answers.set(key, answer);
    void answer.then(
      (value) => {
        // Already dropped to make room; it no longer counts.
        if (current.answers.get(key) !== answer) return;
        const size = sizeOf(value);
        if (size > limits.entryBytes) {
          current.answers.delete(key);
          return;
        }
        current.sizes.set(key, size);
        current.bytes += size;
        trim(current);
      },
      () => current.answers.delete(key),
    );
    trim(current);
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
