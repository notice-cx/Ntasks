import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // Tests run inside workerd, the runtime that runs the deployed Worker,
    // with the bindings wrangler.jsonc declares and a local D1 database.
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          // Read here in Node, because workerd has no file system;
          // test/apply-migrations.ts applies them inside the runtime.
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          // Sign-in settings for tests. None is a real credential: GitHub is
          // never called, test/access/github.ts answers in its place, and
          // 1001 to 1004 are invented GitHub user ids. test/workspaces.test.ts
          // signs in 1002 to 1004 as the people of its workspaces.
          NTASKS_ORIGIN: 'https://ntasks.test',
          AUTH_SECRET: 'test-only-auth-secret-0123456789abcdef',
          GITHUB_CLIENT_ID: 'test-github-client-id',
          GITHUB_CLIENT_SECRET: 'test-github-client-secret',
          OWNER_GITHUB_IDS: '1001, 1002, 1003, 1004',
        },
        // The tests register far more agents a minute than wrangler.jsonc
        // allows. test/access/settings.test.ts drives every limit with
        // stand-ins, and test/node/routing.ts checks the values wrangler.jsonc sets.
        ratelimits: { REGISTER_LIMIT: { namespace_id: '1002', simple: { limit: 10_000, period: 60 } } },
      },
    })),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
