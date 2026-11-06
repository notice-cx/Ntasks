/**
 * The Ntasks Worker's entry point. Only the paths wrangler.jsonc lists in
 * `assets.run_worker_first` reach it; the web app's files are served before
 * it runs. TaskStore is exported here so Cloudflare can create it.
 */
import { handleAccess } from './access/index.ts';
import { noSignIn } from './auth.ts';
import { createWorker } from './worker.ts';

export { TaskStore } from './store/index.ts';

// noSignIn refuses every API request. Sign-in's authenticator
// (access/index.ts) does not replace it yet: the API's Principal carries no
// project limits, and an agent or a service may reach only the projects it
// was granted.
const worker = createWorker({ authenticator: () => noSignIn });

export default {
  /** The sign-in paths, then the health check and the API (worker.ts). */
  async fetch(request, env) {
    return (await handleAccess(request, env)) ?? worker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
