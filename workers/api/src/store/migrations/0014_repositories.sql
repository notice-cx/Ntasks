-- The repositories a task's change reached, each as owner/name in lowercase,
-- and whether a merge there is the change going live. An owner turns
-- merges_live on in Settings for a repository with no deploy; it starts off.
-- A merged signal for a task whose change reached such a repository moves it
-- straight to live, whatever its project's deploys says.
CREATE TABLE repositories (
  name TEXT PRIMARY KEY CHECK (
    length(name) BETWEEN 3 AND 255 AND name GLOB '?*/?*' AND name NOT GLOB '*/*/*' AND name = lower(name)
  ),
  merges_live INTEGER NOT NULL DEFAULT 0 CHECK (merges_live IN (0, 1))
) STRICT, WITHOUT ROWID;

-- A task's change reached the repository its delivery records, or else the
-- one its GitHub pull request is in, whose URL the store keeps as
-- https://github.com/<owner>/<name>/pull/<number>. Each task that reaches
-- merged or live adds its repository, however it got there: a signal, a close
-- after its commit was pushed, or a load of its rows.
CREATE TRIGGER tasks_add_their_repository_when_filed AFTER INSERT ON tasks
WHEN NEW.delivery_stage IN ('merged', 'live')
BEGIN
  INSERT OR IGNORE INTO repositories (name)
  SELECT name FROM (
    SELECT coalesce(NEW.delivery_repository, CASE
      WHEN NEW.delivery_pull_request GLOB 'https://github.com/?*/?*/pull/[0-9]*'
      THEN lower(substr(NEW.delivery_pull_request, 20, instr(NEW.delivery_pull_request, '/pull/') - 20))
    END) AS name
  )
  WHERE length(name) BETWEEN 3 AND 255 AND name GLOB '?*/?*' AND name NOT GLOB '*/*/*';
END;

CREATE TRIGGER tasks_add_their_repository_when_delivered AFTER UPDATE OF delivery_stage ON tasks
WHEN NEW.delivery_stage IN ('merged', 'live')
BEGIN
  INSERT OR IGNORE INTO repositories (name)
  SELECT name FROM (
    SELECT coalesce(NEW.delivery_repository, CASE
      WHEN NEW.delivery_pull_request GLOB 'https://github.com/?*/?*/pull/[0-9]*'
      THEN lower(substr(NEW.delivery_pull_request, 20, instr(NEW.delivery_pull_request, '/pull/') - 20))
    END) AS name
  )
  WHERE length(name) BETWEEN 3 AND 255 AND name GLOB '?*/?*' AND name NOT GLOB '*/*/*';
END;

-- The repositories of the tasks a store already holds at merged or live.
INSERT OR IGNORE INTO repositories (name)
SELECT name FROM (
  SELECT coalesce(delivery_repository, CASE
    WHEN delivery_pull_request GLOB 'https://github.com/?*/?*/pull/[0-9]*'
    THEN lower(substr(delivery_pull_request, 20, instr(delivery_pull_request, '/pull/') - 20))
  END) AS name
  FROM tasks
  WHERE delivery_stage IN ('merged', 'live')
)
WHERE length(name) BETWEEN 3 AND 255 AND name GLOB '?*/?*' AND name NOT GLOB '*/*/*';
