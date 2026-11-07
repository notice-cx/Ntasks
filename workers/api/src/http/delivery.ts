/**
 * The HTTP routes of delivery: a repository's signal that pull requests or
 * commits merged or went live, and the project setting that says whether a
 * project's changes go live by a deploy. docs/api.md describes both.
 */
import type { Project } from '@ntasks/domain';
import { only, projectArg, refuse } from '../args.ts';
import { movedView, reportDelivery, signalArgs } from '../delivery.ts';
import { projectOf } from '../lookup.ts';
import type { WriteContext } from '../task-writes.ts';
import { json } from './respond.ts';
import { writeOf } from './writes.ts';

/** A project as GET /api/tasks/projects lists it. */
export function projectView(project: Project) {
  return {
    projectId: project.id,
    logicalKey: project.key,
    displayName: project.name,
    prefix: project.prefix,
    deploys: project.deploys,
  };
}

/**
 * POST /api/delivery: `{ repository, stage, pullRequests?, commits? }`. Moves
 * the closed tasks it names, in the projects the sender may change, and
 * answers `{ moved: [{ id, stage }] }`. A repeated signal moves nothing.
 */
export async function deliveryRoute(context: WriteContext, url: URL, request: Request): Promise<Response> {
  const { body } = await writeOf(request, url, 'report_delivery', {});
  only(body, ['repository', 'stage', 'pullRequests', 'commits']);
  const moves = await reportDelivery(context, signalArgs(body, { pullRequests: 'pullRequests', commits: 'commits' }));
  return json({ moved: movedView(moves) });
}

/** PATCH /api/tasks/projects: `{ projectId, deploys }`, an owner's setting of whether a project's changes go live by a deploy. */
export async function projectSettingsRoute(context: WriteContext, url: URL, request: Request): Promise<Response> {
  const { body } = await writeOf(request, url, 'update_project', {});
  only(body, ['projectId', 'deploys']);
  const project = await projectOf(context, projectArg(body, 'projectId', 'http'));
  if (typeof body.deploys !== 'boolean') refuse('invalid arguments: deploys (true or false)');
  return json({ project: projectView(await context.engine.setProjectDeploys(project.id, body.deploys)) });
}
