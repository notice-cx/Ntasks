/**
 * The Ntasks Worker's entry point. Only the paths wrangler.jsonc lists in
 * `assets.run_worker_first` reach it; the web app's files are served before
 * it runs. TaskStore is exported here so Cloudflare can create it.
 */
import { noSignIn } from './auth.ts';
import { createWorker } from './worker.ts';

export { TaskStore } from './store/index.ts';

// Every API request is refused until sign-in is in place.
export default createWorker({ authenticator: () => noSignIn });
