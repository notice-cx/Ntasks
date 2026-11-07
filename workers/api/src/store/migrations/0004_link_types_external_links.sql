-- Two more link types, which record a link and hold nothing out of ready
-- work: `duplicates`, where task_id is the same work filed again as
-- depends_on_id, and `supersedes`, where task_id replaces depends_on_id.
-- SQLite cannot change a CHECK in place, so task_edges is copied into a new
-- table with the longer list, and its index is made again.
CREATE TABLE task_edges_next (
  task_id TEXT NOT NULL REFERENCES tasks (id),
  depends_on_id TEXT NOT NULL REFERENCES tasks (id),
  type TEXT NOT NULL CHECK (type IN ('blocks', 'related', 'discovered-from', 'duplicates', 'supersedes')),
  created_at TEXT NOT NULL,
  created_by TEXT CHECK (created_by IS NULL OR length(created_by) BETWEEN 1 AND 255),
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
) STRICT, WITHOUT ROWID;

INSERT INTO task_edges_next (task_id, depends_on_id, type, created_at, created_by)
  SELECT task_id, depends_on_id, type, created_at, created_by FROM task_edges;

DROP TABLE task_edges;

ALTER TABLE task_edges_next RENAME TO task_edges;

CREATE INDEX task_edges_by_dependency ON task_edges (depends_on_id, type);

-- A task's links to pages outside Ntasks, such as a pull request or a
-- document: the URL, the title shown for it, and optionally what kind of page
-- it is. A task links to a URL once. The engine writes a URL as the URL
-- standard does, so the same page is one URL. The primary key reaches a
-- task's links, which every read of a task returns. The API accepts at most
-- 32 links on a task and 512 characters in a title (TASK_LIMITS).
CREATE TABLE task_external_links (
  task_id TEXT NOT NULL REFERENCES tasks (id),
  url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2048 AND (url GLOB 'http://*' OR url GLOB 'https://*')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 1024),
  kind TEXT CHECK (kind IS NULL OR kind IN ('pull-request', 'document', 'other')),
  created_at TEXT NOT NULL,
  created_by TEXT CHECK (created_by IS NULL OR length(created_by) BETWEEN 1 AND 255),
  PRIMARY KEY (task_id, url)
) STRICT, WITHOUT ROWID;
