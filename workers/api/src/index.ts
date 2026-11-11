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
      let answer: Response;
      try {
        answer = (await handleAccess(request, env)) ?? (await worker.fetch(request, env));
      } catch (error) {
        const behind = await databaseBehind(env.DB);
        if (behind === null) throw error;
        return behind;
      }
      // The sign-in library answers its own database errors as a 5xx or an error redirect.
      return failed(answer) ? ((await databaseBehind(env.DB)) ?? answer) : answer;
    });
    return new URL(request.url).pathname.startsWith('/api/') ? versioned(response) : response;
  },
} satisfies ExportedHandler<Env>;

/**
 * An answer that reports a fault: a 5xx, or a redirect that carries the
 * sign-in library's error for one. A 503 is the Worker's own answer, for a
 * database that lacks migrations or a write to send again, and is kept.
 */
function failed(answer: Response): boolean {
  if (answer.status >= 500) return answer.status !== 503;
  if (answer.status < 300 || answer.status >= 400) return false;
  return /[?&]error=(?:internal_server_error|server_error)(?:&|$)/u.test(answer.headers.get('location') ?? '');
}
