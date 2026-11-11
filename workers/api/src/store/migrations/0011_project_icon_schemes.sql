-- A project keeps an icon for each colour scheme its website declares one
-- for: light, which any page may draw, and dark, for a dark page. SQLite
-- cannot change a primary key in place, so project_icons is rebuilt keyed by
-- project and scheme, and every icon it held is copied over as the project's
-- light icon. No other table refers to it, and it has no trigger or index of
-- its own.
CREATE TABLE project_icons_next (
  project_id TEXT NOT NULL REFERENCES projects (id),
  scheme TEXT NOT NULL CHECK (scheme IN ('light', 'dark')),
  -- The address the icon was read from, after redirects.
  source_url TEXT NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2048),
  content_type TEXT NOT NULL CHECK (
    content_type IN ('image/png', 'image/x-icon', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml')
  ),
  bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 102400),
  read_at TEXT NOT NULL,
  PRIMARY KEY (project_id, scheme)
) STRICT;

INSERT INTO project_icons_next (project_id, scheme, source_url, content_type, bytes, read_at)
  SELECT project_id, 'light', source_url, content_type, bytes, read_at FROM project_icons;

DROP TABLE project_icons;
ALTER TABLE project_icons_next RENAME TO project_icons;
