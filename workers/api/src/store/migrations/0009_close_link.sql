-- A close as done may name a link: an http or https URL that shows the work,
-- for work that left no commit or pull request, such as a document. Only a
-- task closed as done has one, so a reopen, which clears the close, clears
-- it too; the earlier close keeps it in task_events.
ALTER TABLE tasks ADD COLUMN close_link TEXT
  CHECK (close_link IS NULL OR (status = 'closed' AND resolution = 'done' AND length(close_link) BETWEEN 1 AND 2048
    AND (close_link GLOB 'http://*' OR close_link GLOB 'https://*')));
