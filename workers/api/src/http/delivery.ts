/**
 * The HTTP routes of delivery and of a project's settings: a repository's
 * signal that pull requests or commits merged or went live, an owner's
 * settings of a project (its name, whether its changes go live by a deploy,
 * whether it takes new tasks, and its website), the icons read from that
 * website, and whether a repository's merges go live. docs/api.md describes
 * them.
 */
import {
  ICON_SCHEMES,
  REPOSITORY_NAME,
  TaskRefused,
  type IconScheme,
  type Project,
  type ProjectChange,
  type Repository,
} from '@ntasks/domain';
import { only, projectArg, refuse } from '../args.ts';
import { movedView, reportDelivery, signalArgs } from '../delivery.ts';
import { projectOf } from '../lookup.ts';
import { readProjectIcons, websiteAddress } from '../project-icons.ts';
import { ICON_SECURITY_POLICY } from '../svg-icon.ts';
import { actorOf } from '../task-writes.ts';
import type { ReadContext } from './tasks.ts';
import type { WriteContext } from '../task-writes.ts';
import { HttpRefused, json, queryOf } from './respond.ts';
import { writeOf } from './writes.ts';

/** The address of a project's icon for `scheme` on this Ntasks, which changes whenever the icon does; null when it has none. */
function iconPath(project: Project, scheme: IconScheme): string | null {
  const at = scheme === 'dark' ? project.darkIconAt : project.iconAt;
  if (at === null) return null;
  const dark = scheme === 'dark' ? 'scheme=dark&' : '';
  return `/api/tasks/projects/${encodeURIComponent(project.id)}/icon?${dark}v=${iconVersion(at)}`;
}

/** Names one read of an icon in its address. */
const iconVersion = (iconAt: string) => iconAt.replace(/\D/gu, '');

/** A project as GET /api/tasks/projects lists it. */
export function projectView(project: Project) {
  return {
    projectId: project.id,
    logicalKey: project.key,
    displayName: project.name,
    prefix: project.prefix,
    deploys: project.deploys,
    disabled: project.disabledAt !== null,
    websiteUrl: project.websiteUrl,
    icon: iconPath(project, 'light'),
    darkIcon: iconPath(project, 'dark'),
  };
}

/**
 * POST /api/delivery: `{ repository?, stage, pullRequests?, commits?, tasks? }`.
 * Moves the closed tasks it names, in the projects the sender may change,
 * and answers `{ moved: [{ id, stage }] }`. A repeated signal moves nothing.
 * The repository may be left out only when the signal names tasks alone.
 */
export async function deliveryRoute(context: WriteContext, url: URL, request: Request): Promise<Response> {
  const { body } = await writeOf(request, url, 'report_delivery', {});
  only(body, ['repository', 'stage', 'pullRequests', 'commits', 'tasks']);
  const signal = signalArgs(body, { pullRequests: 'pullRequests', commits: 'commits', tasks: 'tasks' });
  return json({ moved: movedView(await reportDelivery(context, signal)) });
}

/**
 * PATCH /api/tasks/projects: `{ projectId, displayName?, deploys?, disabled?,
 * websiteUrl? }`, an owner's settings of a project; it names at least one.
 * A website is read for its icon before anything is written, and `""` or
 * null clears it. Answers the project.
 */
export async function projectSettingsRoute(context: WriteContext, url: URL, request: Request): Promise<Response> {
  const { body } = await writeOf(request, url, 'update_project', {});
  only(body, ['projectId', 'displayName', 'deploys', 'disabled', 'websiteUrl']);
  const project = await projectOf(context, projectArg(body, 'projectId', 'http'));
  const change: { -readonly [K in keyof ProjectChange]: ProjectChange[K] } = {};
  if (body.displayName !== undefined) {
    const name = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (name.length < 1 || name.length > 128 || /[\u0000-\u001f\u007f]/u.test(name))
      throw new HttpRefused(400, 'invalid_request', 'the name is one line of 1 to 128 characters', 'displayName');
    change.name = name;
  }
  for (const key of ['deploys', 'disabled'] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') refuse(`invalid arguments: ${key} (true or false)`);
    change[key] = body[key];
  }
  if (body.websiteUrl !== undefined) {
    if (body.websiteUrl === null || body.websiteUrl === '') change.website = null;
    else {
      const website = typeof body.websiteUrl === 'string' ? websiteAddress(body.websiteUrl) : null;
      if (website === null)
        throw new HttpRefused(
          400,
          'invalid_request',
          'the website is an http or https address, such as https://example.com',
          'websiteUrl',
        );
      change.website = { url: website, icons: await readProjectIcons(website) };
    }
  }
  if (Object.keys(change).length === 0)
    refuse('invalid arguments: name at least one of displayName, deploys, disabled and websiteUrl');
  return json({ project: projectView(await context.engine.updateProject(project.id, change)) });
}

/** A repository as GET /api/tasks/repositories lists it. */
function repositoryView(repository: Repository) {
  return { repository: repository.name, mergesLive: repository.mergesLive };
}

/** GET /api/tasks/repositories: `{ repositories: [{ repository, mergesLive }] }`, every repository whose changes moved a task, by name. */
export async function repositoriesRoute(context: ReadContext, url: URL): Promise<Response> {
  queryOf(url, []);
  return json({ repositories: (await context.engine.listRepositories()).map(repositoryView) });
}

/**
 * PATCH /api/tasks/repositories: `{ repository, mergesLive }`, an owner's
 * setting of whether a merge there is the change going live. Turned on, it
 * moves that repository's tasks at merged to live as well. Answers
 * `{ repository: { repository, mergesLive }, moved: [{ id, stage }] }`.
 */
export async function repositorySettingsRoute(context: WriteContext, url: URL, request: Request): Promise<Response> {
  const { body } = await writeOf(request, url, 'update_repository', {});
  only(body, ['repository', 'mergesLive']);
  if (typeof body.repository !== 'string' || !REPOSITORY_NAME.test(body.repository))
    refuse('invalid arguments: repository (owner/name, such as example/app)');
  if (typeof body.mergesLive !== 'boolean') refuse('invalid arguments: mergesLive (true or false)');
  try {
    const result = await context.engine.setRepository(
      body.repository,
      body.mergesLive,
      actorOf(context.principal, undefined),
    );
    return json({ repository: repositoryView(result.repository), moved: movedView(result.moved) });
  } catch (error) {
    if (!(error instanceof TaskRefused)) throw error;
    if (error.refusal === 'not_found') throw new HttpRefused(404, 'not_found', error.message, 'repository');
    if (error.refusal === 'version_conflict') throw new HttpRefused(503, 'unavailable', error.message);
    throw new HttpRefused(400, 'invalid_request', error.message);
  }
}

/**
 * GET /api/tasks/projects/:projectId/icon: the icon read from the project's
 * website, the light one or with `scheme=dark` the dark one, with the image
 * type its bytes show. An address with the icon's current `v`, as the
 * project list gives it, may be kept as long as a browser likes: a new icon
 * has a new address.
 */
export async function projectIconRoute(context: ReadContext, url: URL, projectId: string): Promise<Response> {
  const { v, scheme = 'light' } = queryOf(url, ['v', 'scheme']);
  if (!(ICON_SCHEMES as readonly string[]).includes(scheme))
    throw new HttpRefused(400, 'invalid_request', `scheme is ${ICON_SCHEMES.join(' or ')}`, 'scheme');
  const project = await projectOf(context, projectId);
  const icon = await context.engine.projectIcon(project.id, scheme as IconScheme);
  if (icon === null) return json({ error: 'not_found', detail: `${project.name} has no icon` }, 404);
  const current = v === iconVersion(icon.readAt);
  return new Response(icon.bytes, {
    headers: {
      'content-type': icon.contentType,
      'cache-control': current ? 'private, max-age=31536000, immutable' : 'private, no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': ICON_SECURITY_POLICY,
    },
  });
}
