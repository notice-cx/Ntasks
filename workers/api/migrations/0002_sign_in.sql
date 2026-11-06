-- Migration number: 0002 	 2026-11-06T19:40:00.000Z

-- Sign-in and access: who may call Ntasks, and which projects each caller
-- reaches. docs/sign-in.md describes the tables and the checks made on every
-- request.
--
-- The auth_ tables belong to Better Auth (better-auth.com), the sign-in
-- library: people, their browser sessions, their GitHub accounts, and the
-- OAuth 2.1 clients, consents and tokens of AI agents. Their columns are the
-- ones Better Auth 1.7 asks for, under snake_case names that
-- workers/api/src/access/tables.ts maps; a test compares them with the
-- library's own schema. Better Auth writes times as ISO 8601 text, booleans
-- as 0 or 1, and lists and objects as JSON text.
--
-- The access_ tables belong to Ntasks: which projects each agent and each
-- service credential may reach.

CREATE TABLE auth_user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL CHECK (email_verified IN (0, 1)),
  image TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- A browser session. token is the value the session cookie carries, signed.
CREATE TABLE auth_session (
  id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX auth_session_by_user ON auth_session (user_id);

-- A person's account at a sign-in provider. For GitHub, account_id is the
-- GitHub user's numeric id, which the owner allowlist names.
CREATE TABLE auth_account (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  scope TEXT,
  password TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- One provider account belongs to one person.
  UNIQUE (provider_id, account_id)
) STRICT;

CREATE INDEX auth_account_by_user ON auth_account (user_id);

-- Short-lived values of a sign-in in progress, such as the state of a
-- GitHub sign-in or an authorization code.
CREATE TABLE auth_verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX auth_verification_by_identifier ON auth_verification (identifier);

-- An OAuth client: an AI agent's MCP client, which registers itself.
CREATE TABLE auth_oauth_client (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  client_secret TEXT,
  client_discovery_id TEXT,
  disabled INTEGER CHECK (disabled IN (0, 1)),
  skip_consent INTEGER CHECK (skip_consent IN (0, 1)),
  enable_end_session INTEGER CHECK (enable_end_session IN (0, 1)),
  subject_type TEXT,
  scopes TEXT,
  client_credentials_scopes TEXT,
  user_id TEXT REFERENCES auth_user (id) ON DELETE CASCADE,
  created_at TEXT,
  updated_at TEXT,
  name TEXT,
  uri TEXT,
  icon TEXT,
  contacts TEXT,
  tos TEXT,
  policy TEXT,
  software_id TEXT,
  software_version TEXT,
  software_statement TEXT,
  redirect_uris TEXT NOT NULL,
  post_logout_redirect_uris TEXT,
  backchannel_logout_uri TEXT,
  backchannel_logout_session_required INTEGER CHECK (backchannel_logout_session_required IN (0, 1)),
  token_endpoint_auth_method TEXT,
  application_type TEXT,
  jwks TEXT,
  jwks_uri TEXT,
  grant_types TEXT,
  response_types TEXT,
  require_pkce INTEGER CHECK (require_pkce IN (0, 1)),
  dpop_bound_access_tokens INTEGER CHECK (dpop_bound_access_tokens IN (0, 1)),
  reference_id TEXT,
  metadata TEXT
) STRICT;

CREATE INDEX auth_oauth_client_by_user ON auth_oauth_client (user_id);

-- A protected resource that access tokens are issued for: the MCP endpoint.
CREATE TABLE auth_oauth_resource (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  access_token_ttl INTEGER,
  refresh_token_ttl INTEGER,
  signing_algorithm TEXT,
  signing_key_id TEXT,
  allowed_scopes TEXT,
  custom_claims TEXT,
  dpop_bound_access_tokens_required INTEGER CHECK (dpop_bound_access_tokens_required IN (0, 1)),
  disabled INTEGER CHECK (disabled IN (0, 1)),
  created_at TEXT,
  updated_at TEXT,
  policy_version INTEGER,
  metadata TEXT
) STRICT;

CREATE TABLE auth_oauth_client_resource (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES auth_oauth_client (client_id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES auth_oauth_resource (identifier) ON DELETE CASCADE,
  metadata TEXT,
  created_at TEXT
) STRICT;

CREATE INDEX auth_oauth_client_resource_by_client ON auth_oauth_client_resource (client_id);
CREATE INDEX auth_oauth_client_resource_by_resource ON auth_oauth_client_resource (resource_id);

-- Tokens are stored as the SHA-256 of the token, never the token itself.
-- revoked holds the time a token was revoked.
CREATE TABLE auth_oauth_refresh_token (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES auth_oauth_client (client_id) ON DELETE CASCADE,
  session_id TEXT REFERENCES auth_session (id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
  reference_id TEXT,
  authorization_code_id TEXT,
  resources TEXT,
  requested_user_info_claims TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked TEXT,
  rotated_at TEXT,
  rotation_replay_response TEXT,
  rotation_replay_expires_at TEXT,
  auth_time TEXT,
  confirmation TEXT,
  scopes TEXT NOT NULL
) STRICT;

CREATE INDEX auth_oauth_refresh_token_by_client_user ON auth_oauth_refresh_token (client_id, user_id);
CREATE INDEX auth_oauth_refresh_token_by_session ON auth_oauth_refresh_token (session_id);
CREATE INDEX auth_oauth_refresh_token_by_user ON auth_oauth_refresh_token (user_id);
CREATE INDEX auth_oauth_refresh_token_by_code ON auth_oauth_refresh_token (authorization_code_id);

CREATE TABLE auth_oauth_access_token (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES auth_oauth_client (client_id) ON DELETE CASCADE,
  session_id TEXT REFERENCES auth_session (id) ON DELETE SET NULL,
  user_id TEXT REFERENCES auth_user (id) ON DELETE CASCADE,
  reference_id TEXT,
  authorization_code_id TEXT,
  resources TEXT,
  requested_user_info_claims TEXT,
  refresh_id TEXT REFERENCES auth_oauth_refresh_token (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked TEXT,
  confirmation TEXT,
  scopes TEXT NOT NULL
) STRICT;

CREATE INDEX auth_oauth_access_token_by_client_user ON auth_oauth_access_token (client_id, user_id);
CREATE INDEX auth_oauth_access_token_by_session ON auth_oauth_access_token (session_id);
CREATE INDEX auth_oauth_access_token_by_user ON auth_oauth_access_token (user_id);
CREATE INDEX auth_oauth_access_token_by_code ON auth_oauth_access_token (authorization_code_id);
CREATE INDEX auth_oauth_access_token_by_refresh ON auth_oauth_access_token (refresh_id);

-- A person's approval of an agent's scopes. Deleting it is part of revoking
-- the agent.
CREATE TABLE auth_oauth_consent (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES auth_oauth_client (client_id) ON DELETE CASCADE,
  user_id TEXT REFERENCES auth_user (id) ON DELETE CASCADE,
  reference_id TEXT,
  resources TEXT,
  requested_user_info_claims TEXT,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX auth_oauth_consent_by_client_user ON auth_oauth_consent (client_id, user_id);
CREATE INDEX auth_oauth_consent_by_user ON auth_oauth_consent (user_id);

CREATE TABLE auth_oauth_client_assertion (
  id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
) STRICT;

-- The projects an agent may reach for the person who approved it, chosen on
-- the approval page. An agent reaches no project without a row here.
-- access is the most it may do there; its token's scopes can lower it.
CREATE TABLE access_agent_grants (
  user_id TEXT NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES auth_oauth_client (client_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects (id),
  access TEXT NOT NULL CHECK (access IN ('read', 'write')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, client_id, project_id)
) STRICT, WITHOUT ROWID;

-- A named credential for a service, such as a NoticeOS installation. The
-- service sends `ntasks_service.<id>.<secret>` as a bearer token; only the
-- SHA-256 of the secret is stored, so the token is shown once, when made.
CREATE TABLE access_service_credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 64),
  -- SHA-256 of the secret, as 64 hexadecimal characters.
  secret_hash TEXT NOT NULL CHECK (length(secret_hash) = 64 AND secret_hash NOT GLOB '*[^0-9a-f]*'),
  created_by TEXT NOT NULL REFERENCES auth_user (id),
  created_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

-- A revoked credential stays revoked, and keeps its secret and name.
CREATE TRIGGER access_service_credentials_revoked_stays BEFORE UPDATE ON access_service_credentials
WHEN OLD.revoked_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.secret_hash IS NOT OLD.secret_hash
  OR NEW.name IS NOT OLD.name OR NEW.created_at IS NOT OLD.created_at OR NEW.created_by IS NOT OLD.created_by
BEGIN
  SELECT raise(ABORT, 'ntasks: a service credential only changes by being revoked, once');
END;

-- The projects a service credential may reach. It reaches no other project.
CREATE TABLE access_service_grants (
  credential_id TEXT NOT NULL REFERENCES access_service_credentials (id),
  project_id TEXT NOT NULL REFERENCES projects (id),
  access TEXT NOT NULL CHECK (access IN ('read', 'write')),
  PRIMARY KEY (credential_id, project_id)
) STRICT, WITHOUT ROWID;
