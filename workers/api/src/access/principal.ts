/**
 * Who sent a request, once the token verifier has checked it, and what that
 * sender may do. The API and MCP layers call `verifyRequest` (verify.ts) on
 * every request and decide with the functions here; the task engine never
 * sees a principal, only the `Actor` and retry principal made from it.
 */
import type { Actor } from '@ntasks/domain';

/** The most a caller may do in one project. Write includes read. */
export type ProjectAccess = 'read' | 'write';

/** The owner, signed in in their own browser. Reaches every project. */
export interface PersonPrincipal {
  readonly kind: 'person';
  /** Stable and opaque: the retry principal for idempotency keys. */
  readonly id: string;
  readonly userId: string;
  readonly name: string;
}

/** An AI agent acting for the person who approved it, over OAuth. */
export interface AgentPrincipal {
  readonly kind: 'agent';
  readonly id: string;
  /** The person the agent acts for. */
  readonly userId: string;
  readonly clientId: string;
  /** The name the agent's client registered with, as the person saw it when approving. */
  readonly name: string;
  /** The projects the person granted, each lowered to what the token's scopes allow. */
  readonly projects: ReadonlyMap<string, ProjectAccess>;
}

/** A service, such as a NoticeOS installation, with a named credential. */
export interface ServicePrincipal {
  readonly kind: 'service';
  readonly id: string;
  readonly credentialId: string;
  readonly name: string;
  readonly projects: ReadonlyMap<string, ProjectAccess>;
}

export type Principal = PersonPrincipal | AgentPrincipal | ServicePrincipal;

/** What the principal may do in a project: null when it may not reach it. */
export function projectAccess(principal: Principal, projectId: string): ProjectAccess | null {
  if (principal.kind === 'person') return 'write';
  return principal.projects.get(projectId) ?? null;
}

/** Whether the principal may read (`read`) or change (`write`) the project's tasks. */
export function may(principal: Principal, projectId: string, needed: ProjectAccess): boolean {
  const access = projectAccess(principal, projectId);
  return access === 'write' || (access === 'read' && needed === 'read');
}

/**
 * Whether an answer from this principal counts as the owner's own decision.
 * Only a person's browser session does. An agent or a service may still pass
 * on an answer the owner gave it, but the API layer records that as relayed,
 * never as the owner's direct decision.
 */
export function mayDecide(principal: Principal): boolean {
  return principal.kind === 'person';
}

/** The projects the principal reaches, or 'all' for the owner. */
export function reachableProjects(principal: Principal): 'all' | readonly string[] {
  if (principal.kind === 'person') return 'all';
  return [...principal.projects.keys()];
}

/** A name that starts like one of the prefixes actorOf adds. */
const PREFIXED = /^(?:agent|service|person):/u;

/**
 * The engine's actor for a write by this principal, with the model an agent
 * names. The task store records it as the filer, assignee, closer or author.
 * An agent picks its own name when it registers, and could pick the owner's,
 * so an agent's actor is `agent:<name>` and a service's `service:<name>`. An
 * owner's actor is their name, or `person:<name>` when their name itself
 * starts with one of these prefixes. So an actor that starts with `agent:` is
 * always an agent, and one that starts with `service:` always a service.
 */
export function actorOf(principal: Principal, model?: string): Actor {
  const kind = principal.kind === 'person' && !PREFIXED.test(principal.name) ? null : principal.kind;
  const name = (kind === null ? principal.name : `${kind}:${principal.name}`).slice(0, 255);
  return model === undefined ? { name } : { name, model };
}
