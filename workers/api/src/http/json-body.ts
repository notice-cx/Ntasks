/**
 * A request body, bounded in bytes and in time: the one reader the HTTP API,
 * the MCP endpoint and the GitHub receiver share. The API and the MCP
 * endpoint read only `application/json`, because a browser can send a
 * text/plain POST to another site without a preflight, but never an
 * application/json one. The GitHub receiver reads the bytes whatever their
 * type, since its signature, not its type, says who sent them. Any refusal
 * throws BoundedJsonRefused; the caller chooses the answer.
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

/** The body's text, of at most `maxBytes`, when it is declared as JSON and is UTF-8. */
export async function readBoundedJsonText(request: Request, maxBytes: number): Promise<string> {
  if (!jsonContentType(request.headers)) invalid();
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await readBoundedBytes(request, maxBytes));
}

/** The body's bytes as the client sent them, of at most `maxBytes`, whatever its type. */
export async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) invalid();
  if (request.signal.aborted || request.bodyUsed || !request.body) invalid();
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
    return joined;
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
