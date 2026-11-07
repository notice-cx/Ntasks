-- A load into an empty store, sent in pages (src/store/load.ts). The owner
-- begins a load, which names it; each page of rows waits in
-- store_load_pages until the owner commits the load, which inserts every
-- waiting row into its table in one transaction and removes the load. So a
-- load lands whole or not at all, and nothing but the load reads these
-- tables. At most one load waits at a time.
CREATE TABLE store_loads (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  started_at TEXT NOT NULL,
  started_by TEXT NOT NULL CHECK (length(started_by) BETWEEN 1 AND 255)
) STRICT;

-- One page: rows of one table, as a JSON array of objects that each hold
-- every column of the table. Pages are numbered in the order they arrived.
CREATE TABLE store_load_pages (
  load_id TEXT NOT NULL REFERENCES store_loads (id) ON DELETE CASCADE,
  page INTEGER NOT NULL CHECK (page >= 1),
  table_name TEXT NOT NULL CHECK (length(table_name) BETWEEN 1 AND 64),
  rows TEXT NOT NULL CHECK (json_valid(rows) AND json_type(rows) = 'array'),
  PRIMARY KEY (load_id, page)
) STRICT, WITHOUT ROWID;
