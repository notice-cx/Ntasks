/**
 * Better Auth, the sign-in library, configured for Ntasks on D1: the owner
 * signs in with GitHub, and AI agents get OAuth 2.1 tokens for the MCP
 * endpoint through its OAuth provider plugin.
 *
 * Building it costs CPU time, so only the sign-in routes build one, once per
 * request. The token verifier that every other request runs (verify.ts)
 * reads the same tables directly instead.
 */
import { oauthProvider } from '@better-auth/oauth-provider';
import { betterAuth } from 'better-auth';
import type { SignInConfig } from './config.ts';
import {
  AGENT_ACCESS_PAGE,
  AGENT_ACCESS_TOKEN_SECONDS,
  AGENT_REFRESH_TOKEN_SECONDS,
  AGENT_SCOPES,
  AUTH_BASE_PATH,
  OFFLINE_ACCESS,
  RESOURCE_NAME,
  SIGN_IN_PAGE,
  mcpResource,
} from './protocol.ts';
import { CORE_TABLES, OAUTH_TABLES } from './tables.ts';

/** Session cookies are named `<prefix>.session_token`, with `__Secure-` in front over https. */
export const COOKIE_PREFIX = 'ntasks';

/** Whether a GitHub profile belongs to an allowlisted owner. */
export function isOwnerProfile(config: SignInConfig, profile: Record<string, unknown> | undefined): boolean {
  const id = profile?.id;
  return (typeof id === 'number' || typeof id === 'string') && config.owners.has(String(id));
}

interface AuthOptions {
  /** Check that the database matches the library's schema; tests only, since it reads the schema on each build. */
  readonly validateSchema?: boolean;
}

/**
 * A Better Auth instance for one request. Building it starts database reads,
 * so build it only where the request then uses it, and await that use.
 */
export function createAuth(db: D1Database, config: SignInConfig, options: AuthOptions = {}) {
  const resource = mcpResource(config.origin);
  const scopes = [...Object.keys(AGENT_SCOPES), OFFLINE_ACCESS];
  return betterAuth({
    appName: 'Ntasks',
    baseURL: config.origin,
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    database: db,
    trustedOrigins: [config.origin],
    telemetry: { enabled: false },
    logger: { level: 'error' },
    // The SIGN_IN_LIMIT binding limits sign-in requests per address before
    // they get here; the library's own limiter would write to D1 on each one.
    rateLimit: { enabled: false },
    emailAndPassword: { enabled: false },
    onAPIError: { errorURL: config.origin + SIGN_IN_PAGE },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: config.secure,
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      database: { generateId: 'uuid', validateSchema: options.validateSchema === true },
    },
    user: {
      ...CORE_TABLES.user,
      // Runs before a person is created, before a GitHub account is linked,
      // and on every GitHub sign-in, with the profile GitHub just returned.
      validateUserInfo: ({ source }) => {
        if (
          source.method === 'oauth' &&
          source.oauth?.providerId === 'github' &&
          isOwnerProfile(config, source.oauth.profile)
        ) {
          return;
        }
        return { error: 'not_an_owner', errorDescription: 'This GitHub account may not sign in to this Ntasks.' };
      },
    },
    session: { ...CORE_TABLES.session, cookieCache: { enabled: false } },
    // The GitHub token from sign-in is never used again; it is kept encrypted
    // under the auth secret so a copy of the database does not reveal it.
    account: { ...CORE_TABLES.account, accountLinking: { enabled: false }, encryptOAuthTokens: true },
    verification: CORE_TABLES.verification,
    socialProviders: {
      github: { clientId: config.github.clientId, clientSecret: config.github.clientSecret },
    },
    plugins: [
      oauthProvider({
        schema: OAUTH_TABLES,
        loginPage: SIGN_IN_PAGE,
        consentPage: AGENT_ACCESS_PAGE,
        scopes,
        resources: [{ identifier: resource, name: RESOURCE_NAME, allowedScopes: scopes }],
        grantTypes: ['authorization_code', 'refresh_token'],
        // MCP clients register themselves (RFC 7591) and must use PKCE.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: scopes,
        clientRegistrationAllowedScopes: scopes,
        clientRegistrationDefaultResources: [resource],
        clientRegistrationAllowedResources: [resource],
        clientRegistrationRequirePKCE: true,
        // A client that redirects only to this machine's loopback is a native
        // app (RFC 8252); MCP clients often leave application_type out.
        clientRegistrationDefaultApplicationType: 'infer',
        accessTokenExpiresIn: AGENT_ACCESS_TOKEN_SECONDS,
        refreshTokenExpiresIn: AGENT_REFRESH_TOKEN_SECONDS,
        // Access tokens are opaque and stored hashed. This Worker is both the
        // authorization server and the only resource server, and every call
        // reads the database to see revocations and project grants, so a
        // signed token would save no read.
        disableJwtPlugin: true,
        storeTokens: 'hashed',
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
