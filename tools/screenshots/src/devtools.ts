/**
 * The pieces of the screenshot script that wait on something else: a
 * minimal Chrome DevTools Protocol client, a check repeated until it holds,
 * and a navigation that waits for its new document. None starts a process,
 * so the tests can run them without a browser.
 */

/** What the client needs of a WebSocket; a test passes a stand-in. */
export interface ProtocolSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
}

interface Waiting {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** Fails the request when no answer has come by its deadline. */
  timer: ReturnType<typeof setTimeout>;
}

/** How long a request waits for its answer unless the client is told otherwise. */
export const ANSWER_MS = 30_000;

/**
 * One request, one answer, matched by id. Every request ends: with its
 * answer, when its caller's signal aborts, after `answerMs` with no answer,
 * or when the connection closes, as it does when Chrome exits. After the
 * connection closes, every later request fails at once. An answer that
 * arrives after its request ended is dropped.
 */
export class DevTools {
  readonly #socket: ProtocolSocket;
  readonly #answerMs: number;
  #next = 1;
  readonly #waiting = new Map<number, Waiting>();
  #closed: Error | null = null;

  constructor(socket: ProtocolSocket, { answerMs = ANSWER_MS }: { answerMs?: number } = {}) {
    this.#socket = socket;
    this.#answerMs = answerMs;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id === undefined) return;
      const waiting = this.#end(message.id);
      if (message.error) waiting?.reject(new Error(message.error.message));
      else waiting?.resolve(message.result);
    });
    const lost = () => this.#fail(new Error('The connection to Chrome closed.'));
    socket.addEventListener('close', lost);
    socket.addEventListener('error', lost);
  }

  static async connect(endpoint: string, options: { answerMs?: number } = {}): Promise<DevTools> {
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Could not reach Chrome.')), { once: true });
    });
    return new DevTools(socket, options);
  }

  /**
   * Sends one request and resolves with its answer. It fails if no answer
   * comes within the client's `answerMs`, or, with `signal`, as soon as the
   * signal aborts, with the signal's reason.
   */
  send<T>(
    method: string,
    params: object = {},
    { sessionId, signal }: { sessionId?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = this.#next++;
    const answer = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => this.#end(id)?.reject(new Error(`Chrome did not answer ${method} within ${this.#answerMs} ms.`)),
        this.#answerMs,
      );
      this.#waiting.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    });
    signal?.addEventListener('abort', () => this.#end(id)?.reject(signal.reason as Error), { once: true });
    this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return answer;
  }

  close(): void {
    this.#socket.close();
  }

  /** Takes a request out of waiting and stops its deadline; undefined when it has already ended. */
  #end(id: number): Waiting | undefined {
    const waiting = this.#waiting.get(id);
    this.#waiting.delete(id);
    if (waiting) clearTimeout(waiting.timer);
    return waiting;
  }

  #fail(error: Error): void {
    this.#closed ??= error;
    for (const id of [...this.#waiting.keys()]) this.#end(id)?.reject(error);
  }
}

/**
 * Resolves once `check` answers true, asking every 100 ms; rejects after
 * `waitMs` with `what` in its message, even while a check is still waiting
 * on its answer. Each check gets a signal that aborts at the deadline, so a
 * request it started is cancelled rather than left running. A check that
 * fails rejects at once, with that failure, unless `retryFailures` is set:
 * then a failure counts as not yet, as when a server that is starting
 * refuses a connection.
 */
export async function until(
  what: string,
  check: (signal: AbortSignal) => Promise<boolean>,
  { waitMs, retryFailures = false }: { waitMs: number; retryFailures?: boolean },
): Promise<void> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(`Timed out waiting for ${what}.`)), waitMs);
  const expired = new Promise<never>((_, reject) => {
    deadline.signal.addEventListener('abort', () => reject(deadline.signal.reason as Error), { once: true });
  });
  // Only a race below reads this; once until returns, nothing does.
  expired.catch(() => undefined);
  let pause: ReturnType<typeof setTimeout> | undefined;
  try {
    for (;;) {
      let holds: boolean;
      try {
        holds = await Promise.race([check(deadline.signal), expired]);
      } catch (error) {
        if (deadline.signal.aborted || !retryFailures) throw deadline.signal.aborted ? deadline.signal.reason : error;
        holds = false;
      }
      if (holds) return;
      await Promise.race([new Promise((resolve) => (pause = setTimeout(resolve, 100))), expired]);
    }
  } finally {
    clearTimeout(timer);
    clearTimeout(pause);
  }
}

/** A DevTools request on one page, as the screenshot script sends it. */
export type PageSend = <T>(method: string, params?: object, signal?: AbortSignal) => Promise<T>;

/**
 * Navigates the page to `url` and resolves once its main frame holds the
 * document this navigation loaded, matched by the loader id Chrome returns.
 * Until then the page can still show the previous document, which already
 * passes a readiness check meant for the new one when the same address is
 * drawn again in the other theme. A navigation Chrome refuses fails with
 * Chrome's reason.
 */
export async function navigate(send: PageSend, url: string, { waitMs }: { waitMs: number }): Promise<void> {
  const started = await send<{ loaderId?: string; errorText?: string }>('Page.navigate', { url });
  if (started.errorText) throw new Error(`Chrome could not open ${url}: ${started.errorText}`);
  const { loaderId } = started;
  // A navigation to another #fragment of the same document loads nothing new.
  if (loaderId === undefined) return;
  await until(
    `${url} to replace the previous page`,
    async (signal) => {
      const { frameTree } = await send<{ frameTree: { frame: { loaderId: string } } }>('Page.getFrameTree', {}, signal);
      return frameTree.frame.loaderId === loaderId;
    },
    { waitMs },
  );
}
