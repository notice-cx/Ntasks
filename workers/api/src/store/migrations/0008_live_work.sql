-- A task's live work: the helper agent its holder works through, and the
-- details the holder records about the work in hand (a session, worktree,
-- branch, pull request, commit and next step). docs/task-store.md describes
-- them. Both are empty while nobody holds the task or once it closes, so a
-- release or a close cannot leave an earlier holder's work behind; its
-- history keeps every change to them.
ALTER TABLE tasks ADD COLUMN assignee_for TEXT
  CHECK (assignee_for IS NULL OR (length(assignee_for) BETWEEN 1 AND 255 AND assignee IS NOT NULL AND status <> 'closed'));

-- One JSON object of text by detail name. The API accepts less in a new
-- write: WORK_LIMITS in packages/domain.
ALTER TABLE tasks ADD COLUMN work TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(work) AND json_type(work) = 'object' AND length(work) <= 8192
    AND (json(work) = '{}' OR (assignee IS NOT NULL AND status <> 'closed')));

-- A task's last activity is when its holder last wrote to it: the latest
-- history event the holder made. This index answers that with one entry per
-- task, however long its history.
CREATE INDEX task_events_by_actor ON task_events (task_id, actor, at);
