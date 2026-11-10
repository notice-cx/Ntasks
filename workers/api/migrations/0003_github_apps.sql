-- Migration number: 0003 	 2026-11-10T00:00:00.000Z

-- A workspace's GitHub App: the app its owner creates with Connect GitHub on
-- the web app's Settings page, through GitHub's manifest flow, and installs
-- on their account and organizations. Every repository of an installation
-- then sends its events to /api/github/<workspace id>; docs/api.md describes
-- the receiver.
CREATE TABLE access_github_apps (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces (id),
  app_id INTEGER NOT NULL CHECK (app_id > 0),
  -- The app's name in GitHub's addresses, such as github.com/apps/<slug>.
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 100),
  -- The webhook secret GitHub signs each delivery with and the app's
  -- private key, as JSON encrypted under a key derived from AUTH_SECRET.
  -- After AUTH_SECRET changes it no longer decrypts, and the owner connects
  -- GitHub again.
  credentials TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES auth_user (id),
  created_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- The installations of a workspace's app that an owner of the workspace
-- made, as GitHub's installation event names them. A delivery from any other
-- installation of the app is refused, since anyone can install a public app.
CREATE TABLE access_github_installations (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  installation_id INTEGER NOT NULL CHECK (installation_id > 0),
  -- The GitHub account it is installed on: its login and its type, such as
  -- User or Organization.
  account TEXT NOT NULL CHECK (length(account) BETWEEN 1 AND 100),
  account_type TEXT NOT NULL CHECK (length(account_type) BETWEEN 1 AND 32),
  -- The numeric GitHub id of the owner who installed it.
  installed_by TEXT NOT NULL CHECK (
    length(installed_by) BETWEEN 1 AND 20 AND installed_by NOT GLOB '*[^0-9]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, installation_id)
) STRICT, WITHOUT ROWID;

-- What GitHub's deliveries showed a workspace, so nobody types it: a deploy
-- check (kind 'check'), the name of a check run or deployment environment
-- that counted as a deploy, and a project whose changes go live by a deploy
-- (kind 'project', name holding the project's id), whose setting a deploy
-- turned on. A check the owner switched off has off = 1 and counts no more.
-- A project is turned on once: when the owner turns it off again, it stays off.
CREATE TABLE access_github_detected (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  kind TEXT NOT NULL CHECK (kind IN ('check', 'project')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  off INTEGER NOT NULL DEFAULT 0 CHECK (off IN (0, 1)),
  seen_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, kind, name)
) STRICT, WITHOUT ROWID;
