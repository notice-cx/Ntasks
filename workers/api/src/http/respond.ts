/** Every answer holds the state at the time of its request; `no-store` keeps caches from serving it again. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...headers, 'cache-control': 'no-store' } });
}

export const REPLAYED_HEADER = 'idempotent-replayed';

/** Marks an answer served from a retry record without changing its body. */
export function writtenJson(body: unknown, replayed: boolean, status = 200): Response {
  return json(body, status, replayed ? { [REPLAYED_HEADER]: 'true' } : {});
}

/** A request the route cannot serve, with a sentence that says why, and the
 * body field at fault when one is, so a form can show the sentence beside it. */
export class HttpRefused extends Error {
  override name = 'HttpRefused';
  readonly status: number;
  readonly error: string;
  readonly field: string | undefined;
  constructor(status: number, error: string, detail: string, field?: string) {
    super(detail);
    this.status = status;
    this.error = error;
    this.field = field;
  }
  response(): Response {
    return json(
      { error: this.error, detail: this.message, ...(this.field === undefined ? {} : { field: this.field }) },
      this.status,
    );
  }
}

export function invalidRequest(detail: string): never {
  throw new HttpRefused(400, 'invalid_request', detail);
}

export function notFound(detail: string): never {
  throw new HttpRefused(404, 'not_found', detail);
}

/**
 * The query parameters a route takes, each at most once. An unknown or
 * repeated one is refused, so a misspelt filter fails loudly instead of being
 * ignored.
 */
export function queryOf(url: URL, allowed: readonly string[]): Readonly<Record<string, string>> {
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key))
      invalidRequest(`unknown parameter ${key}; this route takes ${allowed.join(', ') || 'none'}`);
    if (Object.hasOwn(query, key)) invalidRequest(`${key} is given twice`);
    query[key] = value;
  }
  return query;
}

/** A whole number from a query parameter, within bounds. */
export function wholeOf(
  query: Readonly<Record<string, string>>,
  name: string,
  least: number,
  most: number,
  fallback: number,
): number {
  const text = query[name];
  if (text === undefined) return fallback;
  const value = /^\d{1,15}$/u.test(text) ? Number(text) : Number.NaN;
  if (!(value >= least && value <= most)) invalidRequest(`${name} must be a whole number from ${least} to ${most}`);
  return value;
}
