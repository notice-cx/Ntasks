-- Migration number: 0001 	 2026-11-06T17:55:06.376Z

-- The task store: projects, their tasks, and everything recorded about a task.
-- docs/task-store.md describes each table and the rules below. Sign-in and
-- the workspaces are in D1, with their own migrations in workers/api/migrations.
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
  created_at TEXT NOT NULL,
  -- Whether the project's changes go live by a deploy. For one that does
  -- not, merged is the last stage of a task's delivery.
  deploys INTEGER NOT NULL DEFAULT 0 CHECK (deploys IN (0, 1))
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
  -- The task's notes and design: Markdown beside its description and
  -- acceptance, with no length limit here, as description has none. And its
  -- estimate, in whole minutes, null when nobody estimated it.
  notes TEXT NOT NULL DEFAULT '',
  design TEXT NOT NULL DEFAULT '',
  estimate_minutes INTEGER CHECK (estimate_minutes IS NULL OR estimate_minutes >= 0),
  -- The task's values of its project's custom fields, as one JSON object by
  -- field key: text, a number, true or false, or a list of options. They are
  -- part of the task's row, so a read of the task, or a filter on a task a
  -- read already reached, reads no other row.
  field_values TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(field_values) AND json_type(field_values) = 'object'),
  -- The task's delivery (docs/concepts.md): the commit and pull request it
  -- closed with, the commit that merged it, when it reached each stage, and
  -- its stage, built, merged or live. A commit is 7 to 64 lowercase
  -- hexadecimal characters; a pull request is an http or https URL.
  delivery_commit TEXT
    CHECK (delivery_commit IS NULL OR (length(delivery_commit) BETWEEN 7 AND 64 AND delivery_commit NOT GLOB '*[^0-9a-f]*')),
  delivery_pull_request TEXT
    CHECK (delivery_pull_request IS NULL OR (length(delivery_pull_request) BETWEEN 1 AND 2048
      AND (delivery_pull_request GLOB 'http://*' OR delivery_pull_request GLOB 'https://*'))),
  delivery_merge_commit TEXT
    CHECK (delivery_merge_commit IS NULL OR (length(delivery_merge_commit) BETWEEN 7 AND 64
      AND delivery_merge_commit NOT GLOB '*[^0-9a-f]*')),
  built_at TEXT,
  merged_at TEXT,
  live_at TEXT,
  -- Only a task closed as done with a commit or a pull request has a stage,
  -- and a task without one records no delivery at all, so a reopen, which
  -- clears the stage, leaves nothing of it behind; the earlier delivery stays
  -- in task_events. A merged task records when it merged, and only a live one
  -- when it went live. A task can go live from built, so merged_at stays null
  -- when no signal said it merged.
  delivery_stage TEXT CHECK (
    (delivery_stage IS NULL AND delivery_commit IS NULL AND delivery_pull_request IS NULL
      AND delivery_merge_commit IS NULL AND built_at IS NULL AND merged_at IS NULL AND live_at IS NULL)
    OR (delivery_stage IN ('built', 'merged', 'live') AND status = 'closed' AND resolution = 'done'
      AND (delivery_commit IS NOT NULL OR delivery_pull_request IS NOT NULL) AND built_at IS NOT NULL
      AND (delivery_stage <> 'built' OR (delivery_merge_commit IS NULL AND merged_at IS NULL))
      AND (delivery_stage <> 'merged' OR merged_at IS NOT NULL)
      AND (live_at IS NOT NULL) = (delivery_stage = 'live'))),
  -- The task's live work: the helper agent its holder works through, and the
  -- details the holder records about the work in hand (a session, worktree,
  -- branch, pull request, commit and next step), as one JSON object of text
  -- by detail name. Both are empty while nobody holds the task or once it
  -- closes, so a release or a close cannot leave an earlier holder's work
  -- behind; its history keeps every change to them. The API accepts less in
  -- a new write: WORK_LIMITS in packages/domain.
  assignee_for TEXT
    CHECK (assignee_for IS NULL OR (length(assignee_for) BETWEEN 1 AND 255 AND assignee IS NOT NULL AND status <> 'closed')),
  work TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(work) AND json_type(work) = 'object' AND length(work) <= 8192
      AND (json(work) = '{}' OR (assignee IS NOT NULL AND status <> 'closed'))),
  -- A close as done may name a link: an http or https URL that shows the
  -- work, for work that left no commit or pull request, such as a document.
  -- Only a task closed as done has one, so a reopen, which clears the close,
  -- clears it too; the earlier close keeps it in task_events.
  close_link TEXT
    CHECK (close_link IS NULL OR (status = 'closed' AND resolution = 'done' AND length(close_link) BETWEEN 1 AND 2048
      AND (close_link GLOB 'http://*' OR close_link GLOB 'https://*'))),
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
-- The earliest time any task stops being deferred, closed tasks included: a
-- closed parent's deferral still holds its open children out of ready work.
-- The task store reads it after each write to know how long its cached reads
-- stay true (src/store/cache.ts); this index answers it from one entry.
CREATE INDEX tasks_by_defer_until ON tasks (defer_until) WHERE defer_until IS NOT NULL;
-- A delivery signal names pull requests and commits; these reach the tasks
-- that carry them without reading any other task. A commit matches by
-- prefix, so a signal reads a range of the commit index.
CREATE INDEX tasks_by_delivery_pull_request ON tasks (delivery_pull_request) WHERE delivery_pull_request IS NOT NULL;
CREATE INDEX tasks_by_delivery_commit ON tasks (delivery_commit) WHERE delivery_commit IS NOT NULL;
CREATE INDEX tasks_by_delivery_merge_commit ON tasks (delivery_merge_commit) WHERE delivery_merge_commit IS NOT NULL;
-- A project's closed tasks at a stage, whenever they closed.
CREATE INDEX tasks_by_project_stage ON tasks (project_id, delivery_stage) WHERE delivery_stage IS NOT NULL;

CREATE TABLE task_labels (
  task_id TEXT NOT NULL REFERENCES tasks (id),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 255),
  PRIMARY KEY (task_id, label)
) STRICT, WITHOUT ROWID;

CREATE INDEX task_labels_by_label ON task_labels (label, task_id);

-- A link between two tasks: task_id depends on depends_on_id. `blocks` keeps
-- task_id out of ready work until depends_on_id closes. The others only
-- record the link: `related`, `discovered-from`, `duplicates`, where task_id
-- is the same work filed again as depends_on_id, and `supersedes`, where
-- task_id replaces depends_on_id. A task's parent is tasks.parent_id, not an
-- edge.
CREATE TABLE task_edges (
  task_id TEXT NOT NULL REFERENCES tasks (id),
  depends_on_id TEXT NOT NULL REFERENCES tasks (id),
  type TEXT NOT NULL CHECK (type IN ('blocks', 'related', 'discovered-from', 'duplicates', 'supersedes')),
  created_at TEXT NOT NULL,
  created_by TEXT CHECK (created_by IS NULL OR length(created_by) BETWEEN 1 AND 255),
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
) STRICT, WITHOUT ROWID;

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

-- Custom fields: each project defines its own, and its tasks carry values of
-- them in tasks.field_values.
CREATE TABLE custom_fields (
  project_id TEXT NOT NULL REFERENCES projects (id),
  -- Names the field in a task's values and in filters: a lowercase letter,
  -- then lowercase letters, digits, underscores or hyphens.
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 64 AND key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z0-9_-]*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  type TEXT NOT NULL CHECK (type IN ('text', 'number', 'date', 'single-choice', 'multiple-choice', 'url', 'yes-no')),
  -- A choice field's options in order, as a JSON array of text; null for any other type.
  options TEXT CHECK (options IS NULL OR (json_valid(options) AND json_type(options) = 'array')),
  created_at TEXT NOT NULL,
  created_by TEXT CHECK (created_by IS NULL OR length(created_by) BETWEEN 1 AND 255),
  -- A retired field takes no new values; the values tasks carry stay. The
  -- engine refuses a new value in the same batch as the write, not the
  -- database, so an import can load a retired field with the values it had.
  retired_at TEXT,
  retired_by TEXT CHECK (retired_by IS NULL OR length(retired_by) BETWEEN 1 AND 255),
  PRIMARY KEY (project_id, key),
  CHECK ((type IN ('single-choice', 'multiple-choice')) = (options IS NOT NULL)),
  CHECK (retired_at IS NOT NULL OR retired_by IS NULL)
) STRICT, WITHOUT ROWID;

CREATE TABLE task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  author TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 255),
  text TEXT NOT NULL CHECK (length(text) >= 1),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX task_comments_by_task ON task_comments (task_id, created_at);

-- Every change to a task, in order. seq orders the changes of the whole
-- store and is never reused, so a client can ask for every change after the
-- last one it saw.
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
-- A task's last activity is when its holder last wrote to it: the latest
-- history event the holder made. This index answers that with one entry per
-- task, however long its history.
CREATE INDEX task_events_by_actor ON task_events (task_id, actor, at);

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

-- A custom field keeps its project, key, type and options, stays retired
-- once retired, and is never deleted, so the values and history that name
-- it keep their meaning.
CREATE TRIGGER custom_fields_fixed BEFORE UPDATE ON custom_fields
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.key IS NOT OLD.key OR NEW.type IS NOT OLD.type
  OR NEW.options IS NOT OLD.options OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT OLD.retired_at)
BEGIN
  SELECT raise(ABORT, 'ntasks: a field keeps its key, type and options, and stays retired');
END;

CREATE TRIGGER custom_fields_kept BEFORE DELETE ON custom_fields
BEGIN
  SELECT raise(ABORT, 'ntasks: fields are never deleted');
END;

-- The write guard. The store runs every write as one transaction, and rolls
-- the whole transaction back when any statement in it fails. Right after a
-- statement that must change exactly one row, such as an update that names
-- the version it read, the engine inserts into this view whether it did, and
-- the refusal to report if not:
--
--   INSERT INTO write_guard (ok, refusal) VALUES (changes() = 1, 'version_conflict');
--
-- A false `ok` fails the insert with "ntasks refused: <refusal>", so nothing
-- in the write is stored. The view stores nothing. The refusals are the ones
-- TASK_REFUSALS in packages/domain lists for the guard.
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
