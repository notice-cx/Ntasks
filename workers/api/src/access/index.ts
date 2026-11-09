/**
 * Sign-in and access, as the rest of the Worker uses them. The Worker signs
 * every API and MCP request in with `signInAuthenticator`, whose sender
 * names the workspaces it reaches (`reachesOf`); the API checks each project
 * of the request's workspace against it (`mayReach` in src/auth.ts). Whether
 * an answer is a person's own decision is `mayDecide`. `handleAccess` answers
 * the sign-in paths and the workspace routes themselves.
 */
export {
  ON_BEHALF_OF_HEADER,
  reachesOf,
  signInAuthenticator,
  type SignedIn,
  type SignInAuthenticator,
} from './authenticator.ts';
export { handleAccess, isAccessPath, type AccessEnv } from './routes.ts';
export { crossOrigin } from './cross-origin.ts';
export { refusal, verifyRequest, type Verification, type VerifierEnv } from './verify.ts';
export {
  actorOf,
  mayDecide,
  type AgentPrincipal,
  type Membership,
  type PersonPrincipal,
  type Principal,
  type ProjectAccess,
  type ServicePrincipal,
  type WorkspaceGrants,
} from './principal.ts';
export { AGENT_SCOPES, MCP_PATH, bearerChallenge, mcpResource } from './protocol.ts';
