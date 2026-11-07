/**
 * The two pieces of the screenshot script that wait on something else: a
 * minimal Chrome DevTools Protocol client, and a check repeated until it
 * holds. Neither starts a process, so the tests can run them without a
 * browser.
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
}

/**
 * One request, one answer, matched by id. When the connection closes, as it
 * does when Chrome exits, every request still waiting fails at once, and so
 * does every later one: none waits for an answer that cannot come.
 */
export class DevTools {
  readonly #socket: ProtocolSocket;
  #next = 1;
  readonly #waiting = new Map<number, Waiting>();
  #closed: Error | null = null;

  constructor(socket: ProtocolSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id === undefined) return;
      const waiting = this.#waiting.get(message.id);
      this.#waiting.delete(message.id);
      if (message.error) waiting?.reject(new Error(message.error.message));
      else waiting?.resolve(message.result);
    });
    const lost = () => this.#fail(new Error('The connection to Chrome closed.'));
    socket.addEventListener('close', lost);
    socket.addEventListener('error', lost);
  }

  static async connect(endpoint: string): Promise<DevTools> {
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Could not reach Chrome.')), { once: true });
    });
    return new DevTools(socket);
  }

  send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#next++;
    const answer = new Promise<T>((resolve, reject) => {
      this.#waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return answer;
  }

  close(): void {
    this.#socket.close();
  }

  #fail(error: Error): void {
    this.#closed ??= error;
    for (const waiting of this.#waiting.values()) waiting.reject(error);
    this.#waiting.clear();
  }
}

/**
 * Resolves once `check` answers true, asking every 100 ms; rejects after
 * `waitMs` with `what` in its message. A check that fails rejects at once,
 * with that failure, unless `retryFailures` is set: then a failure counts as
 * not yet, as when a server that is starting refuses a connection.
 */
export async function until(
  what: string,
  check: () => Promise<boolean>,
  { waitMs, retryFailures = false }: { waitMs: number; retryFailures?: boolean },
): Promise<void> {
  const end = Date.now() + waitMs;
  for (;;) {
    let holds: boolean;
    try {
      holds = await check();
    } catch (error) {
      if (!retryFailures) throw error;
      holds = false;
    }
    if (holds) return;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
