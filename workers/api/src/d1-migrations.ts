/**
 * The D1 migrations this code needs, and the answer the Worker gives when
 * its database lacks one: a deploy that runs `wrangler deploy` alone, not
 * `pnpm run deploy`, ships the code without them, and the first query that
 * reaches a missing table or column fails. Wrangler records each migration
 * it applies in `d1_migrations` under its file name.
 */
import { json } from './http/respond.ts';

/** The files in ../migrations, oldest first. test/d1-migrations.test.ts checks the list against the folder. */
export const D1_MIGRATIONS: readonly string[] = Object.freeze([
  '0001_sign_in_and_workspaces.sql',
  '0002_github_webhooks.sql',
  '0003_github_apps.sql',
  '0004_user_time_zone.sql',
]);

/** Where docs/deploy.md describes the fix, on the Ntasks website. */
export const DEPLOY_DOCS = 'https://ntasks.notice.cx/docs/deploy#the-database-lacks-a-migration';

/** The migrations `db` lacks, oldest first; none once every migration has been applied. */
export async function missingMigrations(db: D1Database): Promise<string[]> {
  let applied: Set<string>;
  try {
    const { results } = await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>();
    applied = new Set(results.map((row) => row.name));
  } catch (error) {
    // A database that never had a migration applied has no such table.
    if (!(error instanceof Error && error.message.includes('no such table: d1_migrations'))) throw error;
    applied = new Set();
  }
  return D1_MIGRATIONS.filter((name) => !applied.has(name));
}

/** The body that names the migrations missing and the fix. */
export function databaseBehindBody(missing: readonly string[]) {
  const names = missing.join(', ');
  return {
    error: 'database_behind',
    missing,
    detail:
      `This Ntasks's database lacks ${missing.length === 1 ? 'migration' : 'migrations'} ${names}, which its code needs. ` +
      `Deploy with pnpm run deploy, which applies migrations before it deploys the Worker; ` +
      `on Workers Builds, make it the deploy command. ${DEPLOY_DOCS}`,
  } as const;
}

/**
 * The answer for a request that failed, when the failure comes from
 * migrations `db` lacks; null when it lacks none, or when it cannot be read
 * either, so the request's own failure answers.
 */
export async function databaseBehind(db: D1Database): Promise<Response | null> {
  let missing: string[];
  try {
    missing = await missingMigrations(db);
  } catch {
    return null;
  }
  if (missing.length === 0) return null;
  console.error('the database lacks migrations', missing.join(', '));
  return json(databaseBehindBody(missing), 503);
}
