-- A request that a person do steps: a gate whose steps are stored here, in
-- order, as a JSON array. Each step holds its text, the command it runs or
-- null, and what the person recorded on it: who ticked it and when, a note,
-- and where they got stuck (TaskStep in packages/domain). An approval, and
-- every other task, has none. The API accepts at most TASK_LIMITS.steps.
ALTER TABLE tasks ADD COLUMN steps TEXT
  CHECK (steps IS NULL OR (type = 'gate' AND json_valid(steps) AND json_type(steps) = 'array'
    AND json_array_length(steps) >= 1));
