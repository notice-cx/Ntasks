-- The repositories whose changes moved a task here, each as owner/name in
-- lowercase, and whether a merge there is the change going live. An owner
-- turns merges_live on in Settings for a repository with no deploy; it starts
-- off. A merged signal for a task whose change reached such a repository moves
-- it straight to live, whatever its project's deploys says.
CREATE TABLE repositories (
  name TEXT PRIMARY KEY CHECK (
    length(name) BETWEEN 3 AND 255 AND name GLOB '?*/?*' AND name NOT GLOB '*/*/*' AND name = lower(name)
  ),
  merges_live INTEGER NOT NULL DEFAULT 0 CHECK (merges_live IN (0, 1))
) STRICT, WITHOUT ROWID;

-- The repositories a store's tasks already name: the one a signal recorded on
-- a task, or else the one its GitHub pull request is in, whose URL the store
-- keeps as https://github.com/<owner>/<name>/pull/<number>.
INSERT INTO repositories (name)
SELECT DISTINCT name FROM (
  SELECT delivery_repository AS name FROM tasks WHERE delivery_repository IS NOT NULL
  UNION ALL
  SELECT lower(substr(delivery_pull_request, 20, instr(delivery_pull_request, '/pull/') - 20)) AS name
  FROM tasks
  WHERE delivery_repository IS NULL AND delivery_pull_request GLOB 'https://github.com/?*/?*/pull/[0-9]*'
)
WHERE length(name) BETWEEN 3 AND 255 AND name GLOB '?*/?*' AND name NOT GLOB '*/*/*';
