/**
 * Warnings for text that cites what its next reader cannot check: a path on
 * the writer's own machine, or an exact count of tests that passed or
 * failed, which is wrong once the tests change. They are advice in a write's
 * `warnings`; the write lands either way.
 */
import type { Args } from '../args.ts';

/** The fields of a task create_task, create_tasks and update_task check. */
export const TASK_TEXT = Object.freeze(['description', 'acceptance']);

/**
 * A temporary folder (/tmp, /private/tmp, /var/folders) or a home folder
 * (/Users/<name>, /home/<name>, ~/), up to the next space or bracket. It
 * starts at the start of a word, so a repository path such as `src/tmp/x`
 * and a URL such as `https://example.com/home/x` are not one.
 */
const MACHINE_PATH =
  /(?<![\w.~-])(?:(?:\/private)?\/(?:tmp|var\/folders)(?![\w-])|\/(?:Users|home)\/(?=[^\s/])|~\/)[^\s"'`<>()[\]{}]*/u;

/**
 * A count of tests that passed or failed: `123 passed`, `5 tests failed`,
 * `Tests: 40 passed (40)`, `5 passed in 0.12s`. Without the word "test", a
 * word after the verb makes it something else, as in `3 failed sign-ins`.
 */
const TEST_COUNT =
  /\b\d[\d,]*\s+(?:tests?\s+(?:passed|failed|passing|failing)\b|(?:passed|failed|passing|failing)\b(?![ \t]+(?!in[ \t]+\d)\p{L}))/iu;

/**
 * A warning for each of `fields` in `args` that names a path on one machine
 * or gives an exact test count, naming the field by its path (`at` starts
 * it, as `tasks[2].`) and what to cite instead.
 */
export function citationWarnings(args: Args, fields: readonly string[], at = ''): string[] {
  const warnings: string[] = [];
  for (const field of fields) {
    const text = args[field];
    if (typeof text !== 'string') continue;
    const path = MACHINE_PATH.exec(text)?.[0].replace(/[.,;:!?]+$/u, '');
    if (path)
      warnings.push(
        `${at}${field} names a path on one machine (${path}); cite a path in the repository, a commit or a link instead`,
      );
    const count = TEST_COUNT.exec(text)?.[0];
    if (count)
      warnings.push(
        `${at}${field} gives an exact test count (${count}), which goes out of date; cite the command that runs the tests instead`,
      );
  }
  return warnings;
}
