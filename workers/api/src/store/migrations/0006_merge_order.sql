-- A link that records the order two pull requests land in: web-4
-- `merges-after` web-1 means web-4's pull request merges only once web-1's
-- has. It holds no work back; only `blocks` does. SQLite cannot change a
-- CHECK in place, so task_edges is rebuilt with the new type and every link
-- it held copied over. No other table refers to it, and it has no trigger.
CREATE TABLE task_edges_next (
  task_id TEXT NOT NULL REFERENCES tasks (id),
  depends_on_id TEXT NOT NULL REFERENCES tasks (id),
  type TEXT NOT NULL CHECK (type IN ('blocks', 'related', 'discovered-from', 'duplicates', 'supersedes', 'merges-after')),
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
