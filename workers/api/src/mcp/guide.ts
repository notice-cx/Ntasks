/**
 * The task guide: the rules every agent the MCP endpoint reaches works by.
 * The server's instructions carry its start and its rules for writing a task,
 * and get_task_guide returns the whole guide with a version, which changes
 * whenever the text does, so an agent knows when to read it again.
 *
 * NoticeOS's task tools served this text before Ntasks did, and agents that
 * work for NoticeOS's owner follow it; a change to it is a change to how they
 * work.
 */
import { shortHash } from '../short-hash.ts';

/** How to write a task that reads cold. */
export const TASK_QUALITY: readonly string[] = Object.freeze([
  'Writing a task: a stranger must be able to act on it without this conversation.',
  '- title: the outcome, in plain language.',
  '- description: plain labelled lines, unwrapped: WHAT, WHY with the numbers, WHERE as pointers that resolve in a repo (file paths, commits, doc sections), FIX. A bug also has a "## Steps to Reproduce" section.',
  '- acceptance: the proof that completes it, provable the day the work lands. Never "watch for N days": close on today\'s proof and name where a recurrence would show.',
  '- Implementation evidence cites the repo, commits and tests, never a session summary or temporary file. An existing owner answer cites its task comment or explicitly linked conversation, with the exact proposal and scope.',
  "- Work meant to change money carries a card: the predicted change in USD a month, how likely it pays off, the operator's review minutes and your build minutes, the days until the ledger shows it, how it is measured, and the state and date to give up on it; the board ranks tasks by their cards, and a task without one is listed, not ranked.",
  '- change_class names the kind of change a task makes, one of content-data, copy, template, feature and infra, which the autonomy ladder and the likelihood priors are kept by.',
  "- Work only a person can do (a decision, a credential, an admin step) carries the human label and is written for that person: the ask as the description's first line, technical notes last. When the person picks between options, pass them as choices: a question and two to six options keyed a, b, c… in order, each a one-line label with an optional detail, exactly one marked recommended. The web app shows one button per option. A step that must wait for approval uses request_human_approval.",
  '- Too big for one working session: an epic with session-sized children. Three or more related tasks share an epic. depends_on only for a real blocking edge; related for the rest. Work waiting on a date is deferred with the reason.',
  '- Found work, including debt (two copies of one rule, a hardcoded value with a canonical source, half-done work), is a task, never a TODO comment, a list in a doc or a memory note. Claim before you build; close with the commit hash.',
  "- Before filing, search with list_tasks query for the title's key words, with no project to search every project. Work already filed gets a comment, never a second task; of two tasks already filed for one piece of work, close the later as duplicate with duplicate_of.",
  "- When nothing shipped, close_task takes a resolution: wont-do when the work will not be done, duplicate with duplicate_of when another task holds it, cant-reproduce when a bug does not happen again, already-handled when other work did it, no-longer-needed for a retired request; the reason still cites the evidence: what decided it, the other task's id, what was tried, or what handled it.",
  '- Human requests show the decision, one recommendation, the practical consequence and what proceeds after the answer. Reversible wording under established copy rules, internal refactoring, test repairs and backlog organization belong to agents within authorized work.',
  '- Production access (reads included), spending, external messages, destructive actions and material business or policy commitments require explicit action-specific owner approval. Credentials, prerequisites and old approvals never grant a new action. Retiring a gate grants no permission.',
]);

/** What the task tools gained lately, oldest first, at most three. */
export const WHATS_CHANGED: readonly string[] = Object.freeze([
  "2026-11-07: close_task takes commit and pr, and the task's delivery shows its change as built; report_delivery moves it to merged and live. list_tasks takes stage and counts closed tasks by stage.",
  '2026-11-07: workspace is optional when you reach only one; a tool that names a task needs no project, and project takes a key or prefix too; idempotency_key and model are optional on every tool. A write answers with the task id, its version and what changed (detail: "full" for the whole task). A refusal names the task and the argument at fault, and ends by saying whether a retry is safe.',
  '2026-11-07: reconcile_task records an owner’s answer as the option they chose on the proposal_version get_task returned, with their exact words as quote and where they said it as source; nothing reads the quote, and an answer to an older version is refused.',
]);

/** How a session starts. */
export const TASK_START =
  "Ntasks: tasks that people and AI agents share. Start with list_workspaces; every other tool acts in a workspace from it, which you name only when you reach several. A tool that names a task needs no project: the task id's prefix names it. idempotency_key is optional. Without a key, an identical call repeats the first answer only while every task that answer wrote is unchanged since; a create also stops repeating after 24 hours. model is optional: the name of the model you run as, which a write records beside your name; the Agents page groups work by model, and missing or unrecognized models share Other. Use get_agent_stats for activity statistics without individual task details.";

/** The order of task work, in the tools' own names. */
export const TASK_WORKFLOW: readonly string[] = Object.freeze([
  '1. list_workspaces, then list_projects: a project is one repository or asset, and its prefix starts each of its task ids.',
  '2. list_tasks with ready: true and no project for work nothing blocks anywhere; assignee: "me" for what you hold. get_task reads one with its comments before you choose.',
  '3. claim_task the moment you start, naming your model. A helper agent that cannot reach these tools works under your claim: pass for with its name, and the branch, worktree and pr it works in.',
  '4. comment_on_task with progress and evidence as the work moves, with next, commit or pr when they change, so anyone who reads the task sees the work in hand.',
  '5. close_task with what shipped and its evidence (the commit hash or URL), naming your model, and pass commit or pr so the task shows its change as built. When you merge a pull request or finish a deploy, report_delivery moves its tasks to merged or live; list_tasks with stage built lists what is not merged yet.',
  '6. Found work goes to create_task, or create_tasks for several, in the project that owns it.',
  '7. A decision, credential or admin step only a person can do: label the task human, with choices when the person picks one option. A step that must wait for approval: request_human_approval. The owner may answer on Tasks or in conversation, including a local Claude Code session recorded as a relay.',
  '8. When the owner answers you in conversation, record it with reconcile_task: action answer (on an approval, answer approves it and declined declines it; owner_performed records that the owner did the action), proposal_version (the proposalVersion get_task returned for the proposal you showed them), quote (their exact words), source (where they said it, such as claude-code:session/<session id> or the conversation URL) and, on a task with choices, the option they chose. Nothing reads the quote: name the option yourself, and leave it out when they chose none. A refusal names the argument at fault and records nothing; a stale proposal_version means the task changed, so show it to the owner again.',
  '9. The answer is recorded as relayed by you. An approval closes and the human tasks waiting on it go back to agents within what it approved; the owner can dispute a relayed approval, which reopens it and tells those tasks to stop. A declined approval closes as wont-do and its action must not happen. Any other task goes back to ready work without the human label: claim it, then close_task with the implementation commit. A person answering on Tasks records their answer directly.',
  '10. Without an owner answer, reconcile_task with an explanation and evidence retires a request (completed, obsolete, superseded, or duplicate with duplicate_of), takes the human label off routine work, or releases an assignment whose holder stopped (release with holder, inactive: true, activity_check and progress; get_task shows the holder’s work details and lastActivityAt to start from; age alone never proves it). Code existing does not prove a business decision was approved, and retiring an approval grants no permission. Keep history; update_task can reopen a closed task.',
  'These tools are the task interface: never run bd, bv or br in a project folder.',
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

/** Every session's instructions: the guide's start, which of its tools this
 * endpoint lacks, and its rules for writing a task. */
export function taskInstructions(offered: readonly string[]): string {
  const unoffered = unofferedTools(offered);
  // First, so an agent learns what is missing before any step that names it.
  return [
    ...(unoffered === null ? [] : [unoffered]),
    TASK_START,
    `${TASK_GUIDE_TOOL} returns these rules with the full workflow and what changed lately, at any time; list_workspaces returns its version as guideVersion, so read it again when that changes.`,
    '',
    ...TASK_QUALITY,
  ].join('\n');
}
