// Run by `node --test`, not Vitest. The Vitest suite calls the Worker's
// handler directly, so it never passes through Cloudflare's static-file layer,
// which decides whether a request reaches the Worker at all. This file starts
// the Worker behind that layer, as `wrangler dev` does. It reads the real
// wrangler.jsonc and swaps only the web build for a one-file fixture, so
// removing a path from assets.run_worker_first fails it.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestHarness, unstable_readConfig } from 'wrangler';

const config = unstable_readConfig(
  { config: fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)) },
  { hideWarnings: true },
);
assert.ok(config.assets, 'wrangler.jsonc declares the web app as static assets');

const server = createTestHarness({
  workers: [
    {
      config: {
        name: config.name,
        main: config.main,
        compatibility_date: config.compatibility_date,
        assets: { ...config.assets, directory: fileURLToPath(new URL('./fixtures/web', import.meta.url)) },
        d1_databases: config.d1_databases,
      },
    },
  ],
});

before(async () => {
  await server.listen();
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

test('a page address gets the web app', async () => {
  const response = await server.fetch('/tasks/web-a1b2', pageLoad);

  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>Ntasks routing fixture<\/title>/u);
});
