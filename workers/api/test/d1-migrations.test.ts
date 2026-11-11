// A deploy that runs `wrangler deploy` alone ships code whose D1 migrations
// were never applied. These tests take a migration back out of the test
// database, as such a deploy leaves it, and check what the health check and a
// signed-in person's requests answer, and that applying it again ends that.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1_MIGRATIONS } from '../src/d1-migrations.ts';
import { WORKSPACE_HEADER } from '../src/workspaces.ts';
import { Browser, call } from './access/client.ts';
import { standInForGitHub } from './access/github.ts';
import { TEST_WORKSPACE } from './store.ts';

standInForGitHub();

/** The latest migration, which adds the column `withoutLatest` drops. */
const LATEST = '0004_user_time_zone.sql';

type Body = Record<string, unknown>;

async function answer(response: Response): Promise<{ status: number; body: Body }> {
  return { status: response.status, body: await response.json<Body>() };
}

/** Runs `run` on the database as a deploy that skipped LATEST leaves it, then applies LATEST again. */
async function withoutLatest(run: () => Promise<void>): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('ALTER TABLE auth_user DROP COLUMN time_zone'),
    env.DB.prepare('DELETE FROM d1_migrations WHERE name = ?').bind(LATEST),
  ]);
  try {
    await run();
  } finally {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  }
}

/** What Settings reads for its GitHub section, as `browser`. */
async function settingsGitHub(browser: Browser) {
  return answer(await browser.fetch('/api/access/github', { headers: { [WORKSPACE_HEADER]: TEST_WORKSPACE.id } }));
}

it('lists every file in the migrations folder, in order', () => {
  expect(D1_MIGRATIONS).toEqual(env.TEST_MIGRATIONS.map((migration) => migration.name));
});

describe('a database that lacks the latest migration', () => {
  let owner: Browser;

  beforeEach(async () => {
    owner = new Browser();
    await owner.signInAsOwner();
  });

  it('fails the health check, naming the migration', async () => {
    await withoutLatest(async () => {
      const health = await answer(await call('/healthz'));

      expect(health.status).toBe(503);
      expect(health.body).toMatchObject({ ok: false, error: 'database_behind', missing: [LATEST] });
      expect(health.body.detail).toContain(LATEST);
    });
  });

  it("answers Settings' GitHub read with the migration it lacks", async () => {
    await withoutLatest(async () => {
      const github = await settingsGitHub(owner);

      expect(github.status).toBe(503);
      expect(github.body).toMatchObject({ error: 'database_behind', missing: [LATEST] });
      expect(github.body.detail).toContain(LATEST);
    });
  });

  it('answers a signed-in task read with the migration, not a sign-in', async () => {
    await withoutLatest(async () => {
      const tasks = await answer(
        await owner.fetch('/api/tasks', {
          headers: { [WORKSPACE_HEADER]: TEST_WORKSPACE.id, accept: 'application/json' },
        }),
      );

      expect(tasks.status).toBe(503);
      expect(tasks.body).toMatchObject({ error: 'database_behind', missing: [LATEST] });
    });
  });

  it('answers as before once the migration is applied', async () => {
    await withoutLatest(async () => {
      await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

      expect(await answer(await call('/healthz'))).toEqual({ status: 200, body: { ok: true } });
      expect((await settingsGitHub(owner)).status).toBe(200);
    });
  });
});

it('names every migration when the database records none', async () => {
  await env.DB.exec('ALTER TABLE d1_migrations RENAME TO d1_migrations_kept');
  try {
    const health = await answer(await call('/healthz'));

    expect(health.status).toBe(503);
    expect(health.body).toMatchObject({ ok: false, error: 'database_behind', missing: D1_MIGRATIONS });
  } finally {
    await env.DB.exec('ALTER TABLE d1_migrations_kept RENAME TO d1_migrations');
  }
});

it('answers a sign-in that fails on a missing table with the migrations it lacks', async () => {
  // The sign-in library catches its own database errors and answers with an
  // error of its own, so the Worker checks the migrations after that answer.
  const first = D1_MIGRATIONS[0]!;
  await env.DB.batch([
    env.DB.prepare('ALTER TABLE auth_verification RENAME TO auth_verification_kept'),
    env.DB.prepare('DELETE FROM d1_migrations WHERE name = ?').bind(first),
  ]);
  try {
    const signIn = await new Browser().fetch('/sign-in', { form: { action: 'github' } });

    expect(signIn.status).toBe(503);
    expect(await signIn.json()).toMatchObject({ error: 'database_behind', missing: [first] });
  } finally {
    await env.DB.batch([
      env.DB.prepare('ALTER TABLE auth_verification_kept RENAME TO auth_verification'),
      env.DB.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(first),
    ]);
  }
});
