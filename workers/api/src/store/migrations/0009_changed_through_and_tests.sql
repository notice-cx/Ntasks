-- Who each change was made through, and the test results a comment or a
-- close carries.

-- The helper agent and the agent session a change was made through: for a
-- change by the task's holder, the task's assignee_for and work's session as
-- they stood. They take whatever those hold, as an imported or restored task
-- may hold more than a new write accepts. list_tasks finds the tasks a helper
-- or a session changed by them. Every change a store already holds names neither.
ALTER TABLE task_events ADD COLUMN actor_for TEXT
  CHECK (actor_for IS NULL OR length(actor_for) BETWEEN 1 AND 255);
ALTER TABLE task_events ADD COLUMN session TEXT;

-- A task's changes through one helper or one session, from their own entries.
CREATE INDEX task_events_by_helper ON task_events (task_id, actor_for) WHERE actor_for IS NOT NULL;
CREATE INDEX task_events_by_session ON task_events (task_id, session) WHERE session IS NOT NULL;

-- A test run a comment or a close reports (TaskTestResult in
-- packages/domain): the command, whether it passed, its counts and the commit
-- it ran on, as JSON. Every comment and close a store already holds has none.
ALTER TABLE task_comments ADD COLUMN test TEXT
  CHECK (test IS NULL OR (json_valid(test) AND json_type(test) = 'object'));
ALTER TABLE tasks ADD COLUMN close_test TEXT
  CHECK (close_test IS NULL OR (status = 'closed' AND json_valid(close_test) AND json_type(close_test) = 'object'));

-- A comment's test, like the rest of it, never changes.
DROP TRIGGER task_comments_fixed;
CREATE TRIGGER task_comments_fixed BEFORE UPDATE ON task_comments
WHEN NEW.id IS NOT OLD.id OR NEW.task_id IS NOT OLD.task_id OR NEW.author IS NOT OLD.author
  OR NEW.text IS NOT OLD.text OR NEW.created_at IS NOT OLD.created_at OR NEW.pinned > OLD.pinned
  OR NEW.test IS NOT OLD.test
BEGIN
  SELECT raise(ABORT, 'ntasks: comments are never edited');
END;
