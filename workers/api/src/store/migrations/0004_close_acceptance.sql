-- A person's acceptance of a task as done on their own call: who accepted it,
-- who relayed it for them when someone did, and each of the task's "done
-- when" criteria as they found it, met or waived (TaskAcceptance in
-- packages/domain). Only a close as done carries one, and never beside a
-- link or a delivery: the acceptance is what shows the task done. Every other
-- task has none.
ALTER TABLE tasks ADD COLUMN close_acceptance TEXT
  CHECK (close_acceptance IS NULL OR (status = 'closed' AND resolution = 'done'
    AND close_link IS NULL AND delivery_stage IS NULL AND json_valid(close_acceptance)
    AND json_type(close_acceptance) = 'object' AND json_type(close_acceptance, '$.criteria') IS 'array'));
