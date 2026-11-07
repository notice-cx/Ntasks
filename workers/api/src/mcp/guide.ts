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
  '2026-11-03: reconcile_task supports answer_mode relayed for local Claude Code sessions and quoted task comments, owner_performed for the owner’s completed action, and no-longer-needed for retirement. Relayed approvals close immediately and can be disputed on Tasks.',
  '2026-11-07: claim_task and comment_on_task take for, the helper agent working under you, and the work details session, worktree, branch, pr, commit and next; get_task shows them with lastActivityAt, when the holder last wrote to the task, and an epic’s open children with their holders; list_tasks shows for and lastActivityAt.',
  "2026-11-07: close_task takes commit and pr, and the task's delivery shows its change as built; report_delivery moves it to merged and live. list_tasks takes stage and counts closed tasks by stage.",
]);

/** How a session starts. */
export const TASK_START =
  'Ntasks: tasks that people and AI agents share. Start with list_workspaces; every other tool takes a workspace from it. A tool that takes an idempotency_key: reuse the key when retrying it. On every create_task, create_tasks, claim_task and close_task, pass model: the name of the model you run as. The task records it beside your name, and the Agents page groups work by model; missing or unrecognized models share Other. Use get_agent_stats for activity statistics without individual task details.';

/** The order of task work, in the tools' own names. */
export const TASK_WORKFLOW: readonly string[] = Object.freeze([
  '1. list_workspaces, then list_projects: a project is one repository or asset, and its prefix starts each of its task ids.',
  '2. list_tasks with ready: true and no project for work nothing blocks anywhere; assignee: "me" for what you hold. get_task reads one with its comments before you choose.',
  '3. claim_task the moment you start, naming your model. A helper agent that cannot reach these tools works under your claim: pass for with its name, and the branch, worktree and pr it works in.',
  '4. comment_on_task with progress and evidence as the work moves, with next, commit or pr when they change, so anyone who reads the task sees the work in hand.',
  '5. close_task with what shipped and its evidence (the commit hash or URL), naming your model, and pass commit or pr so the task shows its change as built. When you merge a pull request or finish a deploy, report_delivery moves its tasks to merged or live; list_tasks with stage built lists what is not merged yet.',
  '6. Found work goes to create_task, or create_tasks for several, in the project that owns it.',
  '7. A decision, credential or admin step only a person can do: label the task human, with choices when the person picks one option. A step that must wait for approval: request_human_approval. The owner may answer on Tasks or in conversation, including a local Claude Code session recorded as a relay.',
  '8. reconcile_task records the owner answer, takes off the human label and returns the task to agents, preserving the selected choice. Claim it to carry on, then close_task with the implementation commit. A person answering a decision directly on Tasks closes it on the answer instead.',
  '9. Use get_task then reconcile_task to record an existing owner answer and its exact scope; do not ask the owner to close the task or release an old assignment. For an answer received directly from the owner in your chat, set answer_mode: direct, include the exact question, reply and chat source, and map a decision-card selection with option when its label differs from the stored choice. This records your relay, not independent authentication. Other sources require verification. Match short replies to the proposal the owner saw. Apply a clearly scoped batch answer only to its named tasks. If ambiguous, ask one clarification only for the ambiguity.',
  '10. With concrete evidence and a plain explanation, reconcile_task may close completed outcomes, obsolete requests, explicitly superseded decisions or duplicates that retain complete scope elsewhere; routine work loses its human label. Code existing does not prove a business decision was approved. Keep history; update_task can reopen a closed task.',
  '11. Assignments are reservations: investigate an old assignment, verify its holder is no longer working and preserve progress before reconcile_task action release. get_task shows the holder’s work details and lastActivityAt to start from. Age alone never proves abandonment.',
  '12. When the owner declines an approval gate, use reconcile_task on the gate with action: declined, its current proposal, the exact owner response, owner identity, original source and full requested scope. For a direct chat answer include answer_mode: direct and the exact question with the action, environment and verification. This closes the gate as wont-do, records the declined action on its task, and leaves remaining authorized work available. The declined action must not happen. Retiring an obsolete gate also grants no permission and does not block the remaining work. Other open approvals still block closing.',
  '13. Relayed answers use answer_mode: relayed, the exact question, response, owner, scope and source claude-code:session/<session id> or comment:<id> preserving the relay. The approval closes immediately, is marked as relayed by the admitted agent, and the owner can Dispute it to reopen the gate and flag the recorder. No independent transcript authentication is claimed. Numbered batch replies require approval_item and a source comment preserving the item number. Owner-performed actions use action: owner_performed with the exact completed result in response, owner, scope and source; use answer_mode: relayed for an agent comment quoting that result. This closes as done, records approved and owner-performed, grants no new permission and preserves prior approval events. Obsolete and superseded requests close as no-longer-needed; only declined approvals close as wont-do.',
  '14. list_tasks accepts closed_days from 1 to 56 (default 7) to audit earlier closed gates before changing them. Preserve actual declines and each source event.',
  '15. Direct answers require an https:// or codex://threads/ conversation source and the human owner field. A comment:<id> source is for a source-verified answer authored by the owner with their exact response; an agent comment quoting an owner is a relay, not an owner-authored source. Preserve the original chat link for a direct relay. A changed proposal requires checking the actual question the owner saw; never replace their words to pass validation.',
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
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const version = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
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
