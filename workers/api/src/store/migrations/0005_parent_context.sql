-- What a task's parent holds for it: the parent's pinned comments, facts that
-- later work needs, and its other children that closed, each with how it
-- ended and what proves it. A read of one task, or a claim, shows both.

-- A comment is pinned when it is added, and a later comment on the same task
-- may unpin it. Every comment a store already holds stays unpinned.
ALTER TABLE task_comments ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));

-- A task's pinned comments, newest first, from their own entries: an epic's
-- other comments are never read to find them.
CREATE INDEX task_comments_pinned ON task_comments (task_id, created_at) WHERE pinned = 1;

-- A parent's closed children, most recently closed first. Counting them reads
-- these entries alone, and the children still open are never read.
CREATE INDEX tasks_closed_by_parent ON tasks (parent_id, closed_at, id)
  WHERE parent_id IS NOT NULL AND closed_at IS NOT NULL;

-- A comment's id, task, author, text and time still never change, and a
-- comment once unpinned is never pinned again: the one change a comment takes
-- is being unpinned.
DROP TRIGGER task_comments_fixed;
CREATE TRIGGER task_comments_fixed BEFORE UPDATE ON task_comments
WHEN NEW.id IS NOT OLD.id OR NEW.task_id IS NOT OLD.task_id OR NEW.author IS NOT OLD.author
  OR NEW.text IS NOT OLD.text OR NEW.created_at IS NOT OLD.created_at OR NEW.pinned > OLD.pinned
BEGIN
  SELECT raise(ABORT, 'ntasks: comments are never edited');
END;
