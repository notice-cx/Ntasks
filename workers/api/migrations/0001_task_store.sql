-- Migration number: 0001 	 2026-11-06T17:55:06.376Z

-- The task store: projects, their tasks, and everything recorded about a task.
-- docs/task-store.md describes each table and the rules below. Sign-in and
-- access have their own migration.
--
-- Times are UTC ISO 8601 text with milliseconds, such as
-- 2026-11-06T17:55:06.376Z, so they sort correctly as text.
--
-- Length limits here are a storage backstop. Names, such as an assignee, a
-- label or a model, allow 255 characters, as Beads' columns do; a title
-- allows 1024, above Beads' 500; long text has no limit here, as in Beads.
-- So a task imported from Beads always fits. The API accepts less in a new
-- write: TASK_LIMITS in packages/domain.

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  -- The name people know the project by, such as a domain or a repository.
  key TEXT NOT NULL UNIQUE CHECK (length(key) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  -- Starts every task id in the project. Lowercase ASCII letters and digits
  -- with no hyphen, so a task id's prefix always ends at its first hyphen.
  prefix TEXT NOT NULL UNIQUE CHECK (length(prefix) BETWEEN 1 AND 32 AND prefix NOT GLOB '*[^a-z0-9]*'),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 255 AND id NOT GLOB '*[^a-z0-9.-]*'),
  project_id TEXT NOT NULL REFERENCES projects (id),
  parent_id TEXT REFERENCES tasks (id),
  type TEXT NOT NULL CHECK (type IN ('task', 'bug', 'feature', 'epic', 'chore', 'decision', 'gate')),
  -- A gate is an approval that a task waits on; await_type names who answers it.
  await_type TEXT CHECK (await_type IS NULL OR (type = 'gate' AND await_type = 'human')),
  status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'blocked', 'deferred', 'closed')),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 4),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 1024),
  description TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '',
  assignee TEXT CHECK (assignee IS NULL OR length(assignee) BETWEEN 1 AND 255),
  -- The model the assignee named when it claimed the task.
  assignee_model TEXT CHECK (assignee_model IS NULL OR length(assignee_model) BETWEEN 1 AND 255),
  defer_until TEXT,
  due_at TEXT,
  -- A decision's options, and the option a person chose, as JSON objects.
  choices TEXT CHECK (choices IS NULL OR (json_valid(choices) AND json_type(choices) = 'object')),
  choice TEXT CHECK (choice IS NULL OR (choices IS NOT NULL AND json_valid(choice) AND json_type(choice) = 'object')),
  -- Fields that other systems attach, as one JSON object Ntasks stores as given.
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata) AND json_type(metadata) = 'object'),
  -- Who filed the task, and with which model. Null on a task imported without them.
  filed_by TEXT CHECK (filed_by IS NULL OR length(filed_by) BETWEEN 1 AND 255),
  filed_model TEXT CHECK (filed_model IS NULL OR length(filed_model) BETWEEN 1 AND 255),
  -- How the current close ended. All null while the task is not closed;
  -- earlier closes stay in task_events.
  close_reason TEXT,
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('done', 'wont-do', 'duplicate', 'cant-reproduce', 'already-handled', 'no-longer-needed')),
  duplicate_of TEXT REFERENCES tasks (id),
  closed_by TEXT CHECK (closed_by IS NULL OR length(closed_by) BETWEEN 1 AND 255),
  closed_model TEXT CHECK (closed_model IS NULL OR length(closed_model) BETWEEN 1 AND 255),
  -- Raised by one with every change, so a write can name the version it read.
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  closed_at TEXT,
  -- A closed task records when and how it closed, and any other task records
  -- no close at all, so a reopen cannot leave part of the old close behind.
  CHECK (status <> 'closed' OR (closed_at IS NOT NULL AND resolution IS NOT NULL)),
  CHECK (status = 'closed' OR (closed_at IS NULL AND resolution IS NULL AND close_reason IS NULL
    AND duplicate_of IS NULL AND closed_by IS NULL AND closed_model IS NULL)),
  CHECK (duplicate_of IS NULL OR resolution = 'duplicate'),
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;

CREATE INDEX tasks_by_project_status ON tasks (project_id, status, priority, created_at);
CREATE INDEX tasks_by_project_closed ON tasks (project_id, closed_at) WHERE closed_at IS NOT NULL;
CREATE INDEX tasks_by_parent ON tasks (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX tasks_by_assignee ON tasks (assignee) WHERE assignee IS NOT NULL;

CREATE TABLE task_labels (
  task_id TEXT NOT NULL REFERENCES tasks (id),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 255),
  PRIMARY KEY (task_id, label)
) STRICT, WITHOUT ROWID;

CREATE INDEX task_labels_by_label ON task_labels (label, task_id);

-- A link between two tasks: task_id depends on depends_on_id. `blocks` keeps
-- task_id out of ready work until depends_on_id closes; `related` and
-- `discovered-from` only record the link. A task's parent is tasks.parent_id,
-- not an edge.
CREATE TABLE task_edges (
  task_id TEXT NOT NULL REFERENCES tasks (id),
  depends_on_id TEXT NOT NULL REFERENCES tasks (id),
  type TEXT NOT NULL CHECK (type IN ('blocks', 'related', 'discovered-from')),
  created_at TEXT NOT NULL,
  created_by TEXT CHECK (created_by IS NULL OR length(created_by) BETWEEN 1 AND 255),
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX task_edges_by_dependency ON task_edges (depends_on_id, type);

CREATE TABLE task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  author TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 255),
  text TEXT NOT NULL CHECK (length(text) >= 1),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX task_comments_by_task ON task_comments (task_id, created_at);

-- Every change to a task, in order. seq orders the changes of the whole
-- installation and is never reused, so a client can ask for every change
-- after the last one it saw.
CREATE TABLE task_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  project_id TEXT NOT NULL REFERENCES projects (id),
  -- The task's version after this change; a comment leaves it unchanged.
  version INTEGER NOT NULL CHECK (version >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('created', 'updated', 'closed', 'reopened', 'commented')),
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 255),
  model TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 255),
  at TEXT NOT NULL,
  -- What the change set, as an object of field names and their new values.
  -- The created event holds every field, so applying a task's events in
  -- order rebuilds the task as it stood at any version.
  changes TEXT NOT NULL CHECK (json_valid(changes) AND json_type(changes) = 'object')
) STRICT;

CREATE INDEX task_events_by_task ON task_events (task_id, seq);
CREATE INDEX task_events_by_project ON task_events (project_id, seq);

-- Retry records. A write that carries an idempotency key records, in the
-- same batch, the request it was and the answer it gave. The same key with
-- the same request gets that answer again; with a different request it is
-- refused. Records older than seven days are removed.
CREATE TABLE write_receipts (
  principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 128),
  operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 64),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  project_id TEXT NOT NULL REFERENCES projects (id),
  -- SHA-256 of the canonical request, as 64 hexadecimal characters.
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  result TEXT NOT NULL CHECK (json_valid(result)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal, operation, idempotency_key)
) STRICT, WITHOUT ROWID;

CREATE INDEX write_receipts_by_age ON write_receipts (created_at);

-- Rules the database enforces whatever code writes to it.

-- Every change to a task raises its version by exactly one, so two writers
-- that read the same version cannot both succeed.
CREATE TRIGGER tasks_version_rises BEFORE UPDATE ON tasks
WHEN NEW.version IS NOT OLD.version + 1
BEGIN
  SELECT raise(ABORT, 'ntasks: a task update must raise its version by one');
END;

-- A task keeps its id, its project and when it was created.
CREATE TRIGGER tasks_identity_fixed BEFORE UPDATE ON tasks
WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT raise(ABORT, 'ntasks: a task keeps its id, project and creation time');
END;

-- Tasks, their history and their comments are never deleted, and history and
-- comments are never edited.
CREATE TRIGGER tasks_kept BEFORE DELETE ON tasks
BEGIN
  SELECT raise(ABORT, 'ntasks: tasks are never deleted');
END;

CREATE TRIGGER task_events_kept BEFORE DELETE ON task_events
BEGIN
  SELECT raise(ABORT, 'ntasks: history is never deleted');
END;

CREATE TRIGGER task_events_fixed BEFORE UPDATE ON task_events
BEGIN
  SELECT raise(ABORT, 'ntasks: history is never edited');
END;

CREATE TRIGGER task_comments_kept BEFORE DELETE ON task_comments
BEGIN
  SELECT raise(ABORT, 'ntasks: comments are never deleted');
END;

CREATE TRIGGER task_comments_fixed BEFORE UPDATE ON task_comments
BEGIN
  SELECT raise(ABORT, 'ntasks: comments are never edited');
END;

-- The write guard. Every write runs as one batch, and D1 rolls back a whole
-- batch when any statement in it fails. Right after a statement that must
-- change exactly one row, such as an update that names the version it read,
-- the engine inserts into this view whether it did, and the refusal to
-- report if not:
--
--   INSERT INTO write_guard (ok, refusal) VALUES (changes() = 1, 'version_conflict');
--
-- A false `ok` fails the insert with "ntasks refused: <refusal>", so nothing
-- in the batch is written. The view stores nothing. The refusals are the
-- ones TASK_REFUSALS in packages/domain lists for the guard.
CREATE VIEW write_guard (ok, refusal) AS SELECT 1, 'none' WHERE 0;

CREATE TRIGGER write_guard_check INSTEAD OF INSERT ON write_guard
BEGIN
  SELECT CASE NEW.refusal
    WHEN 'not_found' THEN raise(ABORT, 'ntasks refused: not_found')
    WHEN 'version_conflict' THEN raise(ABORT, 'ntasks refused: version_conflict')
    WHEN 'cycle' THEN raise(ABORT, 'ntasks refused: cycle')
    ELSE raise(ABORT, 'ntasks refused: unknown guard refusal')
  END
  WHERE NOT NEW.ok;
END;
