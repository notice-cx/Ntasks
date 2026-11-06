-- The earliest time a task that is not closed stops being deferred. The task
-- store reads it after each write to know how long its cached reads stay
-- true (src/store/cache.ts); this index answers it from one entry instead of
-- every open task.
CREATE INDEX tasks_by_defer_until ON tasks (defer_until) WHERE defer_until IS NOT NULL AND status <> 'closed';
