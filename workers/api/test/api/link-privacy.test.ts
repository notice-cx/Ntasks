// A sender granted some projects sees no link to a task in a project it
// cannot reach: neither a task's links, as every read and write answer shows
// them, nor the links its history and the change feed record.
import type { Project, Task, TaskEngine } from '@ntasks/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { linksSeenBy } from '../../src/lookup.ts';
import { clock, newProject, OWNER } from '../engine/helpers.ts';
import { api, get, granted, read, send, write, WRITER, type TestApi } from './helpers.ts';

const time = clock('2026-11-06T12:00:00.000Z');
let engine: TaskEngine;
let owner: TestApi;
let sender: TestApi;
let a: Project;
let b: Project;
let near: Task;
let far: Task;
let linked: Task;

beforeAll(async () => {
  owner = api({ principal: WRITER, now: time.now });
  engine = owner.engine;
  a = await newProject(engine);
  b = await newProject(engine);
  sender = api({ principal: granted({ [a.id]: 'write' }), engine, now: time.now });
  near = (await engine.createTask(a.id, { title: 'Near' }, OWNER)).task;
  far = (await engine.createTask(b.id, { title: 'Far away' }, OWNER)).task;
  linked = (
    await engine.createTask(
      a.id,
      {
        title: 'Linked',
        links: [
          { direction: 'depends-on', taskId: near.id, type: 'related' },
          { direction: 'depends-on', taskId: far.id, type: 'related' },
        ],
      },
      OWNER,
    )
  ).task;
  // A link from the far task onto this one makes it one of this task's dependents.
  await engine.writeTask(
    b.id,
    far.id,
    { expectedVersion: 1, addLinks: [{ taskId: linked.id, type: 'blocks' }] },
    OWNER,
  );
});

const linkIds = (task: { dependencies: { id: string }[] }) => task.dependencies.map((link) => link.id);

describe('links to a task in a project the sender cannot reach', () => {
  it('leave the task its engine read', async () => {
    const task = (await engine.getTask(a.id, linked.id))!;
    expect(task.dependencies.map((link) => link.taskId).sort()).toEqual([far.id, near.id].sort());
    expect(task.dependents.map((link) => link.taskId)).toEqual([far.id]);
  });

  it('are left out of the task a sender sees, whichever way the link points', async () => {
    const task = (await engine.getTask(a.id, linked.id))!;
    const seen = (await linksSeenBy({ engine, principal: granted({ [a.id]: 'read' }) })).task(task);
    expect(seen.dependencies.map((link) => link.taskId)).toEqual([near.id]);
    expect(seen.dependents).toEqual([]);
    expect((await linksSeenBy({ engine, principal: WRITER })).task(task)).toBe(task);
  });

  it('are left out of get_task and list_tasks, for that sender only', async () => {
    const mine = await read<{ task: { dependencies: { id: string }[] } }>(sender, 'get_task', {
      project: a.id,
      task: linked.id,
    });
    expect(linkIds(mine.task)).toEqual([near.id]);
    const owners = await read<{ task: { dependencies: { id: string }[] } }>(owner, 'get_task', {
      project: a.id,
      task: linked.id,
    });
    expect(linkIds(owners.task).sort()).toEqual([far.id, near.id].sort());
    const listed = await read<{ tasks: Record<string, unknown>[] }>(sender, 'list_tasks', { project: a.id });
    expect(JSON.stringify(listed)).not.toContain(far.id);
  });

  it('are left out of a write answer', async () => {
    const reply = await write<{ task: { dependencies: { id: string }[] } }>(sender, 'update_task', {
      project: a.id,
      task: linked.id,
      priority: 1,
      idempotency_key: `key-${crypto.randomUUID()}`,
    });
    expect(linkIds(reply.task)).toEqual([near.id]);
    const patched = await send(sender, 'PATCH', `/api/tasks/${linked.id}`, { projectId: a.id, priority: 0 });
    expect(linkIds(patched.body.task as { dependencies: { id: string }[] })).toEqual([near.id]);
  });

  it('are left out of the HTTP task, board, history and change feed', async () => {
    const task = await get(sender, `/api/tasks/${linked.id}?project=${a.id}`);
    expect(linkIds(task.body.task as { dependencies: { id: string }[] })).toEqual([near.id]);
    const board = await get(sender, `/api/tasks?project=${a.id}`);
    expect(JSON.stringify(board.body)).not.toContain(far.id);
    const history = await get(sender, `/api/tasks/${linked.id}/history?project=${a.id}`);
    expect(JSON.stringify(history.body)).not.toContain(far.id);
    const feed = await get(sender, `/api/changes?project=${a.id}&limit=200`);
    expect(JSON.stringify(feed.body)).not.toContain(far.id);
    // The owner sees the link in each of them.
    expect(JSON.stringify((await get(owner, `/api/tasks/${linked.id}/history?project=${a.id}`)).body)).toContain(
      far.id,
    );
    expect(JSON.stringify((await get(owner, `/api/changes?project=${a.id}&limit=200`)).body)).toContain(far.id);
  });

  it('are left out of get_task_history, its field changes and its snapshots', async () => {
    for (const snapshots of [false, true]) {
      const history = await read<Record<string, unknown>>(sender, 'get_task_history', {
        project: a.id,
        task: linked.id,
        snapshots,
      });
      expect(JSON.stringify(history), `snapshots ${snapshots}`).not.toContain(far.id);
      expect(JSON.stringify(history), `snapshots ${snapshots}`).toContain(near.id);
    }
  });
});
