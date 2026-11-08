-- Migration number: 0001 	 2026-11-06T19:40:00.000Z

-- D1 holds the data that is not tasks: sign-in, the GitHub App people sign
-- in through, and the workspaces with their members, invitations, agent
-- grants and service credentials. docs/sign-in.md describes the tables and
-- the checks made on every request.
--
-- The auth_ tables belong to Better Auth (better-auth.com), the sign-in
-- library: people, their browser sessions, their GitHub accounts, and the
-- OAuth 2.1 clients, consents and tokens of AI agents. Their columns are the
-- ones Better Auth 1.7 asks for, under snake_case names that
-- workers/api/src/access/tables.ts maps; a test compares them with the
-- library's own schema. Better Auth writes times as ISO 8601 text, booleans
-- as 0 or 1, and lists and objects as JSON text.
--
-- The workspace and access_ tables belong to Ntasks. Each workspace keeps its
-- tasks in its own task store, the Durable Object named 'workspace:' followed
-- by the workspace's id. A person belongs to a workspace through a
-- membership, as its owner or a member. An invitation names a GitHub login
-- that may join a workspace; it becomes a membership bound to that account's
-- user once the account signs in. An agent's project grants and a service
-- credential each name the workspace they reach. A project lives in the task
-- store, a Durable Object with its own database that D1 cannot reference, so
-- project_id is the store's project id and the Worker checks that the project
-- exists when it records a grant.

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

CREATE TABLE workspaces (
  -- A UUID, lowercase, in its 8-4-4-4-12 shape: it names the workspace's task store.
  id TEXT PRIMARY KEY CHECK (
    length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-'
    AND substr(id, 24, 1) = '-' AND length(replace(id, '-', '')) = 32 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  created_by TEXT NOT NULL REFERENCES auth_user (id),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  user_id TEXT NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
  -- Both read, write and decide in the workspace; an owner also manages its
  -- members, invitations, projects and service credentials.
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
) STRICT, WITHOUT ROWID;

-- Signing in reads a person's memberships by user.
CREATE INDEX workspace_members_by_user ON workspace_members (user_id);

CREATE TABLE workspace_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  -- As the owner typed it. GitHub logins ignore case, so lookups use lower().
  github_login TEXT NOT NULL CHECK (length(github_login) BETWEEN 1 AND 39),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_by TEXT NOT NULL REFERENCES auth_user (id),
  created_at TEXT NOT NULL,
  -- A login can be renamed and then taken by someone else, so an invitation
  -- admits nobody after this time.
  expires_at TEXT NOT NULL CHECK (expires_at > created_at),
  -- The person the invitation became a membership for, and when.
  accepted_by TEXT REFERENCES auth_user (id),
  accepted_at TEXT,
  revoked_at TEXT,
  CHECK ((accepted_by IS NULL) = (accepted_at IS NULL)),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
) STRICT;

-- One open invitation for a login in a workspace.
CREATE UNIQUE INDEX workspace_invitations_open ON workspace_invitations (workspace_id, lower(github_login))
WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Signing in looks up the open invitations of the account's login.
CREATE INDEX workspace_invitations_by_login ON workspace_invitations (lower(github_login))
WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- The projects an agent may reach for the person who approved it, chosen on
-- the approval page, each in its workspace. An agent reaches no project
-- without a row here, and a workspace's project only while that person is a
-- member of the workspace. access is the most it may do there; its token's
-- scopes can lower it.
CREATE TABLE access_agent_grants (
  user_id TEXT NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES auth_oauth_client (client_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 255),
  access TEXT NOT NULL CHECK (access IN ('read', 'write')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, client_id, workspace_id, project_id)
) STRICT, WITHOUT ROWID;

-- A named credential for a service, such as a NoticeOS installation, in one
-- workspace, which every request it sends reaches. The service sends
-- `ntasks_service.<id>.<secret>` as a bearer token; only the SHA-256 of the
-- secret is stored, so the token is shown once, when made. backup lets it
-- read the whole workspace's store for a backup (GET /api/backup), and
-- restore load rows into that store while it is empty (POST /api/restore).
-- The owner chooses both when making the credential.
CREATE TABLE access_service_credentials (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  -- SHA-256 of the secret, as 64 hexadecimal characters.
  secret_hash TEXT NOT NULL CHECK (length(secret_hash) = 64 AND secret_hash NOT GLOB '*[^0-9a-f]*'),
  created_by TEXT NOT NULL REFERENCES auth_user (id),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  backup INTEGER NOT NULL DEFAULT 0 CHECK (backup IN (0, 1)),
  restore INTEGER NOT NULL DEFAULT 0 CHECK (restore IN (0, 1)),
  UNIQUE (workspace_id, name)
) STRICT;

-- A revoked credential stays revoked, and keeps every other value.
CREATE TRIGGER access_service_credentials_revoked_stays BEFORE UPDATE ON access_service_credentials
WHEN OLD.revoked_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.secret_hash IS NOT OLD.secret_hash OR NEW.name IS NOT OLD.name OR NEW.created_at IS NOT OLD.created_at
  OR NEW.created_by IS NOT OLD.created_by OR NEW.backup IS NOT OLD.backup OR NEW.restore IS NOT OLD.restore
BEGIN
  SELECT raise(ABORT, 'ntasks: a service credential only changes by being revoked, once');
END;

-- The projects of its workspace a service credential may reach. It reaches
-- no other project.
CREATE TABLE access_service_grants (
  credential_id TEXT NOT NULL REFERENCES access_service_credentials (id),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 255),
  access TEXT NOT NULL CHECK (access IN ('read', 'write')),
  PRIMARY KEY (credential_id, project_id)
) STRICT, WITHOUT ROWID;

-- How many agents registered on each UTC day. Anyone may register, and each
-- registration writes to D1. The per-minute rate limits count separately in
-- each Cloudflare location; this count is the same for every location, so
-- the daily budget it enforces bounds those writes everywhere.
CREATE TABLE access_registration_days (
  day TEXT PRIMARY KEY CHECK (length(day) = 10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  registrations INTEGER NOT NULL CHECK (registrations >= 1)
) STRICT, WITHOUT ROWID;

-- The GitHub App people sign in through, which the setup page on /sign-in
-- registers from a manifest when a deployment sets no GitHub secrets. One
-- row: a deployment signs in through one app, and two setups that finish at
-- once store one of them.
CREATE TABLE access_github_app (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- The origin the setup ran at, such as https://ntasks.example.com: the
  -- OAuth issuer, the callback address and the cookies are bound to it.
  origin TEXT NOT NULL CHECK (length(origin) BETWEEN 1 AND 255),
  -- The app's client id and client secret, as JSON encrypted under a key
  -- derived from AUTH_SECRET. After AUTH_SECRET changes it no longer
  -- decrypts, and the setup page replaces the row.
  credentials TEXT NOT NULL,
  -- The numeric GitHub id of the account that created the app: a deployment
  -- admin beside the ids in OWNER_GITHUB_IDS. A new setup replaces it with
  -- the new app's owner.
  admin_github_id TEXT NOT NULL CHECK (
    length(admin_github_id) BETWEEN 1 AND 20 AND admin_github_id NOT GLOB '*[^0-9]*'
  ),
  created_at TEXT NOT NULL
) STRICT;
