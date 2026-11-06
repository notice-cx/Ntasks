// The engine's task records: creating, reading, searching, paging, labels,
// metadata, comments and input checks. The groups follow Beads' backend
// conformance suite (MIT License, Copyright (c) 2025 Beads Contributors;
// THIRD_PARTY_NOTICES.md), backend/conformance/conformance.go in v1.3.1.
import { isTaskId } from '@ntasks/domain';
import { describe, expect, it } from 'vitest';
import { AGENT, clock, engine, expectRefusal, newProject, OWNER } from './helpers.ts';

describe('creating and reading a task', () => {
  it('returns the new task with its fields, its filer and version 1', async () => {
    const tasks = engine();
    const project = await newProject(tasks);

    const { task, created, replayed } = await tasks.createTask(
      project.id,
      { title: 'Write the guide', description: 'For new contributors.', acceptance: 'The guide is merged.', priority: 1, labels: ['docs'] },
      AGENT,
    );

    expect(replayed).toBe(false);
    expect(created).toEqual([]);
    expect(isTaskId(task.id)).toBe(true);
    expect(task.id.startsWith(`${project.prefix}-`)).toBe(true);
    expect(task).toMatchObject({
      projectId: project.id,
      type: 'task',
      status: 'open',
      priority: 1,
      title: 'Write the guide',
      description: 'For new contributors.',
      acceptance: 'The guide is merged.',
      labels: ['docs'],
      filedBy: 'agent-a',
      filedModel: 'model-a',
      assignee: null,
      close: null,
      version: 1,
      ready: true,
      commentCount: 0,
    });
    expect(await tasks.getTask(project.id, task.id)).toEqual(task);
  });

  it('numbers children after their parent, past any number already used', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task: epic } = await tasks.createTask(project.id, { title: 'Launch', type: 'epic' }, AGENT);

    const first = await tasks.createTask(project.id, { title: 'Step one', parentId: epic.id }, AGENT);
    const second = await tasks.createTask(project.id, { title: 'Step two', parentId: epic.id }, AGENT);
    const grandchild = await tasks.createTask(project.id, { title: 'Detail', parentId: first.task.id }, AGENT);

    expect(first.task.id).toBe(`${epic.id}.1`);
    expect(second.task.id).toBe(`${epic.id}.2`);
    expect(grandchild.task.id).toBe(`${epic.id}.1.1`);
    expect(second.task.parentId).toBe(epic.id);
  });

  it('draws a new key when the first one is taken', async () => {
    const keys = ['aaaa', 'aaaa', 'bbbb'];
    const tasks = engine({ newKey: () => keys.shift() ?? 'zzzz' });
    const project = await newProject(tasks);

    const first = await tasks.createTask(project.id, { title: 'First' }, AGENT);
    const second = await tasks.createTask(project.id, { title: 'Second' }, AGENT);

    expect(first.task.id).toBe(`${project.prefix}-aaaa`);
    expect(second.task.id).toBe(`${project.prefix}-bbbb`);
  });

  it('answers null for a task the project does not hold', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const other = await newProject(tasks);
    const { task } = await tasks.createTask(other.id, { title: 'Elsewhere' }, AGENT);

    expect(await tasks.getTask(project.id, task.id)).toBeNull();
    expect(await tasks.getTask(project.id, `${project.prefix}-none`)).toBeNull();
  });

  it('finds which of several ids the project holds', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Present' }, AGENT);

    expect(await tasks.findTasks(project.id, [task.id, `${project.prefix}-none`])).toEqual([task.id]);
  });

  it('refuses a project prefix with a hyphen', async () => {
    const tasks = engine();
    await expectRefusal(tasks.createProject({ id: crypto.randomUUID(), key: 'web-app.example.com', name: 'Web app', prefix: 'web-app' }), 'invalid');
  });
});

describe('searching and paging', () => {
  it('lists most urgent first, then oldest, and filters by status, assignee, parent and label', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const make = async (title: string, priority: number, labels: string[] = [], parentId?: string) => {
      time.advance(1);
      return (await tasks.createTask(project.id, { title, priority, labels, ...(parentId === undefined ? {} : { parentId }) }, AGENT)).task;
    };
    const low = await make('Low', 3);
    const urgent = await make('Urgent', 0, ['ops']);
    const epic = await make('Epic', 2);
    const child = await make('Child', 2, ['ops'], epic.id);
    await tasks.writeTask(project.id, low.id, { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress' } }, AGENT);

    const all = await tasks.listTasks(project.id, { limit: 50 });
    expect(all.tasks.map((task) => task.title)).toEqual(['Urgent', 'Epic', 'Child', 'Low']);
    expect((await tasks.listTasks(project.id, { limit: 50, statuses: ['in_progress'] })).tasks.map((task) => task.id)).toEqual([low.id]);
    expect((await tasks.listTasks(project.id, { limit: 50, assignee: AGENT.name })).tasks.map((task) => task.id)).toEqual([low.id]);
    expect((await tasks.listTasks(project.id, { limit: 50, parentId: epic.id })).tasks.map((task) => task.id)).toEqual([child.id]);
    expect((await tasks.listTasks(project.id, { limit: 50, labels: ['ops'] })).tasks.map((task) => task.id)).toEqual([urgent.id, child.id]);
  });

  it('pages through every task once, in order, with a cursor', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const ids: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      time.advance(1);
      ids.push((await tasks.createTask(project.id, { title: `Task ${index}` }, AGENT)).task.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await tasks.listTasks(project.id, { limit: 3, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...page.tasks.map((task) => task.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    expect(seen).toEqual(ids);
  });

  it('filters closed tasks by when they closed', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const early = (await tasks.createTask(project.id, { title: 'Early' }, AGENT)).task;
    const late = (await tasks.createTask(project.id, { title: 'Late' }, AGENT)).task;
    await tasks.writeTask(project.id, early.id, { expectedVersion: 1, close: { reason: 'Done', resolution: 'done' } }, AGENT);
    time.advance(60);
    const cut = time.now();
    await tasks.writeTask(project.id, late.id, { expectedVersion: 1, close: { reason: 'Done', resolution: 'done' } }, AGENT);

    expect((await tasks.listTasks(project.id, { limit: 50, closedSince: cut })).tasks.map((task) => task.id)).toEqual([late.id]);
    expect((await tasks.listTasks(project.id, { limit: 50, closedBefore: cut })).tasks.map((task) => task.id)).toEqual([early.id]);
  });

  it('refuses a limit outside 1 to 200 and a cursor it did not make', async () => {
    const tasks = engine();
    const project = await newProject(tasks);

    await expectRefusal(tasks.listTasks(project.id, { limit: 0 }), 'invalid');
    await expectRefusal(tasks.listTasks(project.id, { limit: 201 }), 'invalid');
    await expectRefusal(tasks.listTasks(project.id, { limit: 5, cursor: 'not-a-cursor' }), 'invalid');
  });
});

describe('labels and metadata', () => {
  it('adds and removes labels, ignoring ones already in that state', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Tagged', labels: ['a', 'b'] }, AGENT);

    const { task: after } = await tasks.writeTask(project.id, task.id, { expectedVersion: 1, addLabels: ['b', 'c'], removeLabels: ['a', 'z'] }, AGENT);

    expect(after.labels).toEqual(['b', 'c']);
  });

  it('merges metadata, removing a key set to null', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Annotated', metadata: { keep: 1, drop: 'x' } }, AGENT);

    const { task: after } = await tasks.writeTask(project.id, task.id, { expectedVersion: 1, metadata: { drop: null, add: { nested: true } } }, AGENT);

    expect(after.metadata).toEqual({ keep: 1, add: { nested: true } });
  });
});

describe('comments', () => {
  it('lists comments in order and counts them, without changing the task version', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Discussed' }, AGENT);

    await tasks.addComment(project.id, task.id, 'First note.', AGENT);
    time.advance(1);
    await tasks.addComment(project.id, task.id, 'Second note.', OWNER);

    expect((await tasks.listComments(project.id, task.id)).map((comment) => [comment.author, comment.text])).toEqual([
      ['agent-a', 'First note.'],
      ['owner', 'Second note.'],
    ]);
    const after = await tasks.getTask(project.id, task.id);
    expect(after?.commentCount).toBe(2);
    expect(after?.version).toBe(1);
  });

  it('refuses a comment on a task the project does not hold', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    await expectRefusal(tasks.addComment(project.id, `${project.prefix}-none`, 'Hello.', AGENT), 'not_found');
  });
});

describe('lint', () => {
  it('names the sections each task lacks and leaves out the tasks lacking none', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const bare = (await tasks.createTask(project.id, { title: 'Bare task' }, AGENT)).task;
    const bug = (await tasks.createTask(project.id, { title: 'Bug', type: 'bug', acceptance: 'It stops crashing.' }, AGENT)).task;
    const complete = (await tasks.createTask(project.id, { title: 'Complete', acceptance: 'Merged.' }, AGENT)).task;

    const missing = await tasks.lint(project.id, [bare.id, bug.id, complete.id]);

    expect(Object.fromEntries(missing)).toEqual({ [bare.id]: ['## Acceptance Criteria'], [bug.id]: ['## Steps to Reproduce'] });
  });
});

describe('input checks', () => {
  it('refuses an empty title, a priority outside 0 to 4 and an unknown type', async () => {
    const tasks = engine();
    const project = await newProject(tasks);

    await expectRefusal(tasks.createTask(project.id, { title: '   ' }, AGENT), 'invalid');
    await expectRefusal(tasks.createTask(project.id, { title: 'Too urgent', priority: 9 }, AGENT), 'invalid');
    await expectRefusal(tasks.createTask(project.id, { title: 'Gate', type: 'gate' as never }, AGENT), 'invalid');
  });

  it('refuses a write that changes nothing, or both closes and reopens', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Steady' }, AGENT);

    await expectRefusal(tasks.writeTask(project.id, task.id, { expectedVersion: 1 }, AGENT), 'invalid');
    await expectRefusal(
      tasks.writeTask(project.id, task.id, { expectedVersion: 1, reopen: true, close: { reason: 'x', resolution: 'done' } }, AGENT),
      'invalid',
    );
  });

  it('refuses removeLinks that is not a list, or longer than the link limit', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Linked' }, AGENT);

    await expectRefusal(tasks.writeTask(project.id, task.id, { expectedVersion: 1, removeLinks: 'web-a1b2' as never }, AGENT), 'invalid');
    const tooMany = Array.from({ length: 33 }, (_, index) => `${project.prefix}-x${index}`);
    await expectRefusal(tasks.writeTask(project.id, task.id, { expectedVersion: 1, removeLinks: tooMany }, AGENT), 'invalid');
  });

  it('refuses a task in a project that does not exist', async () => {
    const tasks = engine();
    await expectRefusal(tasks.createTask(crypto.randomUUID(), { title: 'Nowhere' }, AGENT), 'not_found');
  });
});
