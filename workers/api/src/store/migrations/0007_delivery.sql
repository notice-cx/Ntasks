-- Where a closed task's change is: built, merged or live (docs/concepts.md).
--
-- A project says whether its changes go live by a deploy. For one that does
-- not, merged is the last stage.
ALTER TABLE projects ADD COLUMN deploys INTEGER NOT NULL DEFAULT 0 CHECK (deploys IN (0, 1));

-- A task's delivery: the commit and pull request it closed with, the commit
-- that merged it, when it reached each stage, and its stage. A commit is 7 to
-- 64 lowercase hexadecimal characters; a pull request is an http or https URL.
ALTER TABLE tasks ADD COLUMN delivery_commit TEXT
  CHECK (delivery_commit IS NULL OR (length(delivery_commit) BETWEEN 7 AND 64 AND delivery_commit NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE tasks ADD COLUMN delivery_pull_request TEXT
  CHECK (delivery_pull_request IS NULL OR (length(delivery_pull_request) BETWEEN 1 AND 2048
    AND (delivery_pull_request GLOB 'http://*' OR delivery_pull_request GLOB 'https://*')));
ALTER TABLE tasks ADD COLUMN delivery_merge_commit TEXT
  CHECK (delivery_merge_commit IS NULL OR (length(delivery_merge_commit) BETWEEN 7 AND 64
    AND delivery_merge_commit NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE tasks ADD COLUMN built_at TEXT;
ALTER TABLE tasks ADD COLUMN merged_at TEXT;
ALTER TABLE tasks ADD COLUMN live_at TEXT;
-- Only a task closed as done with a commit or a pull request has a stage, and
-- a task without one records no delivery at all, so a reopen, which clears
-- the stage, leaves nothing of it behind; the earlier delivery stays in
-- task_events. A merged task records when it merged, and only a live one
-- when it went live. A task can go live from built, so merged_at stays null
-- when no signal said it merged.
ALTER TABLE tasks ADD COLUMN delivery_stage TEXT CHECK (
  (delivery_stage IS NULL AND delivery_commit IS NULL AND delivery_pull_request IS NULL
    AND delivery_merge_commit IS NULL AND built_at IS NULL AND merged_at IS NULL AND live_at IS NULL)
  OR (delivery_stage IN ('built', 'merged', 'live') AND status = 'closed' AND resolution = 'done'
    AND (delivery_commit IS NOT NULL OR delivery_pull_request IS NOT NULL) AND built_at IS NOT NULL
    AND (delivery_stage <> 'built' OR (delivery_merge_commit IS NULL AND merged_at IS NULL))
    AND (delivery_stage <> 'merged' OR merged_at IS NOT NULL)
    AND (live_at IS NOT NULL) = (delivery_stage = 'live')));

-- A delivery signal names pull requests and commits; these reach the tasks
-- that carry them without reading any other task. A commit matches by
-- prefix, so a signal reads a range of the commit index.
CREATE INDEX tasks_by_delivery_pull_request ON tasks (delivery_pull_request) WHERE delivery_pull_request IS NOT NULL;
CREATE INDEX tasks_by_delivery_commit ON tasks (delivery_commit) WHERE delivery_commit IS NOT NULL;
CREATE INDEX tasks_by_delivery_merge_commit ON tasks (delivery_merge_commit) WHERE delivery_merge_commit IS NOT NULL;
-- A project's closed tasks at a stage, whenever they closed.
CREATE INDEX tasks_by_project_stage ON tasks (project_id, delivery_stage) WHERE delivery_stage IS NOT NULL;
