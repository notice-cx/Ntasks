// A move puts tasks in a project under a parent. A task from another project
// takes an id with the new project's prefix, and its old id stays a former id
// that names it.
import { NTASKS_ACTOR, type CreateTaskInput, type Task, type TaskEngine, type TaskPlacement } from '@ntasks/domain';
import { describe, expect, it } from 'vitest';
import { AGENT, engine, expectRefusal, newProject, OWNER, retryFor } from './helpers.ts';

async function make(tasks: TaskEngine, projectId: string, input: CreateTaskInput): Promise<Task> {
  return (await tasks.createTask(projectId, input, AGENT)).task;
}

async function read(tasks: TaskEngine, projectId: string, taskId: string): Promise<Task> {
  return (await tasks.getTask(projectId, taskId))!;
}

async function close(tasks: TaskEngine, task: Task, extra: { pullRequest?: string; duplicateOf?: string } = {}) {
  const current = await read(tasks, task.projectId, task.id);
  return tasks.writeTask(
    task.projectId,
    task.id,
    {
      expectedVersion: current.version,
      close: { reason: 'Finished', resolution: extra.duplicateOf === undefined ? 'done' : 'duplicate', ...extra },
    },
    AGENT,
  );
}

/** A placement of `task` as it stands now, under `parentId`. */
async function placing(tasks: TaskEngine, task: Task, parentId: string | null): Promise<TaskPlacement> {
  return { taskId: task.id, expectedVersion: (await read(tasks, task.projectId, task.id)).version, parentId };
}

/** Every row the store holds for these ids, to show a refused move changed nothing. */
async function standing(tasks: TaskEngine, projectId: string, ids: readonly string[]) {
  return {
    tasks: await tasks.getTasks(projectId, ids),
    formerIds: await tasks.formerIds(ids),
  };
}

describe('a move to another project', () => {
  it('gives the task an id with its prefix and takes its comments, history, labels, links and field values along', async () => {
    const tasks = engine();
    const [from, to] = [await newProject(tasks), await newProject(tasks)];
    await tasks.defineField(from.id, { key: 'area', name: 'Area', type: 'text' }, OWNER);
    const blocker = await make(tasks, from.id, { title: 'Pick the host' });
    const task = await make(tasks, from.id, {
      title: 'Write the runbook',
      labels: ['docs'],
      links: [{ direction: 'depends-on', taskId: blocker.id, type: 'blocks' }],
      externalLinks: [{ url: 'https://example.com/runbook', title: 'Draft' }],
      fields: { area: 'ops' },
    });
    const relying = await make(tasks, from.id, {
      title: 'Train the team',
      links: [{ direction: 'depends-on', taskId: task.id, type: 'related' }],
    });
    await tasks.addComment(from.id, task.id, 'Started on the outline.', AGENT);

    const result = await tasks.moveTasks(to.id, [await placing(tasks, task, null)], OWNER);

    const newId = result.tasks[0]!.id;
    expect(newId).toMatch(new RegExp(`^${to.prefix}-[a-z0-9]+$`, 'u'));
    expect(result.moved).toEqual([{ from: task.id, to: newId }]);
    expect(await tasks.getTask(from.id, task.id)).toBeNull();
    expect(await read(tasks, to.id, newId)).toMatchObject({
      projectId: to.id,
      parentId: null,
      title: 'Write the runbook',
      labels: ['docs'],
      fields: { area: 'ops' },
      dependencies: [{ taskId: blocker.id, type: 'blocks' }],
      dependents: [{ taskId: relying.id, type: 'related' }],
      externalLinks: [{ url: 'https://example.com/runbook', title: 'Draft' }],
      version: task.version + 1,
    });
    expect((await read(tasks, from.id, relying.id)).dependencies).toMatchObject([{ taskId: newId, type: 'related' }]);
    expect((await tasks.listComments(to.id, newId)).map((comment) => comment.text)).toEqual([
      'Started on the outline.',
    ]);
    const history = await tasks.listHistory(to.id, newId, { limit: 10 });
    expect(history.map((event) => [event.kind, event.projectId])).toEqual([
      ['updated', to.id],
      ['commented', from.id],
      ['created', from.id],
    ]);
    expect(history[0]!.changes).toEqual({ id: newId, projectId: to.id });
    expect(await tasks.formerIds([task.id, blocker.id])).toEqual([
      { formerId: task.id, taskId: newId, projectId: to.id },
    ]);
  });

  it('keeps a closed task’s delivery, which a signal naming its pull request moves on', async () => {
    const tasks = engine();
    const [from, to] = [await newProject(tasks), await newProject(tasks)];
    const task = await make(tasks, from.id, { title: 'Ship the page' });
    await close(tasks, task, { pullRequest: 'https://github.com/example/site/pull/7' });

    const [moved] = (await tasks.moveTasks(to.id, [await placing(tasks, task, null)], OWNER)).tasks;
    const signal = { stage: 'merged' as const, pullRequests: ['https://github.com/example/site/pull/7'], commits: [] };
    const delivered = await tasks.reportDelivery([from.id, to.id], signal, AGENT);

    expect(moved!.delivery).toMatchObject({ stage: 'built', pullRequest: 'https://github.com/example/site/pull/7' });
    expect(delivered).toEqual([{ taskId: moved!.id, projectId: to.id, stage: 'merged' }]);
  });

  it('moves the tasks under it along, each taking the next child id of its new parent', async () => {
    const tasks = engine();
    const [from, to] = [await newProject(tasks), await newProject(tasks)];
    const epic = await make(tasks, from.id, { title: 'Launch', type: 'epic' });
    const first = await make(tasks, from.id, { title: 'Pick the date', parentId: epic.id });
    const second = await make(tasks, from.id, { title: 'Write the post', parentId: epic.id });
    const under = await make(tasks, from.id, { title: 'Draft it', parentId: second.id });
    await close(tasks, first);
    const target = await make(tasks, to.id, { title: 'Marketing', type: 'epic' });
    await make(tasks, to.id, { title: 'Brand', parentId: target.id });

    const result = await tasks.moveTasks(
      to.id,
      [
        await placing(tasks, epic, target.id),
        await placing(tasks, first, epic.id),
        await placing(tasks, second, epic.id),
        await placing(tasks, under, second.id),
      ],
      OWNER,
    );

    expect(result.moved).toEqual([
      { from: epic.id, to: `${target.id}.2` },
      { from: first.id, to: `${target.id}.2.1` },
      { from: second.id, to: `${target.id}.2.2` },
      { from: under.id, to: `${target.id}.2.2.1` },
    ]);
    expect(result.tasks.map((task) => [task.id, task.parentId, task.status])).toEqual([
      [`${target.id}.2`, target.id, 'open'],
      [`${target.id}.2.1`, `${target.id}.2`, 'closed'],
      [`${target.id}.2.2`, `${target.id}.2`, 'open'],
      [`${target.id}.2.2.1`, `${target.id}.2.2`, 'open'],
    ]);
  });

  it('follows the task with the tasks closed as its duplicates, each with a change in its history', async () => {
    const tasks = engine();
    const [from, to] = [await newProject(tasks), await newProject(tasks)];
    const task = await make(tasks, from.id, { title: 'Fix the footer' });
    const again = await make(tasks, from.id, { title: 'Footer is broken' });
    await close(tasks, again, { duplicateOf: task.id });
    const closedVersion = (await read(tasks, from.id, again.id)).version;

    const [moved] = (await tasks.moveTasks(to.id, [await placing(tasks, task, null)], OWNER)).tasks;

    const duplicate = await read(tasks, from.id, again.id);
    expect(duplicate).toMatchObject({ version: closedVersion + 1, close: { duplicateOf: moved!.id } });
    const [change] = await tasks.listHistory(from.id, again.id, { limit: 1 });
    expect(change).toMatchObject({
      kind: 'updated',
      changes: { close: { duplicateOf: moved!.id, reason: 'Finished' } },
    });
  });

  it('keeps every former id naming the task as it moves again, and never gives one to a new task', async () => {
    const tasks = engine();
    const [first, second, third] = [await newProject(tasks), await newProject(tasks), await newProject(tasks)];
    const parent = await make(tasks, first.id, { title: 'Release', type: 'epic' });
    const child = await make(tasks, first.id, { title: 'Tag it', parentId: parent.id });

    const [middle] = (await tasks.moveTasks(second.id, [await placing(tasks, child, null)], OWNER)).tasks;
    const [last] = (await tasks.moveTasks(third.id, [await placing(tasks, middle!, null)], OWNER)).tasks;
    const next = await make(tasks, first.id, { title: 'Announce it', parentId: parent.id });

    expect(await tasks.formerIds([child.id, middle!.id, last!.id])).toEqual(
      [
        { formerId: child.id, taskId: last!.id, projectId: third.id },
        { formerId: middle!.id, taskId: last!.id, projectId: third.id },
      ].sort((a, b) => (a.formerId < b.formerId ? -1 : 1)),
    );
    expect(child.id).toBe(`${parent.id}.1`);
    expect(next.id).toBe(`${parent.id}.2`);
  });

  it('answers a move repeated with its key with the first answer, moving nothing again', async () => {
    const tasks = engine();
    const [from, to] = [await newProject(tasks), await newProject(tasks)];
    const task = await make(tasks, from.id, { title: 'Rename the repo' });
    const placement = await placing(tasks, task, null);
    const retry = await retryFor('move-0001', { placement }, 'move_tasks');

    const first = await tasks.moveTasks(to.id, [placement], OWNER, retry);
    const again = await tasks.moveTasks(to.id, [placement], OWNER, retry);

    expect(again).toEqual({ ...first, replayed: true });
    expect(await tasks.recordedMove(to.id, retry)).toEqual({ ...first, replayed: true });
    expect((await tasks.listHistory(to.id, first.tasks[0]!.id, { limit: 10 })).length).toBe(2);
  });
});

describe('a refused move changes nothing', () => {
  it('when a task leaves its project without a task under it', async () => {
    const tasks = engine();
    const [from, to] = [await newProject(tasks), await newProject(tasks)];
    const epic = await make(tasks, from.id, { title: 'Launch', type: 'epic' });
    const child = await make(tasks, from.id, { title: 'Pick the date', parentId: epic.id });
    const before = await standing(tasks, from.id, [epic.id, child.id]);

    const refused = await expectRefusal(tasks.moveTasks(to.id, [await placing(tasks, epic, null)], OWNER), 'invalid');

    expect(refused.message).toContain(child.id);
    expect(await standing(tasks, from.id, [epic.id, child.id])).toEqual(before);
  });

  it('when a parent is in another project, a task would go under itself, or a task changed since it was read', async () => {
    const tasks = engine();
    const [project, other] = [await newProject(tasks), await newProject(tasks)];
    const epic = await make(tasks, project.id, { title: 'Launch', type: 'epic' });
    const child = await make(tasks, project.id, { title: 'Pick the date', parentId: epic.id });
    const elsewhere = await make(tasks, other.id, { title: 'Brand', type: 'epic' });
    const before = await standing(tasks, project.id, [epic.id, child.id]);

    await expectRefusal(tasks.moveTasks(project.id, [await placing(tasks, child, elsewhere.id)], OWNER), 'not_found');
    await expectRefusal(tasks.moveTasks(project.id, [await placing(tasks, epic, child.id)], OWNER), 'cycle');
    await expectRefusal(
      tasks.moveTasks(project.id, [{ taskId: child.id, expectedVersion: child.version + 1, parentId: null }], OWNER),
      'version_conflict',
    );
    await expectRefusal(
      tasks.moveTasks(other.id, [await placing(tasks, epic, null), await placing(tasks, child, child.id)], OWNER),
      'cycle',
    );

    expect(await standing(tasks, project.id, [epic.id, child.id])).toEqual(before);
  });
});

describe('a move to another epic', () => {
  it('keeps the id in the same project, and records the new parent', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const [left, joined] = [
      await make(tasks, project.id, { title: 'Spring', type: 'epic' }),
      await make(tasks, project.id, { title: 'Summer', type: 'epic' }),
    ];
    const task = await make(tasks, project.id, { title: 'Plan the trip', parentId: left.id });
    await make(tasks, project.id, { title: 'Book the hall', parentId: left.id });

    const result = await tasks.moveTasks(project.id, [await placing(tasks, task, joined.id)], OWNER);

    expect(result.moved).toEqual([]);
    expect(result.tasks[0]).toMatchObject({ id: task.id, parentId: joined.id, version: task.version + 1 });
    expect((await tasks.listHistory(project.id, task.id, { limit: 1 }))[0]!.changes).toEqual({ parentId: joined.id });
  });

  it('closes the epic left with no open task, and the epic a closed task joins when that leaves none open', async () => {
    const tasks = engine();
    const [from, to] = [await newProject(tasks), await newProject(tasks)];
    const left = await make(tasks, from.id, { title: 'Spring', type: 'epic' });
    const done = await make(tasks, from.id, { title: 'Book the hall', parentId: left.id });
    const open = await make(tasks, from.id, { title: 'Plan the trip', parentId: left.id });
    await close(tasks, done);
    const joined = await make(tasks, to.id, { title: 'Summer', type: 'epic' });
    const finished = await make(tasks, from.id, { title: 'Order the posters' });
    await close(tasks, finished);

    const result = await tasks.moveTasks(
      to.id,
      [await placing(tasks, open, null), await placing(tasks, finished, joined.id)],
      OWNER,
    );

    const movedIn = result.moved.find((moved) => moved.from === finished.id)!.to;
    expect(result.epics?.map((epic) => [epic.id, epic.status, epic.close?.by])).toEqual(
      expect.arrayContaining([
        [left.id, 'closed', NTASKS_ACTOR],
        [joined.id, 'closed', NTASKS_ACTOR],
      ]),
    );
    expect((await read(tasks, to.id, joined.id)).close?.reason).toContain(movedIn);
    expect((await read(tasks, from.id, left.id)).close?.reason).toContain(result.moved[0]!.to);
  });
});
