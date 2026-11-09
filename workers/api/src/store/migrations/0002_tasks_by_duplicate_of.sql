-- A load's commit inserts every task with its foreign keys deferred. While a
-- task waits for one written after it, SQLite looks up each new task's id in
-- every column that refers to a task. Without this index the lookup in
-- duplicate_of reads the whole tasks table once for each task, so a load's
-- commit grows with the square of its tasks (store/load.ts).
CREATE INDEX tasks_by_duplicate_of ON tasks (duplicate_of) WHERE duplicate_of IS NOT NULL;
