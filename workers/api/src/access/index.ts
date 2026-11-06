/**
 * Sign-in and access, as the rest of the Worker uses them. An API or MCP
 * route calls `verifyRequest` first and answers a refusal with `refusal`;
 * then it checks the project the request names with `may`, and whether an
 * answer is the owner's own decision with `mayDecide`.
 */
export { handleAccess, isAccessPath, type AccessEnv } from './routes.ts';
export { refusal, verifyRequest, type Verification, type VerifierEnv } from './verify.ts';
export {
  actorOf,
  may,
  mayDecide,
  projectAccess,
  reachableProjects,
  type AgentPrincipal,
  type PersonPrincipal,
  type Principal,
  type ProjectAccess,
  type ServicePrincipal,
} from './principal.ts';
export { AGENT_SCOPES, MCP_PATH, bearerChallenge, mcpResource } from './protocol.ts';
