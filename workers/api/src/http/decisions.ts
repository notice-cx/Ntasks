/**
 * The HTTP routes of a person's decisions: answering a task that waits on
 * them, picking one of its options, declining it, approving an approval or
 * reporting that they did its action themselves, ticking the steps of a
 * request that they do steps, accepting a task as done on their own call, and
 * disputing an approval or an acceptance an agent recorded for them. Each
 * route and body has
 * the shape NoticeOS's Tasks API took (scripts/hosted-task-http.mts there),
 * and an answer may also name the `proposalVersion` the person's page showed.
 * owner-answers.ts holds the rules, and each decision is one write. Only a
 * person signed in to the web app may send one (the `tasks:decide` scope).
 * Also the agent statistics read, GET /api/tasks/agent-stats.
 */
import { TASK_LIMITS, TASK_RESOLUTIONS, type TaskResolution } from '@ntasks/domain';
import {
  booleanArg,
  choiceArg,
  criteriaMetArg,
  only,
  projectArg,
  refuse,
  taskArg,
  textArg,
  type Args,
} from '../args.ts';
import { agentStats } from '../agent-stats.ts';
import { TASK_CHOICE_KEYS, TASK_CHOICE_LIMITS } from '../noticeos-fields.ts';
import {
  accept,
  ANSWERED,
  approve,
  choose,
  DISMISSED,
  dismiss,
  dispute,
  markStep,
  perform,
  PERFORMED,
  release,
  RESPONDED,
  respond,
  seen,
} from '../owner-answers.ts';
import type { WriteContext, Written } from '../task-writes.ts';
import { PROPOSAL_VERSION, webTasks } from '../views.ts';
import { HttpRefused, json, queryOf, writtenJson } from './respond.ts';
import { writeOf } from './writes.ts';

/** The answer to a decision: the task as it stands after it. */
async function decided(context: WriteContext, written: Written): Promise<Response> {
  const [task] = await webTasks([await seen(context, written.result.task)], context.now());
  return writtenJson({ task }, written.result.replayed);
}

/** The proposal version the person's page showed: the answer is refused once
 * the task's proposal has changed from it. Undefined when the body names none. */
function shownOf(body: Args): string | undefined {
  const value = body.proposalVersion;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !PROPOSAL_VERSION.test(value))
    throw new HttpRefused(
      400,
      'invalid_request',
      'proposalVersion must be the 32 hexadecimal characters the task read returned',
      'proposalVersion',
    );
  return value;
}

/** POST /api/tasks/:id/respond: a person's answer, in their own words. */
export async function respondRoute(
  context: WriteContext,
  url: URL,
  request: Request,
  taskId: string,
): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'respond', { task: taskId });
  only(body, ['projectId', 'response', 'proposalVersion']);
  const projectId = projectArg(body, 'projectId', 'http');
  // Short enough to fit one comment as "Answered: <response>" or "Response: <response>".
  const most = TASK_LIMITS.comment - Math.max(ANSWERED.length, RESPONDED.length);
  const response = textArg(body, 'response', most, true)!;
  return decided(context, await respond(context, projectId, taskId, response, retry(body), shownOf(body)));
}

/** POST /api/tasks/:id/choose: a person's pick of one of the task's options. */
export async function chooseRoute(
  context: WriteContext,
  url: URL,
  request: Request,
  taskId: string,
): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'choose', { task: taskId });
  only(body, ['projectId', 'option', 'note', 'proposalVersion']);
  const projectId = projectArg(body, 'projectId', 'http');
  const option = choiceArg(body, 'option', TASK_CHOICE_KEYS);
  if (option === undefined) refuse('invalid arguments: option (required)');
  const note = textArg(body, 'note', TASK_CHOICE_LIMITS.note, false);
  return decided(context, await choose(context, projectId, taskId, option, note, retry(body), shownOf(body)));
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
  only(body, ['projectId', 'reason', 'resolution', 'duplicateOf', 'proposalVersion']);
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
  return decided(context, await dismiss(context, projectId, taskId, dismissal, retry(body), shownOf(body)));
}

/** POST /api/tasks/:id/accept: a person accepting a task as done on their own
 * call, naming the criteria they found met; the rest are recorded as waived.
 * It names the proposal version the page showed, so the criteria recorded are
 * the ones the person read. */
export async function acceptRoute(
  context: WriteContext,
  url: URL,
  request: Request,
  taskId: string,
): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'accept', { task: taskId });
  only(body, ['projectId', 'met', 'reason', 'proposalVersion']);
  const projectId = projectArg(body, 'projectId', 'http');
  const met = criteriaMetArg(body, 'met');
  const reason = textArg(body, 'reason', TASK_LIMITS.reason, false);
  const shown = shownOf(body);
  if (shown === undefined)
    throw new HttpRefused(
      400,
      'invalid_request',
      'proposalVersion is required: the one the task read returned, so the criteria recorded are the ones the person read',
      'proposalVersion',
    );
  const accepting = { met, ...(reason === undefined ? {} : { reason }) };
  return decided(context, await accept(context, projectId, taskId, accepting, retry(body), shown));
}

/** POST /api/tasks/:id/release: a person freeing a task someone holds, on their own call; `holder`, when sent, is the holder their page showed. */
export async function releaseRoute(
  context: WriteContext,
  url: URL,
  request: Request,
  taskId: string,
): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'release', { task: taskId });
  only(body, ['projectId', 'holder']);
  const projectId = projectArg(body, 'projectId', 'http');
  const holder = textArg(body, 'holder', TASK_LIMITS.actor, false);
  return decided(context, await release(context, projectId, taskId, retry(body), holder));
}

/** POST /api/tasks/:id/dispute: a person withdrawing an approval or an acceptance an agent recorded for them. */
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
  only(body, ['projectId', 'reason', 'proposalVersion']);
  const projectId = projectArg(body, 'projectId', 'http');
  const reason = textArg(body, 'reason', TASK_LIMITS.reason, false);
  return decided(context, await approve(context, projectId, gateId, reason, retry(body), shownOf(body)));
}

/** POST /api/gates/:id/performed: a person's report that they did an approval's action themselves. */
export async function performedRoute(
  context: WriteContext,
  url: URL,
  request: Request,
  gateId: string,
): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'performed', { task: gateId });
  only(body, ['projectId', 'note', 'proposalVersion']);
  const projectId = projectArg(body, 'projectId', 'http');
  // Short enough to fit the close reason as "Did it myself: <note>".
  const note = textArg(body, 'note', TASK_LIMITS.reason - `${PERFORMED}: `.length, false);
  return decided(context, await perform(context, projectId, gateId, note, retry(body), shownOf(body)));
}

/** A note or a reason that may be taken off: text, or null. Undefined when the body leaves it out. */
function nullableText(body: Args, name: string): string | null | undefined {
  return body[name] === null ? null : textArg(body, name, TASK_LIMITS.stepNote, false);
}

/** POST /api/gates/:id/steps: a person's marks on one step of a request that they do steps. */
export async function stepRoute(context: WriteContext, url: URL, request: Request, gateId: string): Promise<Response> {
  const { body, retry } = await writeOf(request, url, 'step', { task: gateId });
  only(body, ['projectId', 'step', 'done', 'note', 'stuck', 'proposalVersion']);
  const projectId = projectArg(body, 'projectId', 'http');
  const step = body.step;
  if (typeof step !== 'number' || !Number.isInteger(step) || step < 1 || step > TASK_LIMITS.steps)
    refuse(`invalid arguments: step (the step's place in the request, from 1 to ${TASK_LIMITS.steps})`);
  const done = booleanArg(body, 'done');
  const note = nullableText(body, 'note');
  const stuck = nullableText(body, 'stuck');
  if (done === undefined && note === undefined && stuck === undefined)
    refuse('invalid arguments: done, note or stuck (at least one)');
  if (done === true && typeof stuck === 'string')
    refuse('invalid arguments: stuck (a step is done or stuck, not both)');
  const marking = {
    step,
    ...(done === undefined ? {} : { done }),
    ...(note === undefined ? {} : { note }),
    ...(stuck === undefined ? {} : { stuck }),
  };
  return decided(context, await markStep(context, projectId, gateId, marking, retry(body), shownOf(body)));
}

/** GET /api/tasks/agent-stats?project=…: agent statistics, of one project or every one the sender reaches. */
export async function agentStatsRoute(context: WriteContext, url: URL): Promise<Response> {
  const query = queryOf(url, ['project']);
  return json(await agentStats(context, query.project));
}
