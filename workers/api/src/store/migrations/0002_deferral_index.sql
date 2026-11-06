-- The earliest time any task stops being deferred, closed tasks included: a
-- closed parent's deferral still holds its open children out of ready work.
-- The task store reads it after each write to know how long its cached reads
-- stay true (src/store/cache.ts); this index answers it from one entry.
CREATE INDEX tasks_by_defer_until ON tasks (defer_until) WHERE defer_until IS NOT NULL;
