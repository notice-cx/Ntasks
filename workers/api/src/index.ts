/**
 * The Ntasks Worker's entry point. Only the paths wrangler.jsonc lists in
 * `assets.run_worker_first` reach it; the web app's files are served before
 * it runs. TaskStore is exported here so Cloudflare can create it.
 */
import { crossOrigin, handleAccess, signInAuthenticator } from './access/index.ts';
import { createWorker } from './worker.ts';

export { TaskStore } from './store/index.ts';

const worker = createWorker({ authenticator: (env) => signInAuthenticator(env) });

export default {
  /** The sign-in paths, then the health check and the API (worker.ts), each
   * readable from a connected app's page (access/cross-origin.ts). */
  async fetch(request, env) {
    return crossOrigin(request, env.DB, async () => (await handleAccess(request, env)) ?? worker.fetch(request, env));
  },
} satisfies ExportedHandler<Env>;
