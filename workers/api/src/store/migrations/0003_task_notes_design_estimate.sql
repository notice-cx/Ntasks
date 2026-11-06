-- A task's notes and design: Markdown beside its description and acceptance,
-- with no length limit here, as description has none. And its estimate, in
-- whole minutes, null when nobody estimated it. The API accepts less in a new
-- write: TASK_LIMITS in packages/domain.
ALTER TABLE tasks ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN design TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN estimate_minutes INTEGER CHECK (estimate_minutes IS NULL OR estimate_minutes >= 0);
