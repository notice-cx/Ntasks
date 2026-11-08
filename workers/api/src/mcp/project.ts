/**
 * The project an MCP tool call acts in. A call may name it by projectId, key
 * or prefix. A call that names a task needs none, since a task id's prefix
 * names its project; a new task without one is filed beside the first task it
 * names that stays in its project, else in the sender's only writable
 * project. Each answers with the project as the task writes take it, which
 * then check the sender's access, so a project the sender cannot reach is
 * refused as one that does not exist.
 */
import { isTaskId } from '@ntasks/domain';
import { listed, projectArg, type Args } from '../args.ts';
import { mayReach, reachable } from '../auth.ts';
import { projectOfTask, type Reader } from '../lookup.ts';
import { Refused } from '../refused.ts';

/** How many projects a refusal lists before pointing to list_projects. */
const LISTED = 10;

/** The project of a call that names `taskId`: the one it names, else the id's. */
export async function projectFor(reader: Reader, args: Args, taskId: string): Promise<string> {
  if (args.project !== undefined) return projectArg(args);
  return (await projectOfTask(reader, taskId)).id;
}

/**
 * The project a new task is filed in: the one the call names, else that of
 * the first of `named` that is a task id (its parent, then the tasks it
 * depends on, blocks or was found from, which stay in its project), else the
 * sender's only writable project.
 */
export async function projectForNew(reader: Reader, args: Args, named: readonly unknown[]): Promise<string> {
  if (args.project !== undefined) return projectArg(args);
  const first = named.find(isTaskId);
  if (first !== undefined) return (await projectOfTask(reader, first)).id;
  const { engine, principal } = reader;
  const writable = reachable(principal, await engine.listProjects()).filter((project) =>
    mayReach(principal, project.id, 'write'),
  );
  if (writable.length === 1) return writable[0]!.id;
  if (writable.length === 0) {
    throw new Refused(
      'forbidden',
      'refused: you may file tasks in no project of this workspace; list_workspaces shows what you may do in each.',
    );
  }
  const names = writable.slice(0, LISTED).map((project) => `${project.key} (prefix ${project.prefix})`);
  const more = writable.length - names.length;
  throw new Refused(
    'invalid',
    `invalid arguments: project (required: you may file tasks in ${writable.length} projects; name one by key or prefix: ` +
      `${more > 0 ? `${names.join(', ')} and ${more} more, which list_projects lists` : listed(names)})`,
  );
}
