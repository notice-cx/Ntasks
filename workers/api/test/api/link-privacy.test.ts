// A sender granted some projects sees no link, of any type, to a task in a
// project it cannot reach: neither a task's links, as every read and write
// answer shows them, nor the links its history and the change feed record.
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
let nearOld: Task;
let far: Task;
let farFirst: Task;
let farOld: Task;
let linked: Task;
/** Every task the sender cannot reach that `linked` links to or from. */
const hidden = () => [far.id, farFirst.id, farOld.id];

beforeAll(async () => {
  owner = api({ principal: WRITER, now: time.now });
  engine = owner.engine;
  a = await newProject(engine);
  b = await newProject(engine);
  sender = api({ principal: granted({ [a.id]: 'write' }), engine, now: time.now });
  near = (await engine.createTask(a.id, { title: 'Near' }, OWNER)).task;
  nearOld = (await engine.createTask(a.id, { title: 'Near and replaced' }, OWNER)).task;
  far = (await engine.createTask(b.id, { title: 'Far away' }, OWNER)).task;
  farFirst = (await engine.createTask(b.id, { title: 'Far away, filed first' }, OWNER)).task;
  farOld = (await engine.createTask(b.id, { title: 'Far away and replaced' }, OWNER)).task;
  linked = (
    await engine.createTask(
      a.id,
      {
        title: 'Linked',
        links: [
          { direction: 'depends-on', taskId: near.id, type: 'related' },
          { direction: 'depends-on', taskId: nearOld.id, type: 'supersedes' },
          { direction: 'depends-on', taskId: far.id, type: 'related' },
          { direction: 'depends-on', taskId: farFirst.id, type: 'duplicates' },
          { direction: 'depends-on', taskId: farOld.id, type: 'supersedes' },
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

const linkIds = (task: { dependencies: { id: string }[] }) => task.dependencies.map((link) => link.id).sort();
const seenIds = () => [near.id, nearOld.id].sort();
const expectHidden = (body: unknown, name: string) => {
  for (const id of hidden()) expect(JSON.stringify(body), `${name}: ${id}`).not.toContain(id);
};

describe('links to a task in a project the sender cannot reach', () => {
  it('leave the task its engine read', async () => {
    const task = (await engine.getTask(a.id, linked.id))!;
    expect(task.dependencies.map((link) => [link.taskId, link.type]).sort()).toEqual(
      [
        [near.id, 'related'],
        [nearOld.id, 'supersedes'],
        [far.id, 'related'],
        [farFirst.id, 'duplicates'],
        [farOld.id, 'supersedes'],
      ].sort(),
    );
    expect(task.dependents.map((link) => link.taskId)).toEqual([far.id]);
  });

  it('are left out of the task a sender sees, whichever way the link points', async () => {
    const task = (await engine.getTask(a.id, linked.id))!;
    const seen = (await linksSeenBy({ engine, principal: granted({ [a.id]: 'read' }) })).task(task);
    expect(seen.dependencies.map((link) => link.taskId).sort()).toEqual(seenIds());
    expect(seen.dependents).toEqual([]);
    expect((await linksSeenBy({ engine, principal: WRITER })).task(task)).toBe(task);
  });

  it('are left out of get_task and list_tasks, for that sender only', async () => {
    const mine = await read<{ task: { dependencies: { id: string }[] } }>(sender, 'get_task', {
      project: a.id,
      task: linked.id,
    });
    expect(linkIds(mine.task)).toEqual(seenIds());
    const owners = await read<{ task: { dependencies: { id: string }[] } }>(owner, 'get_task', {
      project: a.id,
      task: linked.id,
    });
    expect(linkIds(owners.task)).toEqual([...seenIds(), ...hidden()].sort());
    const listed = await read<{ tasks: Record<string, unknown>[] }>(sender, 'list_tasks', { project: a.id });
    expectHidden(listed, 'list_tasks');
  });

  it('are left out of a write answer', async () => {
    const reply = await write<{ task: { dependencies: { id: string }[] } }>(sender, 'update_task', {
      project: a.id,
      task: linked.id,
      priority: 1,
      detail: 'full',
    });
    expect(linkIds(reply.task)).toEqual(seenIds());
    // The short answer shows the links when a change names them, and keeps out the same ones.
    const short = await write<{ dependencies: { id: string }[] }>(sender, 'update_task', {
      task: linked.id,
      related: [near.id],
    });
    expect(linkIds(short)).toEqual(seenIds());
    const patched = await send(sender, 'PATCH', `/api/tasks/${linked.id}`, { projectId: a.id, priority: 0 });
    expect(linkIds(patched.body.task as { dependencies: { id: string }[] })).toEqual(seenIds());
  });

  it('are left out of the HTTP task, board, history and change feed', async () => {
    const task = await get(sender, `/api/tasks/${linked.id}?project=${a.id}`);
    expect(linkIds(task.body.task as { dependencies: { id: string }[] })).toEqual(seenIds());
    const board = await get(sender, `/api/tasks?project=${a.id}`);
    expectHidden(board.body, 'board');
    const history = await get(sender, `/api/tasks/${linked.id}/history?project=${a.id}`);
    expectHidden(history.body, 'history');
    const feed = await get(sender, `/api/changes?project=${a.id}&limit=200`);
    expectHidden(feed.body, 'change feed');
    // The owner sees the links in each of them.
    for (const id of hidden()) {
      expect(JSON.stringify((await get(owner, `/api/tasks/${linked.id}/history?project=${a.id}`)).body)).toContain(id);
      expect(JSON.stringify((await get(owner, `/api/changes?project=${a.id}&limit=200`)).body)).toContain(id);
    }
  });

  it('are left out of get_task_history, its field changes and its snapshots', async () => {
    for (const snapshots of [false, true]) {
      const history = await read<Record<string, unknown>>(sender, 'get_task_history', {
        project: a.id,
        task: linked.id,
        snapshots,
      });
      expectHidden(history, `snapshots ${snapshots}`);
      expect(JSON.stringify(history), `snapshots ${snapshots}`).toContain(nearOld.id);
    }
  });
});
