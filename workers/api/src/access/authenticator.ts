/**
 * Sign-in in the shape the API layer asks for: `authenticate(request)` gives
 * the sender or null, and `challenge(request)` the answer when it is null.
 * It reads only the request's headers, never its body, which the MCP
 * endpoint reads afterwards.
 */
import { TASK_LIMITS } from '@ntasks/domain';
import { SCOPES, type Authenticator, type ProjectAccess } from '../auth.ts';
import { json } from '../http/respond.ts';
import { byName, type Sender, type WorkspaceReach, type WorkspaceRole } from '../workspaces.ts';
import { actorOf, personOf, type Principal, type ServicePrincipal } from './principal.ts';
import { refusal, verifyRequest, type Verification, type VerifierEnv } from './verify.ts';
import { visitorOf, type PublicWorkspaceEnv } from './visitor.ts';

/**
 * The header a service sends to name the agent a request is for, such as one
 * of several agents a NoticeOS installation serves through one credential.
 * People and OAuth agents sign in as themselves, so it is ignored for them.
 */
export const ON_BEHALF_OF_HEADER = 'x-ntasks-on-behalf-of';
const ON_BEHALF_OF = /^[A-Za-z0-9._:/-]{1,128}$/u;

const READ = SCOPES.read;
const WRITE = SCOPES.write;
const BACKUP = SCOPES.backup;
const RESTORE = SCOPES.restore;
const DECIDE = SCOPES.decide;
const MANAGE = SCOPES.manage;

/** What a person may do in a workspace, by their role there. Only an owner
 * backs up, loads or manages it; the decide scope is a person's alone (`mayDecide`). */
const ROLE_SCOPES: Readonly<Record<WorkspaceRole, readonly string[]>> = Object.freeze({
  owner: Object.freeze([READ, WRITE, BACKUP, RESTORE, DECIDE, MANAGE]),
  member: Object.freeze([READ, WRITE, DECIDE]),
});

/**
 * A signed-in sender (src/workspaces.ts): its id is the retry principal, its
 * name the actor the engine records (`actorOf`), and its workspaces what it
 * may do in each, by scopes, and where, by projects: `all` for a person, or
 * each project an agent or a service was granted, with the most it may do
 * there. The API checks each project with `mayReach`.
 */
export interface SignedIn extends Sender {
  /** The full sender, for `mayDecide(principal)`: whether an answer is a person's own decision. */
  readonly principal: Principal;
}

export interface SignInAuthenticator extends Authenticator {
  authenticate(request: Request): Promise<SignedIn | null>;
}

/**
 * What a person may do through a connected app: their role's scopes that the
 * app's token carries, where write includes read. Never a backup, a load or
 * managing the workspace, whatever the role.
 */
function appScopes(role: WorkspaceRole, granted: readonly string[]): string[] {
  const carried = new Set(granted);
  if (carried.has(WRITE)) carried.add(READ);
  return [READ, WRITE, DECIDE].filter((scope) => carried.has(scope) && ROLE_SCOPES[role].includes(scope));
}

/** The scopes for the most a sender may do in any one of these projects: none when it was granted none. */
function grantScopes(projects: ReadonlyMap<string, ProjectAccess>): string[] {
  const access = new Set(projects.values());
  return access.has('write') ? [READ, WRITE] : access.has('read') ? [READ] : [];
}

/**
 * Every workspace the principal reaches, with what it may do there: a person
 * the workspaces they belong to, by their role, and through a connected app
 * its one workspace, by their role bounded by the app's scopes; an agent the workspaces where
 * its person granted it projects; a service its credential's one workspace,
 * with the backup and restore scopes when its owner made it with each; a
 * visitor the public workspace, to read every project there.
 */
export function reachesOf(principal: Principal): WorkspaceReach[] {
  const reaches: WorkspaceReach[] =
    principal.kind === 'person'
      ? principal.memberships.map(({ workspace, role }) => ({
          workspace,
          role,
          scopes: principal.app === undefined ? ROLE_SCOPES[role] : appScopes(role, principal.app.scopes),
          projects: 'all',
        }))
      : principal.kind === 'agent'
        ? principal.workspaces.map(({ workspace, projects }) => ({
            workspace,
            role: null,
            scopes: grantScopes(projects),
            projects,
          }))
        : principal.kind === 'service'
          ? [
              {
                workspace: principal.workspace,
                role: null,
                scopes: [
                  ...grantScopes(principal.projects),
                  ...(principal.backup ? [BACKUP] : []),
                  ...(principal.restore ? [RESTORE] : []),
                ],
                projects: principal.projects,
              },
            ]
          : [{ workspace: principal.workspace, role: null, scopes: [READ], projects: 'all' }];
  return reaches.sort(byName);
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
export function signInAuthenticator(env: VerifierEnv & PublicWorkspaceEnv): SignInAuthenticator {
  // Why authenticate refused each request, for challenge to answer with: an
  // invalid token, a cross-site change or sign-in being off each answer
  // differently. Keyed by the request object, and weakly, so one request's
  // refusal never reaches another and goes when the request does.
  const refusals = new WeakMap<Request, Refusal>();
  return Object.freeze({
    async authenticate(request: Request): Promise<SignedIn | null> {
      const verification = await verifyRequest(request, env);
      const visitor =
        !verification.ok && verification.reason === 'unauthenticated' ? await visitorOf(request, env) : null;
      if (!verification.ok && !visitor) {
        refusals.set(request, verification);
        return null;
      }
      let principal: Principal = verification.ok ? verification.principal : visitor!;
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
      const app = principal.kind === 'person' ? principal.app?.clientId : undefined;
      return Object.freeze({
        id: principal.id,
        name: actorOf(principal).name,
        ...(person === undefined ? {} : { person }),
        ...(app === undefined ? {} : { app }),
        workspaces: reachesOf(principal),
        principal,
      });
    },
    challenge(request: Request): Response {
      // No recorded refusal means authenticate threw before it read the
      // deployment's origin, so the challenge names the one the request came to.
      const refused = refusals.get(request) ?? {
        ok: false,
        reason: 'unauthenticated',
        origin: new URL(request.url).origin,
      };
      if ('invalidRequest' in refused) return json({ error: 'invalid_request', detail: refused.invalidRequest }, 400);
      return refusal(refused, env);
    },
  });
}
