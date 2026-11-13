/**
 * The task guide: the rules every agent the MCP endpoint reaches works by.
 * The server's instructions carry its start and a short writing checklist,
 * and get_task_guide returns the whole guide with a version, which changes
 * whenever the text does, so an agent knows when to read it again.
 *
 * NoticeOS's task tools served this text before Ntasks did, and agents that
 * work for NoticeOS's owner follow it; a change to it is a change to how they
 * work. Rules only one installation uses, such as how NoticeOS ranks cards or
 * keeps change classes, belong in that installation's own instructions.
 */
import { COMMENT_SUMMARY_MAX, NEXT_LABEL, type HeldTask } from '@ntasks/domain';
import { shortHash } from '../short-hash.ts';
import { TITLE_MOST } from './writing.ts';

export const COMMENT_WRITING =
  `Start a detailed comment with a plain-text \`TL;DR: \` line. Write one sentence of at most ${COMMENT_SUMMARY_MAX} characters after the label. ` +
  'Lead with the outcome and any action the reader needs to take. Leave a blank line before the supporting details. A short comment can stand on its own.';

/** The writing rules an agent needs on connection, also used by the full guide. */
const TASK_WRITING: readonly string[] = Object.freeze([
  'Write for a product manager with engineering knowledge who has not seen the conversation. Use familiar words and lead with the outcome or the action you need from them.',
  '- Before drafting, call get_task_template with type: task for general work, bug for a failure, decision for a choice or human_action for steps that unblock separate work. The template explains which fields to fill.',
  `- title: start with a verb, name the outcome or ask, and keep it within ${TITLE_MOST} characters. Leave commands, paths and commit hashes for the body.`,
  '- description: say what and why in the first sentence. Use short paragraphs, one action per numbered step and technical pointers last. Put runnable commands in fenced code blocks.',
  '- acceptance: put a checklist of observable results in the separate acceptance field. Use checks you can verify when the work lands.',
  '- Before creating or editing task content, read it as a whole. When the scope changes, update the title, description and acceptance together.',
]);

/** The checklist plus details for cases that need them. */
export const TASK_QUALITY: readonly string[] = Object.freeze([
  ...TASK_WRITING,
  '- For work, use ## Why for the impact and evidence, ## Fix for the intended behavior, and ## Where for relevant paths, commits or docs. A bug also has ## Steps to Reproduce with actual and expected results.',
  '- Use Markdown, define necessary internal terms on first use, and give numbers their units. Use readable link labels and name pull requests as owner/repo#123. Preserve evidence and links when rewriting task content.',
  '- Give each runnable command or snippet its own fenced block with a language tag. Omit prompts and output. Inline backticks are for identifiers, paths and settings.',
  '- Prove implementation with tests or local measurements and close on that evidence. Record any unchecked production condition in the close reason and file a bug if it fails in production.',
  '- Progress comments, close reasons and pull requests state the behavior before and after, why it changed, what checks ran and what they showed, and what was skipped. Cite the repo, commits and tests. A pull request covers the scope of its task and uses its repository template when present.',
  '- For a human request, put the ask first. Say why it needs the person, where to act, what changes, and what happens after their answer. Name who acts in headings and describe pending actions as pending. Under ## What it changes, give each impact a bold label, a value with units where applicable, and who it affects.',
  '- The request version (`proposalVersion` in `get_task`) includes the task ID, type, title, description, acceptance and choices. It also includes any step text and commands and the pull request on a merge approval. Checking off a step leaves the version unchanged.',
  '- When rewriting a request, preserve the action, scope and existing options. Even a wording-only edit can change the version. Ntasks refuses an answer submitted for an older version. Show the owner the current request again before recording their answer.',
  '- A recorded choice stays tied to the version the owner saw. Once they choose, `update_task` refuses changes to the choices. File a new request if you need the owner to decide on a different action or scope.',
  '- For a decision, use the human label and pass the question and two to six options as choices. Key them a through f in order and mark exactly one recommended. Give each option a short label and its consequence.',
  "- For approval, use request_human_approval or create_task's approval field with the action as title. Use ## Why this needs you, ## What the agent will do (with exact commands), ## What it changes, ## How we'll confirm and ## If you decline. For a merge, pass pr and leave auto-merge off. Approval turns it on and Ntasks posts the answer on the pull request.",
  '- Keep one task labelled human when a person’s steps are the whole job. Checking the result, recording it and closing the task are part of the same job. Keep the steps in that task’s description. The MCP checklist tool creates a separate request for work that needs the person’s result before it can proceed.',
  "- When a person's steps unblock a separate deliverable, use the human_action template and call request_human_action on the task with that deliverable. Use ## What it changes and ## How we'll confirm in context. Each action goes in steps, with any runnable command in command. The final tick closes the request and removes it as a blocker. Check the result before continuing the linked work.",
  '- Production access, including reads, spending, external messages, destructive actions and material business or policy commitments require explicit owner approval for that action. Routine work within the authorized scope belongs to agents.',
]);

/** What the task tools and rules gained lately, oldest first, at most four. */
export const WHATS_CHANGED: readonly string[] = Object.freeze([
  "2026-11-11: request_human_approval and create_task's approval take pr for merge approvals.",
  '2026-11-12: Connection instructions show the writing checklist and how to read the Markdown templates with get_task_template.',
  '2026-11-13: people can put work in Next with a note. The default ready-work list shows unassigned Next tasks first (workflow step 2).',
  '2026-11-13: Detailed comments lead with a short TL;DR that the web app shows before the full comment.',
]);

/** Where everything about a task is kept, so the next person or agent finds it from the task. */
export const ON_THE_TASK =
  "Everything about a task goes on the task, as comment_on_task or its fields: progress, hand-overs (where work stopped, file pointers, gotchas, what is left), findings and decisions. Never put it in a separate notes file, scratch doc, chat-only summary, memory or a tool's own notes feature; when another tool asks for a note, write only a pointer to the task.";

/** The rule as the instructions carry it: short enough to end within
 * INSTRUCTIONS_BUDGET after ten held tasks. Workflow step 4 carries it whole. */
export const ON_THE_TASK_BRIEF =
  "Everything about a task goes on the task, as a comment or its fields, hand-overs included, never in a separate note; get_task_guide's step 4 has the rule.";

/** Where a fact that several tasks of an epic need is kept, so each of them finds it. */
export const PIN_ON_THE_EPIC =
  "A fact the epic's other tasks need, such as a file they all change, a number one of them took or the order their pull requests merge in, goes on the epic as comment_on_task with pin: true; each of its tasks then shows it. When a pinned fact stops being true, pin the correction with unpin naming the old comment.";

/** How a session starts. */
export const TASK_START =
  "Ntasks: tasks that people and AI agents share. Start with list_workspaces; every other tool acts in a workspace from it, which you name only when you reach several. A tool that names a task needs no project: the task id's prefix names it. idempotency_key and model are optional: an identical call sent again answers once while the tasks it wrote are unchanged, and model, the model you run as, is recorded beside your name. get_agent_stats counts work by model.";

/** The order of task work, in the tools' own names: one call for each step. */
export const TASK_WORKFLOW: readonly string[] = Object.freeze([
  '1. A session starts with the open tasks you hold, listed in these instructions with each one’s next step: carry them on first. list_projects names each project and the prefix that starts its task ids.',
  `2. Choose: list_tasks with ready: true and no project lists work nothing blocks. Pick unassigned work from Next first when choosing new work. It carries the \`${NEXT_LABEL}\` label and comes first in that list. Read the task and its comments with get_task before claiming it, including any note left when it was queued. Keep watch on work in progress with list_tasks activity: ["quiet","stalled"]: a quiet task may be done and not closed, such as one whose pull request merged, and a stalled one has a holder that stopped, to pick up or free (step 8).`,
  "3. Start: claim_task, or claim_task with pr alone for the task that pull request names. Pass for, branch and pr when a helper agent works under you, and touches, the files or other things your work changes; the answer's overlaps names other work in progress that changes the same, so agree with its holder which pull request merges first. create_task with claim: true files new work and claims it. On a task in an epic, get_task and claim_task show parent: the facts the epic's tasks pinned for each other, and what its closed tasks left, with each one's close reason and proof; read them before you build.",
  `4. Progress: comment_on_task with what changed, and next, commit or pr when they change; with tasks, one check is recorded on each. After each push to the task's branch, comment_on_task with what the pushed commit does, commit when you tested it, test when it reports a test run, and pr once the pull request is open: the task then shows active for the next hour. See Writing a comment for the summary format. ${ON_THE_TASK} ${PIN_ON_THE_EPIC}`,
  '5. Finish: use close_task with evidence, commit, pr or link, and test when you ran one. If nothing shipped, explain why and use the appropriate resolution instead of delivery proof. GitHub closes a task on a merge to the default branch when its work names that pr, except for epics, human requests, open approvals or Do requests, open children, and keep-open. Use keep-open when the PR covers only part of the work. An epic closes when all its direct children close and reopens when one reopens if Ntasks closed it. Use create_task with done for work already finished, and report_delivery for a merge or deploy when no signal reports it.',
  '6. File found work in Ntasks. Search with list_tasks first and comment on an existing task. Use create_task for new work or create_tasks for several, where #n names another entry. Check possibleDuplicates and close the later duplicate with duplicate_of. Use an epic for three or more related tasks or work that spans several sessions. Use depends_on for real blockers, related for other connections, and defer date-bound work with a reason. Use link_tasks to change a link, update_task for other fields, and move_tasks to move work to another epic or project.',
  '7. Label work only a person can do human. Record the owner’s answer in conversation with reconcile_task: action answer, proposal_version from get_task, exact quote and source, and the choice or outcome they gave. Cite the linked conversation or task comment with the proposal and scope. Use action accepted and met when the owner accepts partially met criteria. Claim the work again when it is ready. Act within the approval scope and never perform a declined action. A stale proposal_version means show the owner the task again.',
  '8. Without an owner answer, reconcile_task with proposal_version, an explanation and evidence retires a request as obsolete, superseded or duplicate, or as completed when other work did what it asked and it is not an approval, a request to do steps or a decision; takes the human label off routine work; or releases a task whose holder stopped (release, with holder, inactive: true, activity_check and progress; age alone never proves it). Retiring an approval grants no permission.',
]);

export const TASK_GUIDE_TOOL = 'get_task_guide';

/** Every tool the guide names. test/api/read-tools.test.ts checks the guide
 * names each one. */
export const GUIDE_TOOLS: readonly string[] = Object.freeze([
  'list_workspaces',
  'list_projects',
  'list_tasks',
  'get_task',
  'get_task_template',
  'create_task',
  'create_tasks',
  'update_task',
  'claim_task',
  'comment_on_task',
  'close_task',
  'link_tasks',
  'move_tasks',
  'report_delivery',
  'request_human_approval',
  'request_human_action',
  'reconcile_task',
  'get_agent_stats',
]);

/** A sentence naming the tools the guide names that this endpoint does not
 * offer, or null when it offers them all. */
export function unofferedTools(offered: readonly string[]): string | null {
  const missing = GUIDE_TOOLS.filter((name) => !offered.includes(name));
  return missing.length === 0
    ? null
    : `This endpoint does not offer ${missing.join(', ')} yet, so the steps that use them do not apply here.`;
}

export interface TaskGuide {
  readonly version: string;
  readonly guide: string;
}

function guideBody(offered: readonly string[]): string {
  const unoffered = unofferedTools(offered);
  return [
    ...(unoffered === null ? [] : ['## This endpoint', '', unoffered, '']),
    '## Start',
    '',
    TASK_START,
    '',
    '## Writing a task',
    '',
    ...TASK_QUALITY,
    '',
    '## Writing a comment',
    '',
    COMMENT_WRITING,
    'The web app shows that sentence first. Keep evidence, links and hand-over details below it.',
    '',
    '```text',
    'TL;DR: The reset link works again and is ready for review.',
    '',
    'The link now uses the current sign-in address. Both reset-link tests passed locally.',
    '```',
    '',
    '## Workflow',
    '',
    ...TASK_WORKFLOW,
    '',
    '## What changed',
    '',
    ...WHATS_CHANGED.map((entry) => `- ${entry}`),
  ].join('\n');
}

/** The whole guide as Markdown, with the first 12 hexadecimal characters of
 * its SHA-256 as its version. */
export async function taskGuide(offered: readonly string[]): Promise<TaskGuide> {
  const body = guideBody(offered);
  const version = await shortHash(body, 12);
  return Object.freeze({
    version,
    guide: `# Working with Ntasks tasks\n\nGuide version ${version}; list_workspaces returns the current one as guideVersion.\n\n${body}\n`,
  });
}

/**
 * How many characters of a server's instructions an agent is sure to read:
 * Claude Code shows about this many and cuts the rest. Keep the writing
 * checklist, template instructions and held tasks within it.
 */
export const INSTRUCTIONS_BUDGET = 4096;

/** A task the connecting sender holds, and the workspace it is in. */
export interface HeldEntry extends HeldTask {
  readonly workspaceId: string;
}

/** Text cut to `most` characters, ending with an ellipsis when cut. */
function cut(text: string, most: number): string {
  return text.length <= most ? text : `${text.slice(0, most - 1)}…`;
}

/** One held task on one line: its id, title, helper, branch, next step and last activity. */
function heldLine(task: HeldEntry, several: boolean): string {
  return [
    `- ${task.id} ${cut(task.title, 80)}`,
    ...(several ? [`workspace ${task.workspaceId}`] : []),
    ...(task.assigneeFor === null ? [] : [`for ${task.assigneeFor}`]),
    ...(task.work.branch === undefined ? [] : [`branch ${cut(task.work.branch, 60)}`]),
    ...(task.work.next === undefined ? [] : [`next: ${cut(task.work.next, 100)}`]),
    ...(task.lastActivityAt === null
      ? []
      : [`last activity ${task.lastActivityAt.slice(0, 16).replace('T', ' ')} UTC`]),
  ].join(' · ');
}

/** The most held tasks the instructions list one by one. */
const HELD_LINES = 10;

/**
 * The tasks the connecting sender holds, most recently active first, one
 * line each, in at most `room` characters: at most ten, and after them one
 * line with how many more there are and the call that lists them. Empty when
 * it holds none.
 */
function heldSection(held: readonly HeldEntry[], several: boolean, room: number): string[] {
  if (held.length === 0) return [];
  const ordered = [...held].sort(
    (a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || a.priority - b.priority,
  );
  const more = (count: number) =>
    `${count} more: list_tasks with assignee "me"${several ? ' in each workspace' : ''} lists every task you hold.`;
  const lines = ['Open tasks you hold, most recently active first; carry each on from its next step:'];
  let used = lines[0]!.length;
  for (const [index, task] of ordered.entries()) {
    const line = heldLine(task, several);
    const after = ordered.length - index - 1;
    const reserve = after === 0 ? 0 : more(after).length + 1;
    if (index >= HELD_LINES || used + 1 + line.length + reserve > room) {
      lines.push(more(ordered.length - index));
      return lines;
    }
    lines.push(line);
    used += 1 + line.length;
  }
  return lines;
}

/**
 * Every session's instructions: which of the guide's tools this endpoint
 * lacks, the guide's start, the tasks the sender holds when it connects,
 * the writing checklist, and where everything about a task is kept.
 */
export function taskInstructions(offered: readonly string[], held: readonly HeldEntry[] = [], several = false): string {
  const unoffered = unofferedTools(offered);
  // First, so an agent learns what is missing before any step that names it.
  const start = [
    ...(unoffered === null ? [] : [unoffered]),
    TASK_START,
    `Read ${TASK_GUIDE_TOOL} before task work for the full workflow and writing guide. Read it again when list_workspaces returns a new guideVersion.`,
  ];
  // Keep held tasks ahead of the writing checklist while reserving room for both.
  const end = ['', ON_THE_TASK_BRIEF, '', 'Writing a task', ...TASK_WRITING];
  const room = INSTRUCTIONS_BUDGET - start.join('\n').length - end.join('\n').length - 2;
  return [...start, ...heldSection(held, several, room), ...end].join('\n');
}
