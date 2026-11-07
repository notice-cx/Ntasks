/**
 * Sign-in in the shape the API layer asks for: `authenticate(request)` gives
 * the sender or null, and `challenge(request)` the answer when it is null.
 * It reads only the request's headers, never its body, which the MCP
 * endpoint reads afterwards.
 */
import { TASK_LIMITS } from '@ntasks/domain';
import { SCOPES, type Authenticator, type Principal as ApiPrincipal } from '../auth.ts';
import { json } from '../http/respond.ts';
import { actorOf, personOf, type Principal, type ServicePrincipal } from './principal.ts';
import { refusal, verifyRequest, type Verification, type VerifierEnv } from './verify.ts';

/**
 * The header a service sends to name the agent a request is for, such as one
 * of several agents a NoticeOS installation serves through one credential.
 * The owner and OAuth agents sign in as themselves, so it is ignored for them.
 */
export const ON_BEHALF_OF_HEADER = 'x-ntasks-on-behalf-of';
const ON_BEHALF_OF = /^[A-Za-z0-9._:/-]{1,128}$/u;

const READ = SCOPES.read;
const WRITE = SCOPES.write;
const BACKUP = SCOPES.backup;
const DECIDE = SCOPES.decide;

/**
 * A signed-in sender, in the API's shape (src/auth.ts): its id is the retry
 * principal, its name the actor the engine records (`actorOf`), its scopes
 * what it may do somewhere, and its projects where: `all` for the owner, or
 * each project an agent or a service was granted, with the most it may do
 * there. The API checks each project with `mayReach`.
 */
export interface SignedIn extends ApiPrincipal {
  /** The full sender, for `mayDecide(principal)`: whether an answer is the owner's own decision. */
  readonly principal: Principal;
}

export interface SignInAuthenticator extends Authenticator {
  authenticate(request: Request): Promise<SignedIn | null>;
}

/** The scopes for the most the principal may do in any one project, none
 * for a sender with no grants, the backup scope for the owner and a backup
 * credential, and the decide scope for the owner alone (`mayDecide`). */
function scopesOf(principal: Principal): readonly string[] {
  if (principal.kind === 'person') return [READ, WRITE, BACKUP, DECIDE];
  const access = new Set(principal.projects.values());
  const scopes = access.has('write') ? [READ, WRITE] : access.has('read') ? [READ] : [];
  return principal.kind === 'service' && principal.backup ? [...scopes, BACKUP] : scopes;
}

type Refusal = Extract<Verification, { ok: false }> | { readonly ok: false; readonly invalidRequest: string };

/**
 * The service acting for the agent its request names, or why the name is
 * refused. The agent's name joins the actor, `service:<credential>/<agent>`,
 * and the retry principal, `<service id>/<agent>`, so two agents' writes and
 * idempotency keys stay apart; both must fit the engine's limits.
 */
function actingFor(principal: ServicePrincipal, agent: string): ServicePrincipal | string {
  if (!ON_BEHALF_OF.test(agent)) {
    return `${ON_BEHALF_OF_HEADER} is 1 to 128 of the characters A-Z a-z 0-9 . _ : / -`;
  }
  const acting = { ...principal, id: `${principal.id}/${agent}`, onBehalfOf: agent };
  const actor = `service:${principal.name}/${agent}`;
  if (actor.length > TASK_LIMITS.actor || acting.id.length > TASK_LIMITS.retryPrincipal) {
    const most = Math.min(
      TASK_LIMITS.actor - `service:${principal.name}/`.length,
      TASK_LIMITS.retryPrincipal - `${principal.id}/`.length,
    );
    return `${ON_BEHALF_OF_HEADER} is at most ${most} characters with this credential`;
  }
  return Object.freeze(acting);
}

/** The authenticator for these bindings. It keeps no request's data but the reason it refused that request. */
export function signInAuthenticator(env: VerifierEnv): SignInAuthenticator {
  // Why authenticate refused each request, for challenge to answer with: an
  // invalid token, a cross-site change or sign-in being off each answer
  // differently. Keyed by the request object, and weakly, so one request's
  // refusal never reaches another and goes when the request does.
  const refusals = new WeakMap<Request, Refusal>();
  return Object.freeze({
    async authenticate(request: Request): Promise<SignedIn | null> {
      const verification = await verifyRequest(request, env);
      if (!verification.ok) {
        refusals.set(request, verification);
        return null;
      }
      let principal = verification.principal;
      const agent = request.headers.get(ON_BEHALF_OF_HEADER);
      if (principal.kind === 'service' && agent !== null) {
        const acting = actingFor(principal, agent);
        if (typeof acting === 'string') {
          refusals.set(request, { ok: false, invalidRequest: acting });
          return null;
        }
        principal = acting;
      }
      const person = personOf(principal);
      return Object.freeze({
        id: principal.id,
        name: actorOf(principal).name,
        scopes: scopesOf(principal),
        projects: principal.kind === 'person' ? 'all' : principal.projects,
        ...(person === undefined ? {} : { person }),
        principal,
      });
    },
    challenge(request: Request): Response {
      const refused = refusals.get(request) ?? { ok: false, reason: 'unauthenticated' };
      if ('invalidRequest' in refused) return json({ error: 'invalid_request', detail: refused.invalidRequest }, 400);
      return refusal(refused, env);
    },
  });
}
