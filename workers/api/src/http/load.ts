/**
 * POST /api/restore and the routes under it: a load into the empty store,
 * page by page (docs/api.md). The store keeps each page and writes them all
 * when the load is committed (store/load.ts); these routes read each
 * request's body and answer what the store answered.
 */
import type { RouteContext } from '../api.ts';
import { strictJson } from '../mcp/protocol.ts';
import { readBoundedJsonText } from './json-body.ts';
import { invalidRequest, json, queryOf } from './respond.ts';

/** The largest body a load request may send: a page of rows. */
const BODY_BYTES = 1024 * 1024;
/** Enough JSON values for a page's most rows of the widest table. */
const BODY_VALUES = 100_000;

async function bodyOf(request: Request, url: URL, keys: readonly string[]): Promise<Record<string, unknown>> {
  queryOf(url, []);
  let body: unknown;
  try {
    body = strictJson(await readBoundedJsonText(request, BODY_BYTES), BODY_VALUES, 8);
  } catch {
    invalidRequest('the body must be one JSON object of at most 1 MB, sent as application/json');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    invalidRequest('the body must be one JSON object');
  const unknown = Object.keys(body).filter((key) => !keys.includes(key));
  if (unknown.length > 0) invalidRequest(`unknown field ${unknown[0]}; this route takes ${keys.join(', ')}`);
  return body as Record<string, unknown>;
}

function answer<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly status: number; readonly error: string; readonly detail: string },
): Response {
  return result.ok ? json(result.value) : json({ error: result.error, detail: result.detail }, result.status);
}

export async function loadBeginRoute(context: RouteContext, url: URL, request: Request): Promise<Response> {
  const body = await bodyOf(request, url, ['migrations']);
  return answer(await context.load.begin(body.migrations, context.principal.name));
}

export async function loadRowsRoute(context: RouteContext, url: URL, request: Request): Promise<Response> {
  const body = await bodyOf(request, url, ['load', 'table', 'rows']);
  return answer(await context.load.rows(body.load, body.table, body.rows));
}

export async function loadCommitRoute(context: RouteContext, url: URL, request: Request): Promise<Response> {
  const body = await bodyOf(request, url, ['load', 'counts']);
  return answer(await context.load.commit(body.load, body.counts));
}

export async function loadAbortRoute(context: RouteContext, url: URL, request: Request): Promise<Response> {
  const body = await bodyOf(request, url, ['load']);
  return answer(await context.load.abort(body.load));
}
