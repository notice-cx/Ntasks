/**
 * Better Auth's tables under the names migrations/0002_sign_in.sql gives
 * them: an auth_ prefix and snake_case columns, like the rest of the
 * database. test/access/schema.test.ts checks these against the library's own
 * schema, so a library upgrade that adds a column fails there first.
 */

/** A camelCase field name as its snake_case column. */
function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').replace(/([A-Z])([A-Z][a-z])/gu, '$1_$2').toLowerCase();
}

function model<const F extends readonly string[]>(modelName: string, fields: F) {
  return {
    modelName,
    fields: Object.fromEntries(fields.map((field) => [field, snake(field)])) as Record<F[number], string>,
  };
}

export const CORE_TABLES = {
  user: model('auth_user', ['emailVerified', 'createdAt', 'updatedAt']),
  session: model('auth_session', ['expiresAt', 'createdAt', 'updatedAt', 'ipAddress', 'userAgent', 'userId']),
  account: model('auth_account', [
    'accountId', 'providerId', 'userId', 'accessToken', 'refreshToken', 'idToken',
    'accessTokenExpiresAt', 'refreshTokenExpiresAt', 'createdAt', 'updatedAt',
  ]),
  verification: model('auth_verification', ['expiresAt', 'createdAt', 'updatedAt']),
} as const;

export const OAUTH_TABLES = {
  oauthClient: model('auth_oauth_client', [
    'clientId', 'clientSecret', 'clientDiscoveryId', 'disabled', 'skipConsent', 'enableEndSession', 'subjectType',
    'scopes', 'clientCredentialsScopes', 'userId', 'createdAt', 'updatedAt', 'name', 'uri', 'icon', 'contacts', 'tos',
    'policy', 'softwareId', 'softwareVersion', 'softwareStatement', 'redirectUris', 'postLogoutRedirectUris',
    'backchannelLogoutUri', 'backchannelLogoutSessionRequired', 'tokenEndpointAuthMethod', 'applicationType', 'jwks',
    'jwksUri', 'grantTypes', 'responseTypes', 'requirePKCE', 'dpopBoundAccessTokens', 'referenceId', 'metadata',
  ]),
  oauthResource: model('auth_oauth_resource', [
    'identifier', 'name', 'accessTokenTtl', 'refreshTokenTtl', 'signingAlgorithm', 'signingKeyId', 'allowedScopes',
    'customClaims', 'dpopBoundAccessTokensRequired', 'disabled', 'createdAt', 'updatedAt', 'policyVersion', 'metadata',
  ]),
  oauthClientResource: model('auth_oauth_client_resource', ['clientId', 'resourceId', 'metadata', 'createdAt']),
  oauthRefreshToken: model('auth_oauth_refresh_token', [
    'token', 'clientId', 'sessionId', 'userId', 'referenceId', 'authorizationCodeId', 'resources',
    'requestedUserInfoClaims', 'expiresAt', 'createdAt', 'revoked', 'rotatedAt', 'rotationReplayResponse',
    'rotationReplayExpiresAt', 'authTime', 'confirmation', 'scopes',
  ]),
  oauthAccessToken: model('auth_oauth_access_token', [
    'token', 'clientId', 'sessionId', 'userId', 'referenceId', 'authorizationCodeId', 'resources',
    'requestedUserInfoClaims', 'refreshId', 'expiresAt', 'createdAt', 'revoked', 'confirmation', 'scopes',
  ]),
  oauthConsent: model('auth_oauth_consent', [
    'clientId', 'userId', 'referenceId', 'resources', 'requestedUserInfoClaims', 'scopes', 'createdAt', 'updatedAt',
  ]),
  oauthClientAssertion: model('auth_oauth_client_assertion', ['expiresAt']),
} as const;
