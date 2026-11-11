-- What an owner sets for a project in the web app's Settings: whether it takes
-- new tasks, and its website, whose icon the web app shows for it.

-- When an owner disabled the project. A disabled project takes no new tasks,
-- and the web app leaves it out of its sidebar and board; its tasks stay
-- readable. Null while it is enabled, as every project a store holds starts.
ALTER TABLE projects ADD COLUMN disabled_at TEXT CHECK (disabled_at IS NULL OR length(disabled_at) BETWEEN 20 AND 30);

-- The project's website, an http or https URL as the URL standard writes it.
ALTER TABLE projects ADD COLUMN website_url TEXT CHECK (
  website_url IS NULL OR (length(website_url) <= 2048 AND (website_url GLOB 'https://*' OR website_url GLOB 'http://*'))
);

-- The icon the Worker read from a project's website when the website was set,
-- kept so no page reads the website again. One row per project: a new website
-- replaces it, and a website with no icon the Worker can serve leaves none.
-- The bytes are always a raster image whose type the Worker checked from the
-- bytes themselves, never an SVG. A backup leaves the table out: it is a copy
-- of what the website serves, read again when the website is saved again.
CREATE TABLE project_icons (
  project_id TEXT PRIMARY KEY REFERENCES projects (id),
  -- The address the icon was read from, after redirects.
  source_url TEXT NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2048),
  content_type TEXT NOT NULL CHECK (
    content_type IN ('image/png', 'image/x-icon', 'image/jpeg', 'image/gif', 'image/webp')
  ),
  bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 102400),
  read_at TEXT NOT NULL
) STRICT;
