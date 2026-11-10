-- Migration number: 0004 	 2026-11-10T02:30:00.000Z

-- The time zone a person chose in Settings, an IANA name such as
-- America/Los_Angeles: the web app shows every date in it. Null leaves it to
-- the browser's own. The Worker checks the name before it writes one
-- (PATCH /api/access/me).
ALTER TABLE auth_user ADD COLUMN time_zone TEXT
  CHECK (time_zone IS NULL OR length(time_zone) BETWEEN 1 AND 64);
