/**
 * Sign-in in the shape the API layer asks for: `authenticate(request)` gives
 * the sender or null, and `challenge(request)` the answer when it is null.
 * It reads only the request's headers, never its body, which the MCP
 * endpoint reads afterwards.
 */
import { actorOf, type Principal } from './principal.ts';
import { refusal, verifyRequest, type Verification, type VerifierEnv } from './verify.ts';

/** The OAuth scope names agents ask for (AGENT_SCOPES in protocol.ts). */
const READ = 'tasks:read';
const WRITE = 'tasks:write';

/** A signed-in sender for the API layer. */
export interface SignedIn {
  /** Stable and opaque: the retry principal. */
  readonly id: string;
  /** The actor the engine records (`actorOf`). */
  readonly name: string;
  /**
   * The most this sender may do in any project: `tasks:read`, and
   * `tasks:write` when it may change tasks somewhere. They do not say where.
   */
  readonly scopes: readonly string[];
  /**
   * The full sender. An agent or a service reaches only the projects it was
   * granted, so a route that names or lists projects checks each with
   * `may(principal, projectId, ...)` or `projectAccess`; whether an answer is
   * the owner's own decision is `mayDecide(principal)`.
   */
  readonly principal: Principal;
}

export interface SignInAuthenticator {
  authenticate(request: Request): Promise<SignedIn | null>;
  challenge(request: Request): Response;
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
      return Object.freeze({ id: principal.id, name: actorOf(principal).name, scopes: scopesOf(principal), principal });
    },
    challenge(request: Request): Response {
      return refusal(refusals.get(request) ?? { ok: false, reason: 'unauthenticated' }, env);
    },
  });
}
