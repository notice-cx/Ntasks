/**
 * The parts of a task the task guide asks each type to have, and which of
 * them a task lacks.
 *
 * Adapted from Beads (MIT License, Copyright (c) 2025 Beads Contributors;
 * see THIRD_PARTY_NOTICES.md): `RequiredSections` in internal/types/types.go
 * and `LintIssue` and `ValidateTemplate` in internal/validation/template.go,
 * as of Beads v1.3.1.
 */
import type { TaskType } from './task.ts';

/** The acceptance field, as lint names it when a type expects it and it is blank. */
export const ACCEPTANCE = 'acceptance';

/** By type: the description's headings the guide asks for, and the acceptance field. */
const REQUIRED: Readonly<Record<TaskType, readonly string[]>> = Object.freeze({
  bug: ['## Steps to Reproduce', ACCEPTANCE],
  task: [ACCEPTANCE],
  feature: [ACCEPTANCE],
  epic: [ACCEPTANCE],
  decision: [],
  chore: [],
  gate: [],
});

/** What a task's type expects: Markdown headings such as `## Steps to Reproduce`, and `acceptance`. */
export function requiredSections(type: TaskType): readonly string[] {
  return REQUIRED[type];
}

/**
 * What a task's type expects that it lacks, in the type's order. A heading
 * counts as present when its name appears anywhere in the description, in
 * any case; `acceptance` when the acceptance field is not blank.
 */
export function missingSections(task: {
  readonly type: TaskType;
  readonly description: string;
  readonly acceptance: string;
}): string[] {
  const description = task.description.toLowerCase();
  return REQUIRED[task.type].filter((part) =>
    part === ACCEPTANCE
      ? task.acceptance.trim() === ''
      : !description.includes(part.replace(/^#+\s*/u, '').toLowerCase()),
  );
}
