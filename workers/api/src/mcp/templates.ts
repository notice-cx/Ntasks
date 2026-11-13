import task from '../../../../skills/ntasks/templates/task.md';
import bug from '../../../../skills/ntasks/templates/bug.md';
import decision from '../../../../skills/ntasks/templates/decision.md';
import humanAction from '../../../../skills/ntasks/templates/human-action.md';

export const TASK_TEMPLATE_TOOL = 'get_task_template';

const templates = Object.freeze({ task, bug, decision, human_action: humanAction });
export const TEMPLATE_TYPES = Object.freeze(Object.keys(templates) as (keyof typeof templates)[]);

/** The Markdown bundled with this version of Ntasks. */
export function taskTemplate(value: unknown): { type: keyof typeof templates; markdown: string } | null {
  const type = TEMPLATE_TYPES.find((candidate) => candidate === value);
  return type === undefined ? null : { type, markdown: templates[type] };
}
