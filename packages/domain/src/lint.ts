/**
 * The sections a task's description is expected to have, by type.
 *
 * Adapted from Beads (MIT License, Copyright (c) 2025 Beads Contributors;
 * see THIRD_PARTY_NOTICES.md): `RequiredSections` in internal/types/types.go
 * and `LintIssue` and `ValidateTemplate` in internal/validation/template.go,
 * as of Beads v1.3.1.
 */
import type { TaskType } from './task.ts';

const REQUIRED_SECTIONS: Readonly<Record<TaskType, readonly string[]>> = Object.freeze({
  bug: ['Steps to Reproduce', 'Acceptance Criteria'],
  task: ['Acceptance Criteria'],
  feature: ['Acceptance Criteria'],
  epic: ['Success Criteria'],
  decision: ['Decision', 'Rationale', 'Alternatives Considered'],
  chore: [],
  gate: [],
});

/** The sections a task's type expects, as Markdown headings such as `## Acceptance Criteria`. */
export function requiredSections(type: TaskType): readonly string[] {
  return REQUIRED_SECTIONS[type].map((name) => `## ${name}`);
}

/**
 * The headings a task's type expects that its text lacks, in the type's order.
 *
 * A section counts as present when its name appears anywhere in the
 * description or the acceptance text, in any case. A non-empty acceptance
 * field also counts as the "Acceptance Criteria" or "Success Criteria"
 * section, and an epic may say "Acceptance Criteria" for "Success Criteria".
 */
export function missingSections(task: { readonly type: TaskType; readonly description: string; readonly acceptance: string }): string[] {
  const text = `${task.description}\n${task.acceptance}`.toLowerCase();
  const hasAcceptance = task.acceptance.trim() !== '';
  return REQUIRED_SECTIONS[task.type]
    .filter((name) => {
      const key = name.toLowerCase();
      if (text.includes(key)) return false;
      const criteria = key === 'acceptance criteria' || key === 'success criteria';
      if (criteria && hasAcceptance) return false;
      if (task.type === 'epic' && key === 'success criteria' && text.includes('acceptance criteria')) return false;
      return true;
    })
    .map((name) => `## ${name}`);
}
