// Run by `node --test`, not Vitest. The Vitest suite calls the Worker's
// handler directly, so it never passes through Cloudflare's static-file layer,
// which decides whether a request reaches the Worker at all. This file starts
// the Worker behind that layer, as `wrangler dev` does. It reads the real
// wrangler.jsonc and swaps only the web build for a one-file fixture, so
// removing a path from assets.run_worker_first fails it.
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestHarness, unstable_readConfig } from 'wrangler';

const configPath = fileURLToPath(new URL('../../../../wrangler.jsonc', import.meta.url));
const config = unstable_readConfig({ config: configPath }, { hideWarnings: true });
assert.ok(config.assets, 'wrangler.jsonc declares the web app as static assets');

const server = createTestHarness({
  workers: [
    {
      config: {
        name: config.name,
        main: config.main,
        compatibility_date: config.compatibility_date,
        rules: config.rules,
        assets: { ...config.assets, directory: fileURLToPath(new URL('./fixtures/web', import.meta.url)) },
        // migrations_dir is relative to wrangler.jsonc, and the harness would
        // resolve it from the working directory.
        d1_databases: config.d1_databases.map((database: { binding: string; migrations_dir?: string }) => ({
          ...database,
          migrations_dir: resolve(dirname(configPath), database.migrations_dir ?? 'migrations'),
        })),
        ratelimits: config.ratelimits,
        // Sign-in settings, so its paths answer in full. Invented values, as
        // in vitest.config.ts; nothing here reaches GitHub.
        vars: {
          NTASKS_ORIGIN: 'http://localhost:8787',
          AUTH_SECRET: 'test-only-auth-secret-0123456789abcdef',
          GITHUB_CLIENT_ID: 'test-github-client-id',
          GITHUB_CLIENT_SECRET: 'test-github-client-secret',
          OWNER_GITHUB_IDS: '1001',
        },
      },
    },
  ],
});

before(async () => {
  await server.listen();
  // The sign-in paths read and write the sign-in tables.
  await server.getWorker().applyD1Migrations('DB');
});

after(async () => {
  await server.close();
});

// A browser sends `Sec-Fetch-Mode: navigate` when it loads a page, and for such
// a request Cloudflare answers any path it does not route to the Worker with
// the app's index.html.
const pageLoad = { headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' } };

test('the health check reaches the Worker', async () => {
  const response = await server.fetch('/healthz', pageLoad);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('an unknown API path gets the Worker JSON 404, not the web app', async () => {
  const response = await server.fetch('/api/no-such-route', pageLoad);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
});

test('the sign-in page reaches the Worker', async () => {
  const response = await server.fetch('/sign-in', pageLoad);

  assert.equal(response.status, 200);
  assert.match(await response.text(), /<h1>Sign in to Ntasks<\/h1>/u);
});

test('the agent approval page reaches the Worker', async () => {
  // With no signed OAuth query the Worker answers that the link has expired.
  const response = await server.fetch('/agent-access', pageLoad);

  assert.equal(response.status, 400);
  assert.match(await response.text(), /This link has expired/u);
});

// Sent as a page load so that, were the path missing from run_worker_first,
// the static-file layer would answer with index.html and the test would fail.
test('the protected resource metadata reaches the Worker', async () => {
  const response = await server.fetch('/.well-known/oauth-protected-resource/api/mcp', pageLoad);

  assert.equal(response.status, 200);
  const metadata = (await response.json()) as { resource: string };
  assert.equal(metadata.resource, 'http://localhost:8787/api/mcp');
});

for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/api/auth']) {
  test(`the authorization server metadata at ${path} reaches the Worker`, async () => {
    const response = await server.fetch(path, pageLoad);

    assert.equal(response.status, 200);
    const metadata = (await response.json()) as { issuer: string };
    assert.equal(metadata.issuer, 'http://localhost:8787/api/auth');
  });
}

for (const path of ['/tasks/web-a1b2', '/projects/example.test', '/projects/example.test/tasks']) {
  test(`a page load at ${path} gets the web app`, async () => {
    const response = await server.fetch(path, pageLoad);

    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>Ntasks routing fixture<\/title>/u);
  });
}

// The limits the sign-in routes run with. They are read from wrangler.jsonc
// rather than counted against the running Worker: Cloudflare's rate limiting
// binding counts in fixed windows, so counting requests fails whenever they
// straddle the start of a window. test/access/settings.test.ts checks how the
// routes use each limit.
test('wrangler.jsonc limits sign-in and agent registration', () => {
  const bindings = (config.ratelimits ?? []) as { name: string; simple: { limit: number; period: number } }[];
  const limits = bindings.map(({ name, simple }) => ({ name, ...simple }));

  assert.deepEqual(limits, [
    { name: 'SIGN_IN_LIMIT', limit: 30, period: 60 },
    { name: 'REGISTER_LIMIT', limit: 10, period: 60 },
    { name: 'REGISTER_ADDRESS_LIMIT', limit: 3, period: 60 },
  ]);
});
