import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // Tests run inside workerd, the runtime that runs the deployed Worker,
    // with the bindings wrangler.jsonc declares and a local D1 database.
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Read here in Node, because workerd has no file system;
        // test/apply-migrations.ts applies them inside the runtime.
        bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations') },
      },
    })),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
