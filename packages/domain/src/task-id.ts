/**
 * A task id names one task: the project's prefix, a hyphen and a key, then
 * one `.n` suffix per level of child task. The prefix and the key are
 * lowercase ASCII letters and digits. `web-a1b2` is a task in the project
 * whose prefix is `web`, and `web-a1b2.3` is that task's third child.
 *
 * Beads also allows hyphens inside a prefix, as in `web-app-a3f8e9`; Ntasks
 * does not, so a prefix always ends at the first hyphen. Every id in the
 * NoticeOS task hub has this form, because its prefixes are letters only.
 */
const TASK_ID = /^[a-z0-9]+-[a-z0-9]+(?:\.[0-9]+)*$/u;

/** Whether `value` has the form of a task id. It does not check that the task exists. */
export function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID.test(value);
}
