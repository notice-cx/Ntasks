// Links between tasks and the ready work the engine derives from them. Beads'
// predicate, which the engine follows: a task that is not closed is blocked
// when it has a blocks link onto a task that is not closed, or when its parent
// is blocked; ready work is open, not blocked, not a gate, and not deferred,
// directly or through its parent. The groups follow Beads' backend
// conformance suite (MIT License, Copyright (c) 2025 Beads Contributors;
// THIRD_PARTY_NOTICES.md), backend/conformance/conformance.go in v1.3.1.
import type { Task, TaskEngine } from '@ntasks/domain';
import { describe, expect, it } from 'vitest';
import { AGENT, clock, engine, expectRefusal, newProject, OWNER } from './helpers.ts';

async function make(
  tasks: TaskEngine,
  projectId: string,
  title: string,
  extra: Parameters<TaskEngine['createTask']>[1] = { title },
) {
  return (await tasks.createTask(projectId, { ...extra, title }, AGENT)).task;
}

async function readyIds(tasks: TaskEngine, projectId: string): Promise<string[]> {
  return (await tasks.listTasks(projectId, { limit: 200, ready: true })).tasks.map((task) => task.id).sort();
}

async function close(tasks: TaskEngine, projectId: string, task: Task) {
  const current = (await tasks.getTask(projectId, task.id))!;
  return tasks.writeTask(
    projectId,
    task.id,
    { expectedVersion: current.version, close: { reason: 'Done', resolution: 'done' } },
    AGENT,
  );
}

describe('links', () => {
  it('records a link on both tasks, as a dependency and as a dependent', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const schema = await make(tasks, project.id, 'Design the schema');
    const engineTask = await make(tasks, project.id, 'Build the engine', {
      title: '',
      links: [{ direction: 'depends-on', taskId: schema.id, type: 'blocks' }],
    });

    expect(engineTask.dependencies).toEqual([
      { taskId: schema.id, type: 'blocks', title: 'Design the schema', status: 'open' },
    ]);
    expect((await tasks.getTask(project.id, schema.id))?.dependents).toEqual([
      { taskId: engineTask.id, type: 'blocks', title: 'Build the engine', status: 'open' },
    ]);
  });

  it('adds a link that makes an existing task wait on a new one, raising that task version', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const waiting = await make(tasks, project.id, 'Ship it');

    const blocker = await make(tasks, project.id, 'Review it', {
      title: '',
      links: [{ direction: 'blocks', taskId: waiting.id, type: 'blocks' }],
    });

    const after = (await tasks.getTask(project.id, waiting.id))!;
    expect(after.dependencies.map((link) => link.taskId)).toEqual([blocker.id]);
    expect(after.version).toBe(2);
    expect(after.ready).toBe(false);
  });

  it('removes a link and changes a link type in a write', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const a = await make(tasks, project.id, 'A');
    const b = await make(tasks, project.id, 'B');
    const c = await make(tasks, project.id, 'C', {
      title: '',
      links: [{ direction: 'depends-on', taskId: a.id, type: 'blocks' }],
    });

    const { task: after } = await tasks.writeTask(
      project.id,
      c.id,
      { expectedVersion: 1, removeLinks: [a.id], addLinks: [{ taskId: b.id, type: 'related' }] },
      AGENT,
    );
    expect(after.dependencies.map((link) => [link.taskId, link.type])).toEqual([[b.id, 'related']]);
    expect(after.ready).toBe(true);

    const { task: changed } = await tasks.writeTask(
      project.id,
      c.id,
      { expectedVersion: 2, addLinks: [{ taskId: b.id, type: 'blocks' }] },
      AGENT,
    );
    expect(changed.dependencies.map((link) => [link.taskId, link.type])).toEqual([[b.id, 'blocks']]);
    expect(changed.ready).toBe(false);
  });

  it('refuses a blocks link that would close a loop, directly or through other tasks', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const a = await make(tasks, project.id, 'A');
    const b = await make(tasks, project.id, 'B', {
      title: '',
      links: [{ direction: 'depends-on', taskId: a.id, type: 'blocks' }],
    });
    const c = await make(tasks, project.id, 'C', {
      title: '',
      links: [{ direction: 'depends-on', taskId: b.id, type: 'blocks' }],
    });

    await expectRefusal(
      tasks.writeTask(project.id, a.id, { expectedVersion: 1, addLinks: [{ taskId: b.id, type: 'blocks' }] }, AGENT),
      'cycle',
    );
    await expectRefusal(
      tasks.writeTask(project.id, a.id, { expectedVersion: 1, addLinks: [{ taskId: c.id, type: 'blocks' }] }, AGENT),
      'cycle',
    );
    expect((await tasks.getTask(project.id, a.id))?.dependencies).toEqual([]);
  });

  it('allows a related link back to a task that blocks it', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const a = await make(tasks, project.id, 'A');
    const b = await make(tasks, project.id, 'B', {
      title: '',
      links: [{ direction: 'depends-on', taskId: a.id, type: 'blocks' }],
    });

    const { task } = await tasks.writeTask(
      project.id,
      a.id,
      { expectedVersion: 1, addLinks: [{ taskId: b.id, type: 'related' }] },
      AGENT,
    );
    expect(task.dependencies.map((link) => link.type)).toEqual(['related']);
  });

  it('refuses a link to a task that does not exist, or to itself', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const a = await make(tasks, project.id, 'A');

    await expectRefusal(
      tasks.writeTask(
        project.id,
        a.id,
        { expectedVersion: 1, addLinks: [{ taskId: `${project.prefix}-none`, type: 'blocks' }] },
        AGENT,
      ),
      'not_found',
    );
    await expectRefusal(
      tasks.writeTask(project.id, a.id, { expectedVersion: 1, addLinks: [{ taskId: a.id, type: 'blocks' }] }, AGENT),
      'invalid',
    );
  });

  it('refuses a parent that would make a task its own ancestor', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const epic = await make(tasks, project.id, 'Epic', { title: '', type: 'epic' });
    const child = await make(tasks, project.id, 'Child', { title: '', parentId: epic.id });
    const grandchild = await make(tasks, project.id, 'Grandchild', { title: '', parentId: child.id });

    await expectRefusal(
      tasks.writeTask(project.id, epic.id, { expectedVersion: 1, set: { parentId: grandchild.id } }, AGENT),
      'cycle',
    );
    await expectRefusal(
      tasks.writeTask(project.id, epic.id, { expectedVersion: 1, set: { parentId: epic.id } }, AGENT),
      'cycle',
    );
  });
});

describe('reading one task and listing the project', () => {
  it('give every task the same ready answer, before and after its blockers close', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const elsewhere = await newProject(tasks);
    const later = new Date(Date.parse(time.now()) + 60 * 60_000).toISOString();
    const blocker = await make(tasks, project.id, 'Blocker');
    const foreign = (await tasks.createTask(elsewhere.id, { title: 'Foreign blocker' }, AGENT)).task;
    const epic = await make(tasks, project.id, 'Epic', {
      title: '',
      type: 'epic',
      links: [{ direction: 'depends-on', taskId: blocker.id, type: 'blocks' }],
    });
    const child = await make(tasks, project.id, 'Child', { title: '', parentId: epic.id });
    await make(tasks, project.id, 'Grandchild', { title: '', parentId: child.id });
    const closedParent = await make(tasks, project.id, 'Closed parent', {
      title: '',
      links: [{ direction: 'depends-on', taskId: blocker.id, type: 'blocks' }],
    });
    await make(tasks, project.id, 'Under a closed parent', { title: '', parentId: closedParent.id });
    await close(tasks, project.id, closedParent);
    const deferred = await make(tasks, project.id, 'Deferred', { title: '', deferUntil: later });
    await make(tasks, project.id, 'Under a deferred parent', { title: '', parentId: deferred.id });
    await make(tasks, project.id, 'Blocked from another project', {
      title: '',
      links: [{ direction: 'depends-on', taskId: foreign.id, type: 'blocks' }],
    });
    const gated = await make(tasks, project.id, 'Waits on approval');
    await tasks.writeTask(
      project.id,
      gated.id,
      { expectedVersion: 1, requestApproval: { reason: 'Approve it.' } },
      AGENT,
    );
    await make(tasks, project.id, 'Plain');

    const compare = async () => {
      const ready = new Set(await readyIds(tasks, project.id));
      const all = (await tasks.listTasks(project.id, { limit: 200 })).tasks;
      for (const listed of all) {
        const alone = await tasks.getTask(project.id, listed.id);
        expect(alone?.ready, listed.title).toBe(ready.has(listed.id));
        expect(listed.ready, listed.title).toBe(ready.has(listed.id));
      }
    };
    await compare();
    await close(tasks, project.id, blocker);
    await tasks.writeTask(
      elsewhere.id,
      foreign.id,
      { expectedVersion: 1, close: { reason: 'Done', resolution: 'done' } },
      AGENT,
    );
    await compare();
  });
});

describe('ready work', () => {
  it('holds a task until every task blocking it is closed', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const first = await make(tasks, project.id, 'First');
    const second = await make(tasks, project.id, 'Second');
    const last = await make(tasks, project.id, 'Last', {
      title: '',
      links: [
        { direction: 'depends-on', taskId: first.id, type: 'blocks' },
        { direction: 'depends-on', taskId: second.id, type: 'blocks' },
      ],
    });

    expect(await readyIds(tasks, project.id)).toEqual([first.id, second.id].sort());
    await close(tasks, project.id, first);
    expect(await readyIds(tasks, project.id)).toEqual([second.id]);
    await close(tasks, project.id, second);
    expect(await readyIds(tasks, project.id)).toEqual([last.id]);
  });

  it('does not hold a task for a related or discovered-from link', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const a = await make(tasks, project.id, 'A');
    const b = await make(tasks, project.id, 'B', {
      title: '',
      links: [{ direction: 'depends-on', taskId: a.id, type: 'discovered-from' }],
    });

    expect(await readyIds(tasks, project.id)).toEqual([a.id, b.id].sort());
  });

  it('holds every descendant of a blocked parent, at any depth, and only while the parent is open', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const blocker = await make(tasks, project.id, 'Blocker');
    const epic = await make(tasks, project.id, 'Epic', {
      title: '',
      type: 'epic',
      links: [{ direction: 'depends-on', taskId: blocker.id, type: 'blocks' }],
    });
    const child = await make(tasks, project.id, 'Child', { title: '', parentId: epic.id });
    const grandchild = await make(tasks, project.id, 'Grandchild', { title: '', parentId: child.id });

    expect(await readyIds(tasks, project.id)).toEqual([blocker.id]);
    await close(tasks, project.id, blocker);
    expect(await readyIds(tasks, project.id)).toEqual([epic.id, child.id, grandchild.id].sort());
  });

  it('passes blocking down from a parent in any status but closed', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const blocker = await make(tasks, project.id, 'Blocker');
    const children: string[] = [];
    for (const status of ['in_progress', 'blocked', 'deferred'] as const) {
      const parent = await make(tasks, project.id, `Parent ${status}`, {
        title: '',
        links: [{ direction: 'depends-on', taskId: blocker.id, type: 'blocks' }],
      });
      await tasks.writeTask(project.id, parent.id, { expectedVersion: 1, set: { status } }, AGENT);
      children.push((await make(tasks, project.id, `Child of ${status}`, { title: '', parentId: parent.id })).id);
    }

    expect(await readyIds(tasks, project.id)).toEqual([blocker.id]);
    for (const id of children) expect((await tasks.getTask(project.id, id))?.ready, id).toBe(false);
    const board = await tasks.listBoard(project.id, { statuses: ['open'] });
    expect(board.filter((task) => children.includes(task.id)).map((task) => task.ready)).toEqual([false, false, false]);
  });

  it('does not pass blocking down from a closed parent', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const blocker = await make(tasks, project.id, 'Blocker');
    const parent = await make(tasks, project.id, 'Parent', {
      title: '',
      links: [{ direction: 'depends-on', taskId: blocker.id, type: 'blocks' }],
    });
    const child = await make(tasks, project.id, 'Child', { title: '', parentId: parent.id });
    await close(tasks, project.id, parent);

    expect(await readyIds(tasks, project.id)).toEqual([blocker.id, child.id].sort());
  });

  it('holds a task deferred to a later time, and the children of a parent deferred to one', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const later = new Date(Date.parse(time.now()) + 60 * 60_000).toISOString();
    const deferred = await make(tasks, project.id, 'Later', { title: '', deferUntil: later, type: 'epic' });
    const child = await make(tasks, project.id, 'Child of later', { title: '', parentId: deferred.id });
    const now = await make(tasks, project.id, 'Now');

    expect(await readyIds(tasks, project.id)).toEqual([now.id]);
    time.advance(61);
    expect(await readyIds(tasks, project.id)).toEqual([deferred.id, child.id, now.id].sort());
  });

  it('leaves out tasks that are in progress, blocked, deferred or closed', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const open = await make(tasks, project.id, 'Open');
    for (const status of ['in_progress', 'blocked', 'deferred'] as const) {
      const task = await make(tasks, project.id, status);
      await tasks.writeTask(project.id, task.id, { expectedVersion: 1, set: { status } }, AGENT);
    }
    await close(tasks, project.id, await make(tasks, project.id, 'Closed'));

    expect(await readyIds(tasks, project.id)).toEqual([open.id]);
  });

  it('gives each task a ready flag that matches the ready list', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const blocker = await make(tasks, project.id, 'Blocker');
    await make(tasks, project.id, 'Waiting', {
      title: '',
      links: [{ direction: 'depends-on', taskId: blocker.id, type: 'blocks' }],
    });
    await make(tasks, project.id, 'Free');

    const all = (await tasks.listTasks(project.id, { limit: 200 })).tasks;
    expect(
      all
        .filter((task) => task.ready)
        .map((task) => task.id)
        .sort(),
    ).toEqual(await readyIds(tasks, project.id));
    expect((await tasks.listTasks(project.id, { limit: 200, ready: false })).tasks.map((task) => task.title)).toEqual([
      'Waiting',
    ]);
  });
});

describe('approvals', () => {
  it('opens a gate the task waits on, which no agent sees as work, until a person closes it', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const deploy = await make(tasks, project.id, 'Deploy the Worker');

    const { task, created } = await tasks.writeTask(
      project.id,
      deploy.id,
      {
        expectedVersion: 1,
        requestApproval: { reason: 'Deploy the Worker to the owner account.\nIt creates the database.' },
      },
      AGENT,
    );

    const [gate] = created;
    expect(gate).toMatchObject({
      type: 'gate',
      awaitType: 'human',
      status: 'open',
      title: 'Deploy the Worker to the owner account.',
      ready: false,
    });
    expect(task.dependencies).toEqual([{ taskId: gate!.id, type: 'blocks', title: gate!.title, status: 'open' }]);
    expect(task.ready).toBe(false);
    expect(await readyIds(tasks, project.id)).toEqual([]);

    await tasks.writeTask(
      project.id,
      gate!.id,
      { expectedVersion: 1, close: { reason: 'Approved.', resolution: 'done' } },
      OWNER,
    );
    expect(await readyIds(tasks, project.id)).toEqual([deploy.id]);
  });
});

describe('epics', () => {
  it('lists open epics with their children, eligible to close once every child is', async () => {
    // Epics are listed oldest first, so the second is made a minute later:
    // two made in the same millisecond would fall back to their random ids.
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const epic = await make(tasks, project.id, 'Launch', { title: '', type: 'epic' });
    time.advance(1);
    const empty = await make(tasks, project.id, 'Empty epic', { title: '', type: 'epic' });
    const one = await make(tasks, project.id, 'One', { title: '', parentId: epic.id });
    const two = await make(tasks, project.id, 'Two', { title: '', parentId: epic.id });
    await close(tasks, project.id, one);

    expect(await tasks.listEpics(project.id)).toEqual([
      {
        id: epic.id,
        title: 'Launch',
        status: 'open',
        priority: 2,
        children: 2,
        closedChildren: 1,
        eligibleForClose: false,
      },
      {
        id: empty.id,
        title: 'Empty epic',
        status: 'open',
        priority: 2,
        children: 0,
        closedChildren: 0,
        eligibleForClose: false,
      },
    ]);

    await close(tasks, project.id, two);
    expect((await tasks.listEpics(project.id))[0]).toMatchObject({ closedChildren: 2, eligibleForClose: true });
  });
});
