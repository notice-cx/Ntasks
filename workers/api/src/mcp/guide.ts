/**
 * The task guide: the rules every agent the MCP endpoint reaches works by.
 * The server's instructions carry its start and its rules for writing a task,
 * and get_task_guide returns the whole guide with a version, which changes
 * whenever the text does, so an agent knows when to read it again.
 *
 * NoticeOS's task tools served this text before Ntasks did, and agents that
 * work for NoticeOS's owner follow it; a change to it is a change to how they
 * work. Rules only one installation uses, such as how NoticeOS ranks cards or
 * keeps change classes, belong in that installation's own instructions.
 */
import type { HeldTask } from '@ntasks/domain';
import { shortHash } from '../short-hash.ts';
import { TITLE_MOST } from './writing.ts';

/** How to write a task that reads cold. */
export const TASK_QUALITY: readonly string[] = Object.freeze([
  'Writing a task: a stranger must be able to act on it without this conversation. The web app shows descriptions, acceptance and comments as Markdown.',
  `- title: the outcome, or for a person the ask, in plain words starting with a verb; at most ${TITLE_MOST} characters; no commands, file paths, commit hashes or steps.`,
  "- description, in Markdown: a first line of one sentence saying what and why (for a person, the ask), then only the sections that apply. Work: ## Why, with the numbers; ## Where, as pointers that resolve in a repo (file paths, commits, doc sections); ## Fix. A bug also has ## Steps to Reproduce. Steps a person does: ## Your steps; ## What it changes; ## How we'll confirm. An approval, where an agent acts once allowed: ## What the agent will do; ## What it changes; ## How we'll confirm; ## If you decline.",
  '- Headings say who acts, and never describe a pending action in the present tense as if it already happens.',
  '- What it changes: each line starts with a bold label naming what it measures, such as **Downtime:**, **Your time:**, **Cost:**, **Download:**, **Risk:** or **Undo:**, then the value with its unit and who or what it applies to: "**Downtime:** visitors can\'t reach the site for about 2 minutes". Never a bare number or duration.',
  '- Every command, query, request or snippet a person might run or paste goes in its own fenced block with a language tag (bash, sql, json…): one command per block, with no $ prompt and no output; a multi-line command stays one block. Inline backticks are only for names that are not run: file paths, identifiers, settings.',
  '- In a description: steps as a numbered list, one action each; links with readable labels, pull requests as owner/repo#123; numbers with units; paragraphs of at most 3 sentences; bullets for 3 or more items; no internal shorthand.',
  '- acceptance: a short checklist of observable facts, provable the day the work lands. Never "watch for N days": close on today\'s proof and name where a recurrence would show.',
  '- An approval: request_human_approval with title, the action to approve, and a description in the approval sections above, with the exact commands under ## What the agent will do.',
  '- Implementation evidence cites the repo, commits and tests, never a session summary or temporary file. An existing owner answer cites its task comment or explicitly linked conversation, with the exact proposal and scope.',
  "- Work only a person can do (a decision, a credential, an admin step) carries the human label and is written for that person: the ask as the description's first line, technical notes last. When the person picks between options, pass them as choices: a question and two to six options keyed a, b, c… in order, each a one-line label with an optional detail, exactly one marked recommended. The web app shows one button per option.",
  '- Too big for one working session: an epic with session-sized children. Three or more related tasks share an epic. depends_on only for a real blocking edge; related for the rest. Work waiting on a date is deferred with the reason.',
  '- Found work, including debt (two copies of one rule, a hardcoded value with a canonical source, half-done work), is a task, never a TODO comment, a list in a doc or a memory note. Claim before you build; close with the commit, pull request or link that proves it.',
  '- create_task answers possibleDuplicates: open tasks in its project whose titles share most of its words. Work already filed gets a comment, never a second task; of two tasks filed for one piece of work, close the later as duplicate with duplicate_of.',
  "- When nothing shipped, close_task takes a resolution: wont-do when the work will not be done, duplicate with duplicate_of when another task holds it, cant-reproduce when a bug does not happen again, already-handled when other work did it, no-longer-needed for a retired request; the reason still cites the evidence: what decided it, the other task's id, what was tried, or what handled it.",
  '- Human requests show the decision, one recommendation, the practical consequence and what proceeds after the answer. Reversible wording under established copy rules, internal refactoring, test repairs and backlog organization belong to agents within authorized work.',
  '- Production access (reads included), spending, external messages, destructive actions and material business or policy commitments require explicit action-specific owner approval. Credentials, prerequisites and old approvals never grant a new action. Retiring a gate grants no permission.',
]);

/** What the task tools gained lately, oldest first, at most three. */
export const WHATS_CHANGED: readonly string[] = Object.freeze([
  '2026-11-07: reconcile_task records an owner’s answer as the option they chose on the proposal_version get_task returned, with their exact words as quote and where they said it as source; nothing reads the quote, and an answer to an older version is refused.',
  '2026-11-07: one call each. create_task takes claim and done, and answers possibleDuplicates; create_tasks files the rest when one is refused, and #n names any task of the call. claim_task takes pr in place of task. close_task takes tasks, with_children and link, and lists unblocked; comment_on_task and get_task take tasks. link_tasks replaces add_dependency and remove_dependency. A task done without commit, pr or link shows proof: none. The instructions list the tasks you hold.',
  `2026-11-09: new rules for writing a task: a title of at most ${TITLE_MOST} characters with no commands, paths or hashes, and a Markdown description with a one-sentence first line and only the sections that apply. request_human_approval takes title and description; reason still works. Lint on create and update advises on a title that breaks the rule, and on a command written inline in a description.`,
]);

/** How a session starts. */
export const TASK_START =
  "Ntasks: tasks that people and AI agents share. Start with list_workspaces; every other tool acts in a workspace from it, which you name only when you reach several. A tool that names a task needs no project: the task id's prefix names it. idempotency_key and model are optional: an identical call sent again answers once while the tasks it wrote are unchanged, and model, the model you run as, is recorded beside your name. get_agent_stats counts work by model.";

/** The order of task work, in the tools' own names: one call for each step. */
export const TASK_WORKFLOW: readonly string[] = Object.freeze([
  '1. A session starts with the open tasks you hold, listed in these instructions with each one’s next step: carry them on first. list_projects names each project and the prefix that starts its task ids.',
  '2. Choose: list_tasks with ready: true and no project lists work nothing blocks; get_task reads one in full, or several with tasks.',
  '3. Start: claim_task, or claim_task with pr alone for the task that pull request names. Pass for, branch and pr when a helper agent works under you. create_task with claim: true files new work and claims it.',
  '4. Progress: comment_on_task with what changed, and next, commit or pr when they change; with tasks, one check is recorded on each.',
  '5. Finish: close_task with the evidence and its proof: commit, pr or link. tasks closes several, with_children an epic and its open tasks; unblocked lists what is ready next. create_task with done files work already finished. After a merge or a deploy, report_delivery.',
  '6. Found work: create_task, or create_tasks for several, where #n names another task of the call. link_tasks sets or removes the one link between two tasks; update_task changes any other field.',
  '7. A step only a person can do: label the task human, with choices when they pick one option; request_human_approval when work must wait for approval. When the owner answers you in conversation, reconcile_task records it, relayed by you: action answer (declined or owner_performed on an approval), proposal_version from get_task, quote (their exact words), source (such as claude-code:session/<session id>) and the option they chose. An approved request’s waiting tasks go back to agents within its scope; a declined action must not happen; an answered task goes back to ready work, to claim and close with the implementation commit. A stale proposal_version means show the owner the task again.',
  '8. Without an owner answer, reconcile_task with proposal_version, an explanation and evidence retires a request (completed, obsolete, superseded or duplicate), takes the human label off routine work, or releases a task whose holder stopped (release, with holder, inactive: true, activity_check and progress; age alone never proves it). Retiring an approval grants no permission.',
]);

export const TASK_GUIDE_TOOL = 'get_task_guide';

/** Every tool the guide names. test/api/read-tools.test.ts checks the guide
 * names each one. */
export const GUIDE_TOOLS: readonly string[] = Object.freeze([
  'list_workspaces',
  'list_projects',
  'list_tasks',
  'get_task',
  'create_task',
  'create_tasks',
  'update_task',
  'claim_task',
  'comment_on_task',
  'close_task',
  'link_tasks',
  'report_delivery',
  'request_human_approval',
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
    '## What changed',
    '',
    ...WHATS_CHANGED.map((entry) => `- ${entry}`),
    '',
    '## Start',
    '',
    TASK_START,
    '',
    '## Workflow',
    '',
    ...TASK_WORKFLOW,
    '',
    '## Writing a task',
    '',
    ...TASK_QUALITY,
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
 * Claude Code shows about this many and cuts the rest. The tasks a session
 * holds end within it; the rules for writing a task come after them, and
 * get_task_guide serves those whole.
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
 * lacks, the guide's start, the tasks the sender holds when it connects, and
 * the rules for writing a task. The held tasks come before the rules and end
 * within INSTRUCTIONS_BUDGET, so an agent reads them however much a client cuts.
 */
export function taskInstructions(offered: readonly string[], held: readonly HeldEntry[] = [], several = false): string {
  const unoffered = unofferedTools(offered);
  // First, so an agent learns what is missing before any step that names it.
  const start = [
    ...(unoffered === null ? [] : [unoffered]),
    TASK_START,
    `${TASK_GUIDE_TOOL} returns these rules with the full workflow and what changed lately, at any time; list_workspaces returns its version as guideVersion, so read it again when that changes.`,
  ];
  const room = INSTRUCTIONS_BUDGET - start.join('\n').length - 1;
  return [...start, ...heldSection(held, several, room), '', ...TASK_QUALITY].join('\n');
}
