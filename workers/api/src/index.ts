/**
 * The Ntasks Worker's entry point. Only the paths wrangler.jsonc lists in
 * `assets.run_worker_first` reach it; the web app's files are served before
 * it runs. TaskStore is exported here so Cloudflare can create it.
 */
import { handleAccess, signInAuthenticator } from './access/index.ts';
import { versioned } from './version.ts';
import { createWorker } from './worker.ts';

export { TaskStore } from './store/index.ts';

const worker = createWorker({ authenticator: (env) => signInAuthenticator(env) });

export default {
  /** The sign-in paths, then the health check and the API (worker.ts); every answer under /api names the API's version. */
  async fetch(request, env) {
    const response = (await handleAccess(request, env)) ?? (await worker.fetch(request, env));
    return new URL(request.url).pathname.startsWith('/api/') ? versioned(response) : response;
  },
} satisfies ExportedHandler<Env>;
