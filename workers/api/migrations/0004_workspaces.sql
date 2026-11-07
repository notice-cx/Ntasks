-- Migration number: 0004 	 2026-11-07T16:30:00.000Z

-- Workspaces: one deployment holds several, and each keeps its tasks in its
-- own task store, the Durable Object named 'workspace:' followed by the
-- workspace's id. docs/sign-in.md describes the tables and how a request
-- reaches one workspace.
--
-- A person belongs to a workspace through a membership, as its owner or a
-- member. An agent's project grants and a service credential each name the
-- workspace they reach. An invitation names a GitHub login that may join a
-- workspace; it becomes a membership bound to that account's user once the
-- account signs in.

CREATE TABLE workspaces (
  -- A UUID, lowercase.
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*'),
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

-- The grant and credential tables are made again with the workspace they
-- belong to. Rows made before workspaces name none, and no deployment holds
-- any, so they are dropped rather than moved.
DROP TABLE access_agent_grants;
DROP TABLE access_service_grants;
DROP TABLE access_service_credentials;

-- The projects an agent may reach for the person who approved it, chosen on
-- the approval page, each in its workspace. An agent reaches a workspace's
-- project only while that person is a member of the workspace.
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
-- read the whole workspace's store for a backup, and restore load rows into
-- that store while it is empty.
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
