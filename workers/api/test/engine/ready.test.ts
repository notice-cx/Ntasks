// Links between tasks and the ready work the engine derives from them. Beads'
// predicate, which the engine follows: a task that is not closed is blocked
// when it has a blocks link onto a task that is not closed, or when its parent
// is blocked; ready work is open, not blocked, not a gate, and not deferred,
// directly or through its parent. The groups follow Beads' backend
// conformance suite (MIT License, Copyright (c) 2025 Beads Contributors;
// THIRD_PARTY_NOTICES.md), backend/conformance/conformance.go in v1.3.1.
import type { Task, TaskEngine } from '@ntasks/domain';
import { describe, expect, it } from 'vitest';
import { NAMED_LINKS } from '../../src/engine/writes.ts';
import { AGENT, clock, engine, everyTask, expectRefusal, newProject, OWNER } from './helpers.ts';

async function make(
  tasks: TaskEngine,
  projectId: string,
  title: string,
  extra: Parameters<TaskEngine['createTask']>[1] = { title },
) {
  return (await tasks.createTask(projectId, { ...extra, title }, AGENT)).task;
}

async function readyIds(tasks: TaskEngine, projectId: string): Promise<string[]> {
  return (await everyTask(tasks, projectId, { ready: true })).map((task) => task.id).sort();
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
      const all = await everyTask(tasks, project.id);
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

  it('does not hold a task for a duplicates or supersedes link, either way it points', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const a = await make(tasks, project.id, 'A');
    const b = await make(tasks, project.id, 'B', {
      title: '',
      links: [{ direction: 'depends-on', taskId: a.id, type: 'duplicates' }],
    });
    const c = await make(tasks, project.id, 'C', {
      title: '',
      links: [{ direction: 'depends-on', taskId: a.id, type: 'supersedes' }],
    });

    expect(await readyIds(tasks, project.id)).toEqual([a.id, b.id, c.id].sort());
    const read = await tasks.getTask(project.id, a.id);
    expect(read?.ready).toBe(true);
    expect(read?.dependents.map((link) => [link.taskId, link.type])).toEqual(
      [
        [b.id, 'duplicates'],
        [c.id, 'supersedes'],
      ].sort(),
    );
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

  it('holds a task labelled human only by its own links, not by a waiting parent, and holds the tasks under it', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const blocker = await make(tasks, project.id, 'Blocker');
    const research = await make(tasks, project.id, 'Research');
    const parent = await make(tasks, project.id, 'Parent', {
      title: '',
      links: [{ direction: 'depends-on', taskId: blocker.id, type: 'blocks' }],
    });
    const decision = await make(tasks, project.id, 'Pick a layout', {
      title: '',
      type: 'decision',
      labels: ['human'],
      parentId: parent.id,
      choices: {
        question: 'Which layout?',
        options: [
          { key: 'a', label: 'One column', recommended: true },
          { key: 'b', label: 'Two columns' },
        ],
      },
    });
    const underDecision = await make(tasks, project.id, 'Build the layout', { title: '', parentId: decision.id });
    const afterResearch = await make(tasks, project.id, 'Answer after the research', {
      title: '',
      labels: ['human'],
      parentId: parent.id,
      links: [{ direction: 'depends-on', taskId: research.id, type: 'blocks' }],
    });
    const agentWork = await make(tasks, project.id, 'Agent work', { title: '', parentId: parent.id });
    const humanEpic = await make(tasks, project.id, 'Epic labelled human', {
      title: '',
      type: 'epic',
      labels: ['human'],
      parentId: parent.id,
    });

    const held = [parent, underDecision, afterResearch, agentWork, humanEpic].map((task) => task.id);
    expect(await readyIds(tasks, project.id)).toEqual([blocker.id, research.id, decision.id].sort());
    expect((await tasks.getTask(project.id, decision.id))?.ready).toBe(true);
    for (const id of held) expect((await tasks.getTask(project.id, id))?.ready, id).toBe(false);
    const labelled = await tasks.listLabelled(project.id, { label: 'human', limit: 10 });
    expect(Object.fromEntries(labelled.tasks.map((task) => [task.id, task.ready]))).toEqual({
      [decision.id]: true,
      [afterResearch.id]: false,
      [humanEpic.id]: false,
    });

    await close(tasks, project.id, research);
    expect((await tasks.getTask(project.id, afterResearch.id))?.ready).toBe(true);
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

    const all = await everyTask(tasks, project.id);
    expect(
      all
        .filter((task) => task.ready)
        .map((task) => task.id)
        .sort(),
    ).toEqual(await readyIds(tasks, project.id));
    expect((await everyTask(tasks, project.id, { ready: false })).map((task) => task.title)).toEqual(['Waiting']);
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
    // Labelled keep-open, the first stays open once its children close (STATE-22).
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const epic = await make(tasks, project.id, 'Launch', { title: '', type: 'epic', labels: ['keep-open'] });
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

describe('dropped links', () => {
  async function drop(tasks: TaskEngine, projectId: string, task: Task, resolution: 'wont-do' | 'no-longer-needed') {
    const current = (await tasks.getTask(projectId, task.id))!;
    await tasks.writeTask(
      projectId,
      task.id,
      { expectedVersion: current.version, close: { reason: 'Dropped', resolution } },
      AGENT,
    );
  }

  it('names the linked tasks dropped after a task last changed, in every read, until it changes again', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const shelved = await make(tasks, project.id, 'Shelve the old site');
    const retired = await make(tasks, project.id, 'Retire the old app');
    const shipped = await make(tasks, project.id, 'Ship the API');
    const page = await make(tasks, project.id, 'Build the page', {
      title: '',
      links: [
        { direction: 'depends-on', taskId: shelved.id, type: 'blocks' },
        { direction: 'depends-on', taskId: retired.id, type: 'related' },
        { direction: 'depends-on', taskId: shipped.id, type: 'blocks' },
      ],
    });
    const unlinked = await make(tasks, project.id, 'Move the docs', {
      title: '',
      links: [{ direction: 'depends-on', taskId: shelved.id, type: 'discovered-from' }],
    });
    time.advance(1);
    await drop(tasks, project.id, shelved, 'wont-do');
    await drop(tasks, project.id, retired, 'no-longer-needed');
    await close(tasks, project.id, shipped);

    const expected = [
      { taskId: shelved.id, title: 'Shelve the old site', resolution: 'wont-do' },
      { taskId: retired.id, title: 'Retire the old app', resolution: 'no-longer-needed' },
    ].sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
    const flagged = await tasks.getTask(project.id, page.id);
    expect(flagged?.reliesOnDropped).toEqual(expected);
    expect(flagged?.ready).toBe(true);
    const board = await tasks.listBoard(project.id, { statuses: ['open'] });
    expect(board.find((task) => task.id === page.id)?.reliesOnDropped).toEqual(expected);
    expect((await tasks.getTask(project.id, unlinked.id))?.reliesOnDropped).toHaveLength(1);

    time.advance(1);
    await tasks.writeTask(
      project.id,
      page.id,
      { expectedVersion: flagged!.version, set: { description: 'Builds on the new site.' } },
      AGENT,
    );
    expect((await tasks.getTask(project.id, page.id))?.reliesOnDropped).toEqual([]);
    await tasks.writeTask(project.id, unlinked.id, { expectedVersion: 1, removeLinks: [shelved.id] }, AGENT);
    expect((await tasks.getTask(project.id, unlinked.id))?.reliesOnDropped).toEqual([]);
  });

  it('counts a dropped task that waited on this one, and leaves out one it replaces, work found from it and closed tasks', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const api = await make(tasks, project.id, 'Ship the API');
    const page = await make(tasks, project.id, 'Build the page on the API', {
      title: '',
      links: [{ direction: 'depends-on', taskId: api.id, type: 'blocks' }],
    });
    const found = await make(tasks, project.id, 'Fix the typo found on the way', {
      title: '',
      links: [{ direction: 'depends-on', taskId: api.id, type: 'discovered-from' }],
    });
    const old = await make(tasks, project.id, 'Old plan');
    const plan = await make(tasks, project.id, 'New plan', {
      title: '',
      links: [{ direction: 'depends-on', taskId: old.id, type: 'supersedes' }],
    });
    const done = await make(tasks, project.id, 'Closed already', {
      title: '',
      links: [{ direction: 'depends-on', taskId: page.id, type: 'related' }],
    });
    await close(tasks, project.id, done);
    time.advance(1);
    await drop(tasks, project.id, page, 'wont-do');
    await drop(tasks, project.id, found, 'wont-do');
    await drop(tasks, project.id, old, 'no-longer-needed');

    expect((await tasks.getTask(project.id, api.id))?.reliesOnDropped).toEqual([
      { taskId: page.id, title: 'Build the page on the API', resolution: 'wont-do' },
    ]);
    expect((await tasks.getTask(project.id, plan.id))?.reliesOnDropped).toEqual([]);
    expect((await tasks.getTask(project.id, done.id))?.reliesOnDropped).toEqual([]);
  });

  it('counts an open task whose text names the dropped task, in any project, by linking the two as related', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const other = await newProject(tasks);
    const shelved = await make(tasks, project.id, 'Shelve the old site');
    const child = await make(tasks, project.id, 'Move the old images', { title: '', parentId: shelved.id });
    const page = await make(tasks, project.id, 'Build the page', {
      title: '',
      description: `Builds on what ${shelved.id} leaves behind.`,
    });
    const runbook = await make(tasks, other.id, 'Write the runbook', { title: '', notes: `After ${shelved.id}.` });
    const childOnly = await make(tasks, project.id, 'Check the images', {
      title: '',
      acceptance: `- ${child.id} is done`,
    });
    const longer = await make(tasks, project.id, 'Name a longer id', { title: '', description: `${shelved.id}x` });
    const done = await make(tasks, project.id, 'Fix the header', { title: '', description: `See ${shelved.id}` });
    await close(tasks, project.id, done);
    const replaced = await make(tasks, project.id, 'Shelve the site differently', {
      title: '',
      description: `Replaces ${shelved.id}.`,
      links: [{ direction: 'depends-on', taskId: shelved.id, type: 'supersedes' }],
    });
    time.advance(1);
    await drop(tasks, project.id, shelved, 'wont-do');

    const dropped = [{ taskId: shelved.id, title: 'Shelve the old site', resolution: 'wont-do' }];
    expect((await tasks.getTask(project.id, page.id))?.reliesOnDropped).toEqual(dropped);
    expect((await tasks.getTask(other.id, runbook.id))?.reliesOnDropped).toEqual(dropped);
    for (const id of [childOnly.id, longer.id, done.id, replaced.id])
      expect((await tasks.getTask(project.id, id))?.reliesOnDropped).toEqual([]);
    // The link is the dropped task's own, recorded by its close; the tasks that name it are unchanged.
    expect((await tasks.getTask(project.id, page.id))?.version).toBe(page.version);
    const links = (await tasks.getTask(project.id, shelved.id))?.dependencies.map((link) => [link.taskId, link.type]);
    expect(links?.sort()).toEqual(
      [
        [page.id, 'related'],
        [runbook.id, 'related'],
      ].sort(),
    );
  });

  it('counts a task named by the id it had before a move, and an epic Ntasks drops once its last task is dropped', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const other = await newProject(tasks);
    const shelved = await make(tasks, project.id, 'Shelve the old site');
    const formerId = shelved.id;
    const plan = await make(tasks, project.id, 'Plan the move', { title: '', type: 'epic' });
    const step = await make(tasks, project.id, 'Move the images', { title: '', parentId: plan.id });
    const byFormer = await make(tasks, project.id, 'Write the notes', { title: '', notes: `After ${formerId}.` });
    const byEpic = await make(tasks, project.id, 'Tell the team', { title: '', description: `Once ${plan.id} lands.` });
    const [moved] = (
      await tasks.moveTasks(other.id, [{ taskId: shelved.id, expectedVersion: shelved.version, parentId: null }], AGENT)
    ).tasks;
    time.advance(1);
    await drop(tasks, other.id, moved!, 'wont-do');
    await drop(tasks, project.id, step, 'wont-do');

    expect((await tasks.getTask(project.id, byFormer.id))?.reliesOnDropped).toEqual([
      { taskId: moved!.id, title: 'Shelve the old site', resolution: 'wont-do' },
    ]);
    const epic = await tasks.getTask(project.id, plan.id);
    expect(epic?.close).toMatchObject({ resolution: 'no-longer-needed' });
    expect(epic?.dependencies.map((link) => [link.taskId, link.type])).toEqual([[byEpic.id, 'related']]);
    expect((await tasks.getTask(project.id, byEpic.id))?.reliesOnDropped).toEqual([
      { taskId: plan.id, title: 'Plan the move', resolution: 'no-longer-needed' },
    ]);
  });

  it('links at most NAMED_LINKS of the open tasks that name a dropped task, newest change first', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const shelved = await make(tasks, project.id, 'Shelve the old site');
    const naming: Task[] = [];
    for (let index = 0; index <= NAMED_LINKS; index += 1) {
      time.advance(1);
      naming.push(
        await make(tasks, project.id, `Follow up ${index}`, { title: '', description: `After ${shelved.id}` }),
      );
    }
    time.advance(1);
    await drop(tasks, project.id, shelved, 'no-longer-needed');
    const linked = (await tasks.getTask(project.id, shelved.id))?.dependencies.map((link) => link.taskId);
    expect(linked?.sort()).toEqual(
      naming
        .slice(1)
        .map((task) => task.id)
        .sort(),
    );
  });

  it('takes a task off the list once the dropped task reopens', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const blocker = await make(tasks, project.id, 'Blocker');
    const waiting = await make(tasks, project.id, 'Waiting', {
      title: '',
      links: [{ direction: 'depends-on', taskId: blocker.id, type: 'blocks' }],
    });
    time.advance(1);
    await drop(tasks, project.id, blocker, 'wont-do');
    expect((await tasks.getTask(project.id, waiting.id))?.reliesOnDropped).toHaveLength(1);

    const closed = (await tasks.getTask(project.id, blocker.id))!;
    await tasks.writeTask(project.id, blocker.id, { expectedVersion: closed.version, reopen: true }, AGENT);
    expect((await tasks.getTask(project.id, waiting.id))?.reliesOnDropped).toEqual([]);
  });
});
