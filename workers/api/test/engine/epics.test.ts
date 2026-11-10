// An epic is a container with no work of its own (STATE-22): the write that
// leaves every task under it closed closes it too, recorded as Ntasks's
// change, and the write that opens one of them again reopens it.
import { NTASKS_ACTOR, type CreateTaskInput, type Task, type TaskEngine, type TaskResolution } from '@ntasks/domain';
import { describe, expect, it } from 'vitest';
import type { Database } from '../../src/engine/database.ts';
import { createEngine } from '../../src/engine/index.ts';
import { storeDatabase } from '../store.ts';
import { AGENT, engine, expectRefusal, newProject, OWNER } from './helpers.ts';

async function make(tasks: TaskEngine, projectId: string, input: CreateTaskInput): Promise<Task> {
  return (await tasks.createTask(projectId, input, AGENT)).task;
}

async function read(tasks: TaskEngine, projectId: string, taskId: string): Promise<Task> {
  return (await tasks.getTask(projectId, taskId))!;
}

async function close(tasks: TaskEngine, projectId: string, taskId: string, resolution: TaskResolution = 'done') {
  const current = await read(tasks, projectId, taskId);
  return tasks.writeTask(
    projectId,
    taskId,
    { expectedVersion: current.version, close: { reason: 'Finished', resolution } },
    AGENT,
  );
}

async function reopen(tasks: TaskEngine, projectId: string, taskId: string) {
  const current = await read(tasks, projectId, taskId);
  return tasks.writeTask(projectId, taskId, { expectedVersion: current.version, reopen: true }, AGENT);
}

/** An engine whose next batch first runs the hook a test sets, as another write landing between a write's read and its batch. */
function racedEngine() {
  const inner = storeDatabase();
  const race: { before: (() => Promise<unknown>) | null } = { before: null };
  const db: Database = {
    prepare: (sql) => inner.prepare(sql),
    async batch(statements) {
      const hook = race.before;
      race.before = null;
      if (hook) await hook();
      return inner.batch(statements);
    },
  };
  return { tasks: createEngine(db), inner, race };
}

/** An epic with `count` tasks under it. */
async function epicWith(tasks: TaskEngine, projectId: string, count: number, epic: Partial<CreateTaskInput> = {}) {
  const made = await make(tasks, projectId, { title: 'Launch', type: 'epic', ...epic });
  const children: Task[] = [];
  for (let index = 1; index <= count; index += 1)
    children.push(await make(tasks, projectId, { title: `Part ${index}`, parentId: made.id }));
  return { epic: made, children };
}

describe('an epic closes when its last open task does', () => {
  it('closes as done in the same write, by Ntasks, naming the task that closed last, and clears its holder’s work', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { epic, children } = await epicWith(tasks, project.id, 2);
    await tasks.writeTask(
      project.id,
      epic.id,
      { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress', work: { next: 'Ship both parts' } } },
      AGENT,
    );
    await close(tasks, project.id, children[0]!.id);
    expect((await read(tasks, project.id, epic.id)).status).toBe('in_progress');

    const result = await close(tasks, project.id, children[1]!.id);

    const closed = await read(tasks, project.id, epic.id);
    expect(closed).toMatchObject({ status: 'closed', work: {}, assigneeFor: null });
    expect(closed.close).toMatchObject({ resolution: 'done', by: NTASKS_ACTOR, model: null });
    expect(closed.close?.reason).toContain(children[1]!.id);
    expect(result.epics?.map((task) => [task.id, task.status])).toEqual([[epic.id, 'closed']]);
    const [event] = await tasks.listHistory(project.id, epic.id, { limit: 1 });
    expect(event).toMatchObject({ kind: 'closed', actor: NTASKS_ACTOR, version: closed.version });
  });

  it('closes as done when any task under it closed as done, and as no longer needed when none shipped', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const mixed = await epicWith(tasks, project.id, 2);
    const dropped = await epicWith(tasks, project.id, 2);

    await close(tasks, project.id, mixed.children[0]!.id, 'wont-do');
    await close(tasks, project.id, mixed.children[1]!.id, 'done');
    await close(tasks, project.id, dropped.children[0]!.id, 'wont-do');
    await close(tasks, project.id, dropped.children[1]!.id, 'no-longer-needed');

    expect((await read(tasks, project.id, mixed.epic.id)).close?.resolution).toBe('done');
    expect((await read(tasks, project.id, dropped.epic.id)).close?.resolution).toBe('no-longer-needed');
  });

  it('closes a nested epic, then the epic above it when that was its last open task', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const outer = await make(tasks, project.id, { title: 'Release', type: 'epic' });
    const inner = await make(tasks, project.id, { title: 'Docs', type: 'epic', parentId: outer.id });
    const page = await make(tasks, project.id, { title: 'Write the page', parentId: inner.id });

    const result = await close(tasks, project.id, page.id, 'wont-do');

    expect(result.epics?.map((task) => task.id)).toEqual([inner.id, outer.id]);
    const above = await read(tasks, project.id, outer.id);
    expect(above.close).toMatchObject({ resolution: 'no-longer-needed', by: NTASKS_ACTOR });
    expect(above.close?.reason).toContain(inner.id);
  });

  it('closes an epic in the write that takes its keep-open label off', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { epic, children } = await epicWith(tasks, project.id, 1, { labels: ['keep-open'] });
    await close(tasks, project.id, children[0]!.id);

    const result = await tasks.writeTask(
      project.id,
      epic.id,
      { expectedVersion: (await read(tasks, project.id, epic.id)).version, removeLabels: ['keep-open'] },
      AGENT,
    );

    expect(result.epics?.map((task) => task.id)).toEqual([epic.id]);
    expect(await read(tasks, project.id, epic.id)).toMatchObject({
      status: 'closed',
      labels: [],
      close: { by: NTASKS_ACTOR, resolution: 'done' },
    });
  });

  it('decides again when another task under the epic closes between its read and its batch', async () => {
    const { tasks, race } = racedEngine();
    const project = await newProject(tasks);
    const { epic, children } = await epicWith(tasks, project.id, 2);
    // The other task closes after this write read it as open.
    race.before = () => close(tasks, project.id, children[1]!.id);

    const before = await read(tasks, project.id, children[0]!.id);
    await expectRefusal(close(tasks, project.id, children[0]!.id), 'version_conflict');
    // The refused batch wrote nothing: not the task's close, nor the epic's.
    expect(await read(tasks, project.id, children[0]!.id)).toMatchObject({ status: 'open', version: before.version });
    expect((await read(tasks, project.id, epic.id)).status).toBe('open');
    const [latest] = await tasks.listHistory(project.id, epic.id, { limit: 1 });
    expect(latest?.kind).not.toBe('closed');

    await close(tasks, project.id, children[0]!.id);
    expect((await read(tasks, project.id, epic.id)).status).toBe('closed');
  });

  it('decides again when how another task under the epic closed changes between its read and its batch', async () => {
    const { tasks, inner, race } = racedEngine();
    const project = await newProject(tasks);
    const { epic, children } = await epicWith(tasks, project.id, 2);
    await close(tasks, project.id, children[0]!.id, 'wont-do');
    // Read as won't do, the other task is done by the batch: the epic is done, not no longer needed.
    race.before = () => inner.prepare("UPDATE tasks SET resolution = 'done', version = version + 1 WHERE id = ?1").bind(children[0]!.id).run();

    await expectRefusal(close(tasks, project.id, children[1]!.id, 'wont-do'), 'version_conflict');
    await close(tasks, project.id, children[1]!.id, 'wont-do');

    expect((await read(tasks, project.id, epic.id)).close?.resolution).toBe('done');
  });

  it('closes the epics above the 70 tasks one write closes together', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const outer = await make(tasks, project.id, { title: 'Release', type: 'epic' });
    const { epic, children } = await epicWith(tasks, project.id, 70, { parentId: outer.id });
    const [first, ...rest] = children;

    await tasks.writeTask(
      project.id,
      first!.id,
      {
        expectedVersion: 1,
        close: { reason: 'Finished', resolution: 'done' },
        others: rest.map((child) => ({
          taskId: child.id,
          expectedVersion: 1,
          close: { reason: 'Finished', resolution: 'done' },
        })),
      },
      AGENT,
    );

    for (const id of [epic.id, outer.id]) expect((await read(tasks, project.id, id)).status).toBe('closed');
  });

  it('closes an epic, naming the closed task that moved into it', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { epic, children } = await epicWith(tasks, project.id, 1);
    await close(tasks, project.id, children[0]!.id);
    await tasks.writeTask(
      project.id,
      epic.id,
      { expectedVersion: (await read(tasks, project.id, epic.id)).version, reopen: true },
      OWNER,
    );
    const finished = await make(tasks, project.id, { title: 'Written elsewhere' });
    await close(tasks, project.id, finished.id);

    await tasks.writeTask(project.id, finished.id, { expectedVersion: 2, set: { parentId: epic.id } }, AGENT);

    const closed = await read(tasks, project.id, epic.id);
    expect(closed.close).toMatchObject({ by: NTASKS_ACTOR, resolution: 'done' });
    expect(closed.close?.reason).toMatch(new RegExp(`${finished.id}, already closed, moved into it`, 'u'));
  });

  it('closes an epic whose last open task moves out of it', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { epic, children } = await epicWith(tasks, project.id, 2);
    const other = await make(tasks, project.id, { title: 'Next quarter', type: 'epic' });
    await close(tasks, project.id, children[0]!.id);

    await tasks.writeTask(project.id, children[1]!.id, { expectedVersion: 1, set: { parentId: other.id } }, AGENT);

    expect(await read(tasks, project.id, epic.id)).toMatchObject({ status: 'closed', close: { by: NTASKS_ACTOR } });
    expect((await read(tasks, project.id, other.id)).status).toBe('open');
  });
});

describe('an epic that stays open', () => {
  it('with no task under it, even once its only task moves out', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { epic, children } = await epicWith(tasks, project.id, 1);

    await tasks.writeTask(project.id, children[0]!.id, { expectedVersion: 1, set: { parentId: null } }, AGENT);

    expect((await read(tasks, project.id, epic.id)).status).toBe('open');
  });

  it('labelled keep-open', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { epic, children } = await epicWith(tasks, project.id, 1, { labels: ['keep-open'] });

    const result = await close(tasks, project.id, children[0]!.id);

    expect(result.epics).toBeUndefined();
    expect((await read(tasks, project.id, epic.id)).status).toBe('open');
  });
});

describe('an epic Ntasks closed', () => {
  it('reopens, with the epic above it, when a task under it reopens', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const outer = await make(tasks, project.id, { title: 'Release', type: 'epic' });
    const inner = await make(tasks, project.id, { title: 'Docs', type: 'epic', parentId: outer.id });
    const page = await make(tasks, project.id, { title: 'Write the page', parentId: inner.id });
    await close(tasks, project.id, page.id);

    const result = await reopen(tasks, project.id, page.id);

    expect(result.epics?.map((task) => [task.id, task.status])).toEqual([
      [inner.id, 'open'],
      [outer.id, 'open'],
    ]);
    expect((await read(tasks, project.id, inner.id)).close).toBeNull();
    const [event] = await tasks.listHistory(project.id, outer.id, { limit: 1 });
    expect(event).toMatchObject({ kind: 'reopened', actor: NTASKS_ACTOR });
  });

  it('reopens when an open task is filed under it', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { epic, children } = await epicWith(tasks, project.id, 1);
    await close(tasks, project.id, children[0]!.id);

    const { epics } = await tasks.createTask(project.id, { title: 'One more part', parentId: epic.id }, AGENT);

    expect(epics?.map((task) => task.id)).toEqual([epic.id]);
    expect((await read(tasks, project.id, epic.id)).status).toBe('open');
  });

  it('closes the epic above when a close by a person replaces its own close of an epic under it', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const outer = await make(tasks, project.id, { title: 'Release', type: 'epic' });
    const inner = await make(tasks, project.id, { title: 'Docs', type: 'epic', parentId: outer.id });
    const page = await make(tasks, project.id, { title: 'Write the page', parentId: inner.id });
    await close(tasks, project.id, page.id);
    await tasks.writeTask(
      project.id,
      outer.id,
      { expectedVersion: (await read(tasks, project.id, outer.id)).version, reopen: true },
      OWNER,
    );

    await tasks.writeTask(
      project.id,
      inner.id,
      {
        expectedVersion: (await read(tasks, project.id, inner.id)).version,
        close: { reason: 'The docs shipped', resolution: 'done' },
      },
      OWNER,
    );

    expect(await read(tasks, project.id, outer.id)).toMatchObject({ status: 'closed', close: { by: NTASKS_ACTOR } });
  });

  it('takes a close by an agent in place of its own, which a reopened task then leaves closed', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { epic, children } = await epicWith(tasks, project.id, 1);
    await close(tasks, project.id, children[0]!.id);
    const closed = await read(tasks, project.id, epic.id);

    await tasks.writeTask(
      project.id,
      epic.id,
      { expectedVersion: closed.version, close: { reason: 'Shipped in the 2.0 release', resolution: 'done' } },
      OWNER,
    );
    await reopen(tasks, project.id, children[0]!.id);

    expect(await read(tasks, project.id, epic.id)).toMatchObject({
      status: 'closed',
      close: { by: OWNER.name, reason: 'Shipped in the 2.0 release' },
    });
  });
});
