-- The repository a task's change reached, as owner/name in lowercase, when a
-- signal that moved it named one, such as a push to the default branch. A task
-- closed with a commit and no pull request names no repository otherwise, and
-- the store's check of GitHub reads a merged task's deploy checks through it.
-- Every task a store already holds names none, and a task at built never does.
ALTER TABLE tasks ADD COLUMN delivery_repository TEXT
  CHECK (delivery_repository IS NULL OR (delivery_stage IN ('merged', 'live')
    AND length(delivery_repository) BETWEEN 3 AND 255 AND delivery_repository GLOB '?*/?*'));
