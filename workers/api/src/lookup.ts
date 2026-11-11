/**
 * The project and the tasks a call names, among those its sender reaches.
 * A project the sender cannot reach is refused as if it did not exist, so a
 * sender learns nothing of another's projects. The MCP tools and the HTTP
 * writes share these, and their refusals.
 */
import {
  isTaskId,
  TASK_LIMITS,
  type FormerId,
  type Json,
  type Project,
  type Task,
  type TaskEngine,
  type TaskEvent,
} from '@ntasks/domain';
import { mayReach, reachable, type Principal, type ProjectAccess } from './auth.ts';
import { Refused } from './refused.ts';

export interface Reader {
  readonly engine: TaskEngine;
  readonly principal: Principal;
}

export const projectNamed = (project: Project) => `projectId ${project.id} (${project.name})`;

/** The project a call names by its projectId, key or prefix, in that order,
 * or a refusal that says how to find one. With `write`, a project the sender
 * may only read is refused for that. */
export async function projectOf(
  { engine, principal }: Reader,
  projectId: string,
  access: ProjectAccess = 'read',
): Promise<Project> {
  const projects = reachable(principal, await engine.listProjects());
  const project =
    projects.find((candidate) => candidate.id === projectId) ??
    projects.find((candidate) => candidate.key === projectId) ??
    projects.find((candidate) => candidate.prefix === projectId);
  if (!project) {
    throw new Refused(
      'not_found',
      `refused: project ${projectId} names no project in this workspace; list_projects lists each one's projectId, key and prefix.`,
      `no project ${projectId}; /api/tasks/projects lists them`,
    );
  }
  if (!mayReach(principal, project.id, access)) {
    throw new Refused(
      'forbidden',
      `refused: this call needs tasks:write in ${projectNamed(project)}, where you have tasks:read.`,
      `This sign-in may read ${project.name} but not change its tasks.`,
    );
  }
  return project;
}

/** The refusal for a task id the project does not hold: it names the project
 * whose prefix the id starts with, when that is another one the sender reaches. */
async function missing({ engine, principal }: Reader, project: Project, taskId: string): Promise<Refused> {
  const prefix = taskId.slice(0, taskId.indexOf('-'));
  const owner =
    prefix === project.prefix
      ? undefined
      : reachable(principal, await engine.listProjects()).find((candidate) => candidate.prefix === prefix);
  return owner
    ? new Refused(
        'not_found',
        `refused: ${taskId} is not in ${projectNamed(project)}, whose tasks start ${project.prefix}-; tasks with prefix ${owner.prefix} are in ${projectNamed(owner)}.`,
        `${taskId} is not in ${project.name}; tasks starting ${owner.prefix}- are in ${owner.name}.`,
      )
    : new Refused(
        'not_found',
        `refused: ${taskId} is not a task in ${projectNamed(project)}; list_tasks lists its tasks.`,
        `${taskId} is not a task in ${project.name}.`,
      );
}

/** The task a call names, or a refusal that says where to look. */
export async function taskOf(reader: Reader, project: Project, taskId: string): Promise<Task> {
  const task = await reader.engine.getTask(project.id, taskId);
  if (task) return task;
  throw await missing(reader, project, taskId);
}

/** Refuses the first of these task ids the project does not hold. */
export async function tasksIn(reader: Reader, project: Project, taskIds: readonly string[]): Promise<void> {
  if (taskIds.length === 0) return;
  const found = new Set(await reader.engine.findTasks(project.id, taskIds));
  const absent = taskIds.find((id) => !found.has(id));
  if (absent !== undefined) throw await missing(reader, project, absent);
}

/** The project a task id's prefix names among those the sender reaches, or undefined. */
export async function ownerOf({ engine, principal }: Reader, taskId: string): Promise<Project | undefined> {
  const prefix = taskId.slice(0, taskId.indexOf('-'));
  return reachable(principal, await engine.listProjects()).find((candidate) => candidate.prefix === prefix);
}

/** The project a task id's prefix names, or the refusal of a task the sender
 * cannot reach, which says no more than one that does not exist. */
export async function projectOfTask(reader: Reader, taskId: string): Promise<Project> {
  const owner = await ownerOf(reader, taskId);
  if (owner) return owner;
  const prefix = taskId.slice(0, taskId.indexOf('-'));
  throw new Refused(
    'not_found',
    `refused: no project you can reach has prefix ${prefix}, so ${taskId} names no task; list_projects lists each one's prefix.`,
    `no task ${taskId}`,
  );
}

/**
 * The moved tasks among these ids: each former id the sender may follow, with
 * the task's id and project now. A task in a project the sender cannot reach
 * is left out, so its former id answers as an id that names no task.
 */
export async function formerIdsOf(
  { engine, principal }: Reader,
  taskIds: readonly unknown[],
): Promise<ReadonlyMap<string, FormerId>> {
  const named = [...new Set(taskIds.filter(isTaskId))].slice(0, TASK_LIMITS.page);
  if (named.length === 0) return new Map();
  const found = await engine.formerIds(named);
  if (found.length === 0) return new Map();
  const reached = new Set(reachable(principal, await engine.listProjects()).map((project) => project.id));
  return new Map(found.filter((former) => reached.has(former.projectId)).map((former) => [former.formerId, former]));
}

/** What a sender may see of the links between tasks. */
export interface LinkView {
  /** The task without its links to and from tasks in projects the sender cannot reach. */
  task(task: Task): Task;
  /** The event without such links in the dependencies it records. */
  event(event: TaskEvent): TaskEvent;
}

const EVERY_LINK: LinkView = Object.freeze({ task: (task: Task) => task, event: (event: TaskEvent) => event });

/**
 * The links a sender may see. A link to a task in a project the sender cannot
 * reach would show that task's id, title and status, so it is left out; the
 * other task's project is the one whose prefix its id starts with. A sender
 * who reaches every project sees every link.
 */
export async function linksSeenBy({ engine, principal }: Reader): Promise<LinkView> {
  if (principal.projects === 'all') return EVERY_LINK;
  const prefixes = new Set(reachable(principal, await engine.listProjects()).map((project) => project.prefix));
  const seen = (taskId: unknown) => typeof taskId === 'string' && prefixes.has(taskId.slice(0, taskId.indexOf('-')));
  const links = <T extends { readonly taskId: string }>(list: readonly T[]) => list.filter((link) => seen(link.taskId));
  return {
    task: (task) => ({
      ...task,
      dependencies: links(task.dependencies),
      dependents: links(task.dependents),
      reliesOnDropped: links(task.reliesOnDropped),
    }),
    event(event) {
      const recorded = event.changes.dependencies;
      if (!Array.isArray(recorded)) return event;
      const kept = (recorded as readonly Json[]).filter((entry) => seen((entry as { taskId?: Json } | null)?.taskId));
      return { ...event, changes: { ...event.changes, dependencies: kept } };
    },
  };
}
