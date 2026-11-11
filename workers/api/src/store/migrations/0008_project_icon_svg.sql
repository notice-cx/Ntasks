-- A project's icon may also be an SVG, kept only once the Worker made it
-- safe (workers/api/src/svg-icon.ts). SQLite cannot change a CHECK in place,
-- so project_icons is rebuilt with the new type and every icon it held copied
-- over. No other table refers to it, and it has no trigger or index of its own.
CREATE TABLE project_icons_next (
  project_id TEXT PRIMARY KEY REFERENCES projects (id),
  -- The address the icon was read from, after redirects.
  source_url TEXT NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2048),
  content_type TEXT NOT NULL CHECK (
    content_type IN ('image/png', 'image/x-icon', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml')
  ),
  bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 102400),
  read_at TEXT NOT NULL
) STRICT;

INSERT INTO project_icons_next (project_id, source_url, content_type, bytes, read_at)
  SELECT project_id, source_url, content_type, bytes, read_at FROM project_icons;

DROP TABLE project_icons;
ALTER TABLE project_icons_next RENAME TO project_icons;
