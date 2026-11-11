-- The commits of the pushes to a repository's default branch that the store
-- heard of in the last day, each with its push's newest commit and time. A
-- task closed with one of them after its push moves to merged at its close,
-- with that newest commit as its merge commit, as the push would have moved
-- it. Rows older than a day are removed as each push is recorded, and a
-- backup leaves them out.
CREATE TABLE pushed_commits (
  commit_sha TEXT NOT NULL CHECK (length(commit_sha) BETWEEN 7 AND 64 AND commit_sha NOT GLOB '*[^0-9a-f]*'),
  repository TEXT NOT NULL CHECK (length(repository) BETWEEN 3 AND 255 AND repository GLOB '?*/?*'),
  head TEXT NOT NULL CHECK (length(head) BETWEEN 7 AND 64 AND head NOT GLOB '*[^0-9a-f]*'),
  pushed_at TEXT NOT NULL,
  PRIMARY KEY (commit_sha, repository)
) STRICT, WITHOUT ROWID;

CREATE INDEX pushed_commits_by_age ON pushed_commits (pushed_at);
