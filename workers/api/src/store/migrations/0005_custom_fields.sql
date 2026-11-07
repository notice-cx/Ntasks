-- Custom fields: each project defines its own, and its tasks carry values of
-- them. docs/task-store.md describes the table and its rules. The API accepts
-- less in a new write: TASK_LIMITS in packages/domain.
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

-- A task's values of its project's fields, as one JSON object by field key:
-- text, a number, true or false, or a list of options. They are part of the
-- task's row, so a read of the task, or a filter on a task a read already
-- reached, reads no other row.
ALTER TABLE tasks ADD COLUMN field_values TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(field_values) AND json_type(field_values) = 'object');

-- A field keeps its project, key, type and options, stays retired once
-- retired, and is never deleted, so the values and history that name it
-- keep their meaning.
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
