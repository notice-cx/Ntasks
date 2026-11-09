/** Steps the checks share: filing a task to work on, reading it, and the actor a server records for a sender. */
import { randomBytes } from 'node:crypto';
import type { Api, NewTask, Role, Task } from '../api.ts';
import { answered, type Context } from '../check.ts';

/** Files a task through the setup binding and answers its id. */
export async function file(context: Context, task: Partial<NewTask> = {}, role: Role = 'agent'): Promise<string> {
  const written = answered(
    await context.setup(role).create({ ...task, title: task.title ?? context.unique('task') }),
    'filing a task',
  );
  return written.id;
}

export async function taskOf(api: Api, id: string): Promise<Task> {
  return answered(await api.read(id), `reading ${id}`).task;
}

/** The actor a server records for `role`: the holder it names on a claim. */
export async function actorOf(context: Context, role: Role): Promise<string> {
  const id = await file(context, { title: context.unique(`${role} signs a claim`) }, role);
  answered(await context.setup(role).claim(id), `${role} claiming ${id}`);
  const holder = (await taskOf(context.setup(role), id)).assignee;
  answered(await context.setup(role).update(id, { assignee: '' }), `${role} releasing ${id}`);
  if (typeof holder !== 'string' || holder === '') throw new Error(`${role}'s claim of ${id} named no holder`);
  return holder;
}

/** A commit's name: 40 random lowercase hexadecimal characters. */
export function commitName(): string {
  return randomBytes(20).toString('hex');
}

/** A date a year from now, as `YYYY-MM-DD`. */
export function nextYear(): string {
  return new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/** The links a task holds onto `to`. */
export function linksTo(task: Task, to: string): readonly string[] {
  return (task.dependencies ?? []).filter((link) => link.id === to).map((link) => link.type);
}

/** Two agents' calls sent at the same moment. */
export function together<A, B>(first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
  return Promise.all([first(), second()]);
}
