/**
 * Sign-in in the shape the API layer asks for: `authenticate(request)` gives
 * the sender or null, and `challenge(request)` the answer when it is null.
 * It reads only the request's headers, never its body, which the MCP
 * endpoint reads afterwards.
 */
import { SCOPES, type Authenticator, type Principal as ApiPrincipal } from '../auth.ts';
import { actorOf, type Principal } from './principal.ts';
import { refusal, verifyRequest, type Verification, type VerifierEnv } from './verify.ts';

const READ = SCOPES.read;
const WRITE = SCOPES.write;

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

/** The scopes for the most the principal may do in any one project; none for a sender with no grants. */
function scopesOf(principal: Principal): readonly string[] {
  if (principal.kind === 'person') return [READ, WRITE];
  const access = new Set(principal.projects.values());
  if (access.has('write')) return [READ, WRITE];
  return access.has('read') ? [READ] : [];
}

type Refusal = Extract<Verification, { ok: false }>;

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
      const { principal } = verification;
      return Object.freeze({
        id: principal.id,
        name: actorOf(principal).name,
        scopes: scopesOf(principal),
        projects: principal.kind === 'person' ? 'all' : principal.projects,
        principal,
      });
    },
    challenge(request: Request): Response {
      return refusal(refusals.get(request) ?? { ok: false, reason: 'unauthenticated' }, env);
    },
  });
}
