-- A task can move to another project. It then takes an id with that project's
-- prefix, so a task id's prefix still names its project, and its old id stays
-- its former id: every lookup that names the old id finds the task. Nothing
-- here changes a row a store already holds.

-- Each former id and the task it names now. A task that moves again keeps
-- every former id, each naming its current id. A former id is never removed,
-- and never becomes another task's id.
CREATE TABLE task_aliases (
  alias TEXT PRIMARY KEY CHECK (length(alias) BETWEEN 3 AND 255 AND alias NOT GLOB '*[^a-z0-9.-]*'),
  task_id TEXT NOT NULL REFERENCES tasks (id),
  CHECK (alias <> task_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX task_aliases_by_task ON task_aliases (task_id);

-- A task keeps its creation time. It keeps its id and project too, except in
-- a move to another project, where it takes an id that starts with that
-- project's prefix and is no task's former id.
DROP TRIGGER tasks_identity_fixed;
CREATE TRIGGER tasks_identity_fixed BEFORE UPDATE ON tasks
WHEN NEW.created_at IS NOT OLD.created_at
  OR ((NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id) AND NOT (
    NEW.id IS NOT OLD.id AND NEW.project_id IS NOT OLD.project_id
    AND EXISTS (SELECT 1 FROM projects p WHERE p.id = NEW.project_id AND NEW.id GLOB p.prefix || '-*')
    AND NOT EXISTS (SELECT 1 FROM task_aliases WHERE alias = NEW.id)))
BEGIN
  SELECT raise(ABORT, 'ntasks: a task keeps its id, project and creation time, but for a move to another project under an id with its prefix');
END;

-- A move records the old id as a former id, and everything filed under the
-- task follows it to its new id: its former ids, labels, links both ways,
-- external links, comments and history. Other tasks' parent and duplicate
-- columns are the engine's to change, each with a version and a history
-- event of its own, so the write that moves a task defers foreign keys.
CREATE TRIGGER tasks_moved AFTER UPDATE OF id ON tasks
WHEN NEW.id IS NOT OLD.id
BEGIN
  INSERT INTO task_aliases (alias, task_id) VALUES (OLD.id, NEW.id);
  UPDATE task_aliases SET task_id = NEW.id WHERE task_id = OLD.id;
  UPDATE task_labels SET task_id = NEW.id WHERE task_id = OLD.id;
  UPDATE task_edges SET task_id = NEW.id WHERE task_id = OLD.id;
  UPDATE task_edges SET depends_on_id = NEW.id WHERE depends_on_id = OLD.id;
  UPDATE task_external_links SET task_id = NEW.id WHERE task_id = OLD.id;
  UPDATE task_comments SET task_id = NEW.id WHERE task_id = OLD.id;
  UPDATE task_events SET task_id = NEW.id WHERE task_id = OLD.id;
END;

-- A new task never takes a former id, so an old id never names two tasks.
CREATE TRIGGER tasks_former_id_kept BEFORE INSERT ON tasks
WHEN EXISTS (SELECT 1 FROM task_aliases WHERE alias = NEW.id)
BEGIN
  SELECT raise(ABORT, 'ntasks: this id is a moved task''s former id');
END;

CREATE TRIGGER task_aliases_former BEFORE INSERT ON task_aliases
WHEN EXISTS (SELECT 1 FROM tasks WHERE id = NEW.alias)
BEGIN
  SELECT raise(ABORT, 'ntasks: a former id is no task''s current id');
END;

-- A former id changes only the task id it names, and only to the id that
-- task moved to.
CREATE TRIGGER task_aliases_fixed BEFORE UPDATE ON task_aliases
WHEN NEW.alias IS NOT OLD.alias
  OR NOT EXISTS (SELECT 1 FROM task_aliases WHERE alias = OLD.task_id AND task_id = NEW.task_id)
BEGIN
  SELECT raise(ABORT, 'ntasks: a former id names the task it moved to');
END;

CREATE TRIGGER task_aliases_kept BEFORE DELETE ON task_aliases
BEGIN
  SELECT raise(ABORT, 'ntasks: a former id is never removed');
END;

-- History and comments are still never edited. The one change either takes
-- beyond unpinning is following its task's move to the task's new id; each
-- history event keeps the project the task was in when it was recorded.
DROP TRIGGER task_events_fixed;
CREATE TRIGGER task_events_fixed BEFORE UPDATE ON task_events
WHEN NEW.seq IS NOT OLD.seq OR NEW.project_id IS NOT OLD.project_id OR NEW.version IS NOT OLD.version
  OR NEW.kind IS NOT OLD.kind OR NEW.actor IS NOT OLD.actor OR NEW.model IS NOT OLD.model
  OR NEW.at IS NOT OLD.at OR NEW.changes IS NOT OLD.changes
  OR NOT EXISTS (SELECT 1 FROM task_aliases WHERE alias = OLD.task_id AND task_id = NEW.task_id)
BEGIN
  SELECT raise(ABORT, 'ntasks: history is never edited');
END;

DROP TRIGGER task_comments_fixed;
CREATE TRIGGER task_comments_fixed BEFORE UPDATE ON task_comments
WHEN NEW.id IS NOT OLD.id OR NEW.author IS NOT OLD.author OR NEW.text IS NOT OLD.text
  OR NEW.created_at IS NOT OLD.created_at OR NEW.pinned > OLD.pinned
  OR (NEW.task_id IS NOT OLD.task_id
    AND NOT EXISTS (SELECT 1 FROM task_aliases WHERE alias = OLD.task_id AND task_id = NEW.task_id))
BEGIN
  SELECT raise(ABORT, 'ntasks: comments are never edited');
END;
