/**
 * The project and the tasks a call names, among those its sender reaches.
 * A project the sender cannot reach is refused as if it did not exist, so a
 * sender learns nothing of another's projects. The MCP tools and the HTTP
 * writes share these, and their refusals.
 */
import type { Project, Task, TaskEngine } from '@ntasks/domain';
import { mayReach, reachable, type Principal, type ProjectAccess } from './auth.ts';
import { Refused } from './refused.ts';

export interface Reader {
  readonly engine: TaskEngine;
  readonly principal: Principal;
}

export const projectNamed = (project: Project) => `projectId ${project.id} (${project.name})`;

/** The project a call names, or a refusal that says how to find one. With
 * `write`, a project the sender may only read is refused for that. */
export async function projectOf(
  { engine, principal }: Reader,
  projectId: string,
  access: ProjectAccess = 'read',
): Promise<Project> {
  const project = reachable(principal, await engine.listProjects()).find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new Refused(
      'not_found',
      `refused: projectId ${projectId} names no project in this workspace; list_projects lists the current projectIds.`,
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
