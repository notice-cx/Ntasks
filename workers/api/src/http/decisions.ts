/**
 * The HTTP routes of a person's decisions: answering a task that waits on
 * them, picking one of its options, declining it, approving an approval and
 * disputing an approval an agent recorded for them. Each route and body has
 * the shape NoticeOS's Tasks API took (scripts/hosted-task-http.mts there);
 * owner-answers.ts holds the rules, and each decision is one write. Only a
 * person signed in to the web app may send one (the `tasks:decide` scope).
 * Also the agent statistics read, GET /api/tasks/agent-stats.
 */
import { TASK_LIMITS, TASK_RESOLUTIONS, type TaskResolution } from '@ntasks/domain';
import { choiceArg, only, projectArg, refuse, taskArg, textArg } from '../args.ts';
import { agentStats } from '../agent-stats.ts';
import { TASK_CHOICE_KEYS, TASK_CHOICE_LIMITS } from '../noticeos-fields.ts';
import { ANSWERED, approve, choose, DISMISSED, dismiss, dispute, RESPONDED, respond, seen } from '../owner-answers.ts';
import type { WriteContext, Written } from '../task-writes.ts';
import { webTask } from '../views.ts';
import { json, queryOf } from './respond.ts';
import { writeOf } from './writes.ts';

/** The answer to a decision: the task as it stands after it. */
async function decided(context: WriteContext, written: Written): Promise<Response> {
  return json({ task: webTask(await seen(context, written.result.task)) });
}

/** POST /api/tasks/:id/respond: a person's answer, in their own words. */
export async function respondRoute(
  context: WriteContext,
  url: URL,
  request: Request,
  taskId: string,
): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'respond', { task: taskId });
  only(body, ['projectId', 'response']);
  const projectId = projectArg(body, 'projectId', 'http');
  // Short enough to fit one comment as "Answered: <response>" or "Response: <response>".
  const most = TASK_LIMITS.comment - Math.max(ANSWERED.length, RESPONDED.length);
  const response = textArg(body, 'response', most, true)!;
  return decided(context, await respond(context, projectId, taskId, response, retry(body)));
}

/** POST /api/tasks/:id/choose: a person's pick of one of the task's options. */
export async function chooseRoute(
  context: WriteContext,
  url: URL,
  request: Request,
  taskId: string,
): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'choose', { task: taskId });
  only(body, ['projectId', 'option', 'note']);
  const projectId = projectArg(body, 'projectId', 'http');
  const option = choiceArg(body, 'option', TASK_CHOICE_KEYS);
  if (option === undefined) refuse('invalid arguments: option (required)');
  const note = textArg(body, 'note', TASK_CHOICE_LIMITS.note, false);
  return decided(context, await choose(context, projectId, taskId, option, note, retry(body)));
}

const DISMISSALS = TASK_RESOLUTIONS.filter((resolution) => resolution !== 'done') as Exclude<TaskResolution, 'done'>[];

/** POST /api/tasks/:id/dismiss: a person declining what the task asks. */
export async function dismissRoute(
  context: WriteContext,
  url: URL,
  request: Request,
  taskId: string,
): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'dismiss', { task: taskId });
  only(body, ['projectId', 'reason', 'resolution', 'duplicateOf']);
  const projectId = projectArg(body, 'projectId', 'http');
  // Short enough to fit the close reason as "Dismissed: <reason>".
  const reason = textArg(body, 'reason', TASK_LIMITS.reason - DISMISSED.length, false);
  const resolution = choiceArg(body, 'resolution', DISMISSALS);
  const duplicateOf = body.duplicateOf === undefined ? undefined : taskArg(body, 'duplicateOf');
  if ((resolution === 'duplicate') !== (duplicateOf !== undefined))
    refuse('invalid arguments: duplicateOf (with resolution duplicate, and only with it)');
  if (duplicateOf === taskId) refuse('invalid arguments: duplicateOf (another task than the one dismissed)');
  const dismissal = {
    ...(reason === undefined ? {} : { reason }),
    ...(resolution === undefined ? {} : { resolution }),
    ...(duplicateOf === undefined ? {} : { duplicateOf }),
  };
  return decided(context, await dismiss(context, projectId, taskId, dismissal, retry(body)));
}

/** POST /api/tasks/:id/dispute: a person withdrawing an approval an agent recorded for them. */
export async function disputeRoute(
  context: WriteContext,
  url: URL,
  request: Request,
  taskId: string,
): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'dispute', { task: taskId });
  only(body, ['projectId']);
  const projectId = projectArg(body, 'projectId', 'http');
  return decided(context, await dispute(context, projectId, taskId, retry(body)));
}

/** POST /api/gates/:id/resolve: a person approving an approval. */
export async function resolveRoute(
  context: WriteContext,
  url: URL,
  request: Request,
  gateId: string,
): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'resolve', { task: gateId });
  only(body, ['projectId', 'reason']);
  const projectId = projectArg(body, 'projectId', 'http');
  const reason = textArg(body, 'reason', TASK_LIMITS.reason, false);
  return decided(context, await approve(context, projectId, gateId, reason, retry(body)));
}

/** GET /api/tasks/agent-stats?project=…: agent statistics, of one project or every one the sender reaches. */
export async function agentStatsRoute(context: WriteContext, url: URL): Promise<Response> {
  const query = queryOf(url, ['project']);
  return json(await agentStats(context, query.project));
}
