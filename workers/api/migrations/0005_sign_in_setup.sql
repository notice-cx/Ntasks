-- Migration number: 0005 	 2026-11-07T18:00:00.000Z

-- The setup page on /sign-in: a deployment that sets no GitHub secrets
-- registers a GitHub App from a manifest there, and keeps it here.
-- docs/sign-in.md describes the setup and these tables.

-- The GitHub App people sign in through. One row: a deployment signs in
-- through one app, and two setups that finish at once store one of them.
CREATE TABLE access_github_app (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- The origin the setup ran at, such as https://ntasks.example.com: the
  -- OAuth issuer, the callback address and the cookies are bound to it.
  origin TEXT NOT NULL CHECK (length(origin) BETWEEN 1 AND 255),
  -- The app's client id and client secret, as JSON encrypted under a key
  -- derived from AUTH_SECRET. After AUTH_SECRET changes it no longer
  -- decrypts, and the setup page replaces the row.
  credentials TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

-- The deployment admins the setup page recorded: the GitHub account that
-- registered the app, by its numeric id. They are admins beside the ids in
-- OWNER_GITHUB_IDS, and stay admins when the app is replaced.
CREATE TABLE access_deployment_admins (
  github_id TEXT PRIMARY KEY CHECK (length(github_id) BETWEEN 1 AND 20 AND github_id NOT GLOB '*[^0-9]*'),
  created_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
