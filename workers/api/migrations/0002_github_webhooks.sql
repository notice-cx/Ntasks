-- Migration number: 0002 	 2026-11-09T23:30:00.000Z

-- A workspace's GitHub webhook: what the receiver at /api/github/<workspace
-- id> checks each delivery against, and the deploys it treats as a change
-- going live. Its owner sets it in the web app's Settings
-- (POST /api/access/github); docs/api.md describes the receiver.
CREATE TABLE access_github_webhooks (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces (id),
  -- The secret GitHub signs each delivery with, encrypted under a key
  -- derived from AUTH_SECRET: the receiver needs the secret itself to check
  -- a signature, so it cannot be stored as a hash. After AUTH_SECRET changes
  -- it no longer decrypts, and every delivery is refused until the owner
  -- saves the secret again.
  secret TEXT NOT NULL CHECK (length(secret) BETWEEN 1 AND 2048),
  -- The names of the check runs and deployment environments whose success
  -- means a change is live, as a JSON list of strings.
  deploy_checks TEXT NOT NULL CHECK (json_valid(deploy_checks) AND json_type(deploy_checks) = 'array'),
  updated_by TEXT NOT NULL REFERENCES auth_user (id),
  updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
