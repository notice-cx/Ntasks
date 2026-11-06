/**
 * Sign-in and access, as the rest of the Worker uses them. The Worker signs
 * every API and MCP request in with `signInAuthenticator`, whose sender the
 * API checks each project against (`mayReach` in src/auth.ts); whether an
 * answer is the owner's own decision is `mayDecide`. `handleAccess` answers
 * the sign-in paths themselves.
 */
export { ON_BEHALF_OF_HEADER, signInAuthenticator, type SignedIn, type SignInAuthenticator } from './authenticator.ts';
export { handleAccess, isAccessPath, type AccessEnv } from './routes.ts';
export { refusal, verifyRequest, type Verification, type VerifierEnv } from './verify.ts';
export {
  actorOf,
  mayDecide,
  type AgentPrincipal,
  type PersonPrincipal,
  type Principal,
  type ProjectAccess,
  type ServicePrincipal,
} from './principal.ts';
export { AGENT_SCOPES, MCP_PATH, bearerChallenge, mcpResource } from './protocol.ts';
