/**
 * GET /api/backup: the whole task store, page by page, for a backup
 * (docs/api.md). The store reads each page (store/backup.ts); this route
 * takes the page token and answers the page, or why it was refused.
 */
import type { RouteContext } from '../api.ts';
import { json, queryOf } from './respond.ts';

export async function backupRoute(context: RouteContext, url: URL): Promise<Response> {
  const { page } = queryOf(url, ['page']);
  const answer = await context.backup(page ?? null);
  if (!answer.ok) return json({ error: answer.error, detail: answer.detail }, answer.status);
  return json(answer.page);
}
