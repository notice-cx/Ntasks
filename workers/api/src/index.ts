/**
 * The Ntasks Worker's entry point. Only the paths wrangler.jsonc lists in
 * `assets.run_worker_first` reach it; the web app's files are served before
 * it runs. TaskStore is exported here so Cloudflare can create it.
 */
import { crossOrigin, handleAccess, signInAuthenticator } from './access/index.ts';
import { databaseBehind } from './d1-migrations.ts';
import { versioned } from './version.ts';
import { createWorker } from './worker.ts';

export { TaskStore } from './store/index.ts';

const worker = createWorker({ authenticator: (env) => signInAuthenticator(env) });

export default {
  /** The sign-in paths, then the health check and the API (worker.ts), each
   * readable from a connected app's page (access/cross-origin.ts); every
   * answer under /api names the API's version. A request that fails while
   * the database lacks a migration names the migration instead. */
  async fetch(request, env) {
    const response = await crossOrigin(request, env.DB, async () => {
      try {
        return (await handleAccess(request, env)) ?? (await worker.fetch(request, env));
      } catch (error) {
        const behind = await databaseBehind(env.DB);
        if (behind === null) throw error;
        return behind;
      }
    });
    return new URL(request.url).pathname.startsWith('/api/') ? versioned(response) : response;
  },
} satisfies ExportedHandler<Env>;
