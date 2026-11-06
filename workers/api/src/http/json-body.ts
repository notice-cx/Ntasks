/**
 * A JSON request body's text, bounded in bytes and in time: the one reader
 * the HTTP API and the MCP endpoint share. Only `application/json` is read,
 * because a browser can send a text/plain POST to another site without a
 * preflight, but never an application/json one. Any refusal throws
 * BoundedJsonRefused; the caller chooses the answer.
 */
export class BoundedJsonRefused extends Error {
  override name = 'BoundedJsonRefused';
  constructor() {
    super('Request body refused.');
  }
}

/** The longest a client may take to send its whole body. */
const BODY_MS = 2_000;

function invalid(): never {
  throw new BoundedJsonRefused();
}

/** Whether the request declares a JSON body, parameters such as charset aside. */
export function jsonContentType(headers: Headers): boolean {
  return headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

export async function readBoundedJsonText(request: Request, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) invalid();
  if (request.signal.aborted || request.bodyUsed || !request.body || !jsonContentType(request.headers)) invalid();
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) invalid();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let emptyChunks = 0;
  let timedOut = false;
  const expiresAt = Date.now() + BODY_MS;
  // cancel() ends pending reads at once, but a source's own cleanup promise
  // can hang, so the wait for it stays inside the same body deadline.
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= reader.cancel().catch(() => {});
  };
  let finishDeadline!: () => void;
  const deadline = new Promise<void>((resolve) => {
    finishDeadline = resolve;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
    finishDeadline();
  }, BODY_MS);
  request.signal.addEventListener('abort', cancel, { once: true });
  if (request.signal.aborted) cancel();
  try {
    for (;;) {
      const next = await reader.read();
      if (timedOut || Date.now() >= expiresAt || request.signal.aborted) invalid();
      if (next.done) break;
      if (next.value.byteLength === 0) {
        if (++emptyChunks > 1024) invalid();
        continue;
      }
      bytes += next.value.byteLength;
      if (bytes > maxBytes) invalid();
      chunks.push(next.value);
    }
    const joined = new Uint8Array(bytes);
    let at = 0;
    for (const chunk of chunks) {
      joined.set(chunk, at);
      at += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(joined);
  } finally {
    cancel();
    try {
      await Promise.race([cancellation, deadline]);
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  }
}
