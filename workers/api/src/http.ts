/** Each answer holds the state at the time of its request; `no-store` keeps caches from serving it again. */
export function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...headers, 'cache-control': 'no-store' } });
}
