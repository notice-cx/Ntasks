/**
 * Who sent a request, once the token verifier has checked it. The Worker
 * hands the API the sender in the API's own shape (authenticator.ts), which
 * src/auth.ts checks each project against; the task engine never sees a
 * principal, only the `Actor` and retry principal made from it.
 */
import { TASK_LIMITS, type Actor } from '@ntasks/domain';
import { SCOPES, type ProjectAccess } from '../auth.ts';
import type { Workspace, WorkspaceRole } from '../workspaces.ts';

export type { ProjectAccess };

/** A workspace a person belongs to, and their role there. */
export interface Membership {
  readonly workspace: Workspace;
  readonly role: WorkspaceRole;
}

/** The projects an agent or a service was granted in one workspace. */
export interface WorkspaceGrants {
  readonly workspace: Workspace;
  readonly projects: ReadonlyMap<string, ProjectAccess>;
}

/** A person, signed in in their own browser or through a connected app.
 * Reaches every project of each workspace they belong to; through an app,
 * only the app's workspace. */
export interface PersonPrincipal {
  readonly kind: 'person';
  /** Stable and opaque: the retry principal for idempotency keys. */
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  /** Whether they are a deployment admin, who may create workspaces: the setup page recorded them, or their GitHub id is in OWNER_GITHUB_IDS. Never through an app. */
  readonly admin: boolean;
  readonly memberships: readonly Membership[];
  /** The time zone they chose in Settings, an IANA name; absent leaves it to their browser. */
  readonly timeZone?: string;
  /** The connected app the person signed in to, when its token sent the
   * request; absent for their own browser session (`ownSession`). */
  readonly app?: ConnectedApp;
}

/** A connected app a person acts through: an OAuth client an owner of one workspace registered. */
export interface ConnectedApp {
  readonly clientId: string;
  /** The name its owner registered it with, as the person saw it when allowing it. */
  readonly name: string;
  /** The scopes its token carries; they bound what the person's role allows. */
  readonly scopes: readonly string[];
}

/** Whether this is a person in their own browser session, not through a connected app. Only that session manages access. */
export function ownSession(principal: Principal): principal is PersonPrincipal {
  return principal.kind === 'person' && principal.app === undefined;
}

/** An AI agent acting for the person who approved it, over OAuth. */
export interface AgentPrincipal {
  readonly kind: 'agent';
  readonly id: string;
  /** The person the agent acts for. */
  readonly userId: string;
  /** That person's name, which their own writes are recorded under (`personActor`). */
  readonly personName: string;
  readonly clientId: string;
  /** The name the agent's client registered with, as the person saw it when approving. */
  readonly name: string;
  /** The projects the person granted, by workspace, each lowered to what the
   * token's scopes allow; only in workspaces the person still belongs to. */
  readonly workspaces: readonly WorkspaceGrants[];
}

/** A service, such as a NoticeOS installation, with a named credential in one workspace. */
export interface ServicePrincipal {
  readonly kind: 'service';
  readonly id: string;
  readonly credentialId: string;
  readonly name: string;
  /** The workspace the credential belongs to, which every request it sends reaches. */
  readonly workspace: Workspace;
  readonly projects: ReadonlyMap<string, ProjectAccess>;
  /** Whether it may read the workspace's whole store for a backup, whatever its projects (GET /api/backup). */
  readonly backup: boolean;
  /** Whether it may load rows into the workspace's store while it is empty (POST /api/restore). */
  readonly restore: boolean;
  /**
   * The agent the service says a request is for (authenticator.ts). It names
   * the actor; it grants nothing beyond the credential's own projects.
   */
  readonly onBehalfOf?: string;
}

/** Anyone, reading the deployment's public workspace without signing in
 * (visitor.ts). It reads every project there and changes nothing. */
export interface VisitorPrincipal {
  readonly kind: 'visitor';
  readonly id: 'visitor';
  readonly name: 'anyone';
  readonly workspace: Workspace;
}

export type Principal = PersonPrincipal | AgentPrincipal | ServicePrincipal | VisitorPrincipal;

/**
 * Whether an answer from this principal counts as a person's own decision.
 * Only a person's does: in their browser session, or through a connected app
 * they granted `tasks:decide`. An agent or a service may still pass on an
 * answer a person gave it, but the API layer records that as relayed, never
 * as the person's direct decision.
 */
export function mayDecide(principal: Principal): boolean {
  return principal.kind === 'person' && (principal.app === undefined || principal.app.scopes.includes(SCOPES.decide));
}

/** A name that starts like one of the prefixes actorOf adds. */
const PREFIXED = /^(?:agent|service|person|visitor):/u;

/**
 * The engine's actor for a write by this principal, with the model an agent
 * names. The task store records it as the filer, assignee, closer or author.
 * An agent picks its own name when it registers, and could pick the owner's,
 * so an agent's actor is `agent:<name>` and a service's `service:<name>`, or
 * `service:<name>/<agent>` when it acts for an agent it names. A visitor's is
 * `visitor:anyone`, though a visitor writes nothing. An owner's
 * actor is their name, or `person:<name>` when their name itself starts with
 * one of these prefixes. So an actor that starts with `agent:` is always an
 * agent, and one that starts with `service:` always a service. The engine
 * takes at most TASK_LIMITS.actor characters; the authenticator refuses an
 * agent name that would make a service's actor longer, and a longer agent or
 * owner name is cut.
 */
export function actorOf(principal: Principal, model?: string): Actor {
  const base = principal.kind === 'person' ? personActor(principal.name) : `${principal.kind}:${principal.name}`;
  const full =
    principal.kind === 'service' && principal.onBehalfOf !== undefined ? `${base}/${principal.onBehalfOf}` : base;
  const name = full.slice(0, TASK_LIMITS.actor);
  return model === undefined ? { name } : { name, model };
}

/** The actor a person with this name is recorded under. */
export function personActor(name: string): string {
  return (PREFIXED.test(name) ? `person:${name}` : name).slice(0, TASK_LIMITS.actor);
}

/**
 * The actor of the person this sender is, or acts for: a person's own, and
 * for an agent the person who approved it. A comment under this actor holds
 * that person's own words. A service acts for no person.
 */
export function personOf(principal: Principal): string | undefined {
  if (principal.kind === 'person') return personActor(principal.name);
  if (principal.kind === 'agent') return personActor(principal.personName);
  return undefined;
}
