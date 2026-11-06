/**
 * A person's answer to a decision is sent after an Undo window. An answer has
 * no inverse the API can run, so Undo cancels an answer not yet sent rather
 * than reversing one. Answers go one at a time; leaving the page sends what
 * is still waiting at once. Answers given in one action share a `group`,
 * which Undo cancels whole.
 */
export const UNDO_WINDOW_MS = 5_000;

/** How long a sent answer keeps its row hidden at most, should no later read arrive. */
export const HIDE_AFTER_SEND_MS = 60_000;

export interface ScheduledAnswer {
  id: string;
  /** The call to make; `keepalive` is true only when the page is leaving. */
  send: (keepalive: boolean) => Promise<void>;
  group?: string;
  onSent?: () => void;
  onFailed?: (error: unknown) => void;
  onUndo?: () => void;
  delayMs?: number;
}

export interface AnswerQueue {
  schedule(answer: ScheduledAnswer): void;
  undo(id: string): boolean;
  undoGroup(group: string): number;
  /** Send every waiting answer now. */
  flush(keepalive?: boolean): void;
  /**
   * Whether a task's row should stay hidden: its answer is waiting or on its
   * way, or was sent after the read the page shows. `fetchedAt` is when this
   * browser received that read, by this browser's clock, the same clock the
   * send is timed by; the server's own read time could be behind or ahead.
   */
  hides(id: string, fetchedAt: number | null): boolean;
  subscribe(listener: () => void): () => void;
  version(): number;
  /** Send what is still waiting when the page is leaving; the returned function stops. */
  attach(page: Window): () => void;
}

interface Waiting {
  id: string;
  group: string | null;
  timer: ReturnType<typeof setTimeout>;
  run: (keepalive: boolean) => Promise<void>;
  onUndo: () => void;
}

export function createAnswerQueue(): AnswerQueue {
  const waiting = new Map<string, Waiting>();
  const inFlight = new Map<string, number>();
  const sentAt = new Map<string, number>();
  const listeners = new Set<() => void>();
  let version = 0;
  let tail: Promise<void> | null = null;

  function emit() {
    version += 1;
    for (const listener of listeners) listener();
  }

  function inTurn(work: () => Promise<void>): Promise<void> {
    const next = tail === null ? work() : tail.then(work);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    tail = settled;
    void settled.then(() => {
      if (tail === settled) tail = null;
    });
    return next;
  }

  function schedule({ id, send, group, onSent, onFailed, onUndo, delayMs = UNDO_WINDOW_MS }: ScheduledAnswer) {
    const previous = waiting.get(id);
    if (previous) clearTimeout(previous.timer);
    const entry: Waiting = {
      id,
      group: group ?? null,
      timer: setTimeout(() => void run(false), delayMs),
      run,
      onUndo: onUndo ?? (() => {}),
    };
    async function run(keepalive: boolean) {
      if (waiting.get(id) !== entry) return;
      clearTimeout(entry.timer);
      waiting.delete(id);
      inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
      const settle = () => {
        const left = (inFlight.get(id) ?? 1) - 1;
        if (left === 0) inFlight.delete(id);
        else inFlight.set(id, left);
      };
      try {
        await (keepalive ? send(true) : inTurn(() => send(false)));
      } catch (error) {
        settle();
        emit();
        onFailed?.(error);
        return;
      }
      settle();
      sentAt.set(id, Date.now());
      emit();
      onSent?.();
    }
    waiting.set(id, entry);
    emit();
  }

  function undo(id: string): boolean {
    const entry = waiting.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    waiting.delete(id);
    emit();
    entry.onUndo();
    return true;
  }

  function undoGroup(group: string): number {
    let cancelled = 0;
    for (const entry of [...waiting.values()]) if (entry.group === group && undo(entry.id)) cancelled += 1;
    return cancelled;
  }

  function flush(keepalive = false) {
    for (const entry of [...waiting.values()]) void entry.run(keepalive);
  }

  function hides(id: string, fetchedAt: number | null): boolean {
    if (waiting.has(id) || inFlight.has(id)) return true;
    const sent = sentAt.get(id);
    if (sent === undefined) return false;
    // A read received after the send shows what the server now holds, and a
    // send long past stops hiding even if no read followed it.
    if ((fetchedAt !== null && fetchedAt > sent) || Date.now() - sent > HIDE_AFTER_SEND_MS) {
      sentAt.delete(id);
      return false;
    }
    return fetchedAt !== null;
  }

  return {
    schedule,
    undo,
    undoGroup,
    flush,
    hides,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
    attach(page) {
      const leaving = () => flush(true);
      page.addEventListener('pagehide', leaving);
      return () => page.removeEventListener('pagehide', leaving);
    },
  };
}
