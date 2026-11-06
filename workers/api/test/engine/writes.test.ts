// How the engine changes a task: claims and races, closing and reopening,
// history, retries and decisions. These are the rules in docs/architecture.md
// ("Rules every change keeps"). The groups follow Beads' backend conformance
// suite (MIT License, Copyright (c) 2025 Beads Contributors;
// THIRD_PARTY_NOTICES.md), backend/conformance/conformance.go in v1.3.1.
import { TaskRefused, type Json, type Task, type TaskEngine } from '@ntasks/domain';
import { describe, expect, it } from 'vitest';
import { AGENT, clock, engine, expectRefusal, newProject, OTHER, OWNER, retryFor } from './helpers.ts';

async function historyOf(tasks: TaskEngine, projectId: string, taskId: string) {
  return [...(await tasks.listHistory(projectId, taskId, { limit: 200 }))].reverse();
}

describe('claiming a task (rule 1)', () => {
  it('records the holder, their model and when they started', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Claim me' }, OWNER);
    time.advance(5);

    const { task: claimed } = await tasks.writeTask(project.id, task.id, { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress' } }, AGENT);

    expect(claimed).toMatchObject({ assignee: 'agent-a', assigneeModel: 'model-a', status: 'in_progress', startedAt: time.now(), version: 2 });
  });

  it('refuses a claim on a task someone else holds, naming the holder', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Taken' }, OWNER);
    await tasks.writeTask(project.id, task.id, { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress' } }, AGENT);

    const refusal = await expectRefusal(
      tasks.writeTask(project.id, task.id, { expectedVersion: 2, set: { assignee: OTHER.name, status: 'in_progress' } }, OTHER),
      'held',
    );
    expect(refusal.message).toContain('agent-a');
  });

  it('lets a person give a held task to someone else, or release it', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Handed over' }, OWNER);
    await tasks.writeTask(project.id, task.id, { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress' } }, AGENT);

    const { task: given } = await tasks.writeTask(project.id, task.id, { expectedVersion: 2, set: { assignee: OTHER.name } }, OWNER);
    expect(given).toMatchObject({ assignee: 'agent-b', assigneeModel: null });

    const { task: released } = await tasks.writeTask(project.id, task.id, { expectedVersion: 3, set: { assignee: null, status: 'open' } }, OWNER);
    expect(released).toMatchObject({ assignee: null, status: 'open', ready: true });
  });

  it('lets exactly one of two agents that read the same version claim the task, and records nothing for the other', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Contested' }, OWNER);

    const outcomes = await Promise.allSettled(
      [AGENT, OTHER].map((actor) =>
        tasks.writeTask(project.id, task.id, { expectedVersion: 1, set: { assignee: actor.name, status: 'in_progress' }, comment: `${actor.name} starts.` }, actor),
      ),
    );

    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const lost = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0]!.reason as TaskRefused).refusal).toBe('version_conflict');
    const after = (await tasks.getTask(project.id, task.id))!;
    expect(after.version).toBe(2);
    expect(after.commentCount).toBe(1);
    expect((await historyOf(tasks, project.id, task.id)).map((event) => event.kind)).toEqual(['created', 'commented', 'updated']);
  });

  it('lets exactly one of two closes of the same version succeed', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Closed twice' }, OWNER);

    const outcomes = await Promise.allSettled([
      tasks.writeTask(project.id, task.id, { expectedVersion: 1, close: { reason: 'Shipped.', resolution: 'done' } }, AGENT),
      tasks.writeTask(project.id, task.id, { expectedVersion: 1, close: { reason: 'Not needed.', resolution: 'wont-do' } }, OTHER),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const after = (await tasks.getTask(project.id, task.id))!;
    expect(after.version).toBe(2);
    expect((await historyOf(tasks, project.id, task.id)).filter((event) => event.kind === 'closed')).toHaveLength(1);
  });

  it('refuses a write based on an older version (rule 2)', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Moving' }, OWNER);
    await tasks.writeTask(project.id, task.id, { expectedVersion: 1, set: { title: 'Moved' } }, OWNER);

    await expectRefusal(tasks.writeTask(project.id, task.id, { expectedVersion: 1, set: { priority: 0 }, addLabels: ['late'] }, AGENT), 'version_conflict');
    expect((await tasks.getTask(project.id, task.id))?.labels).toEqual([]);
  });
});

describe('closing and reopening', () => {
  it('records who closed the task, how and why', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Finish' }, OWNER);
    time.advance(10);

    const { task: closed } = await tasks.writeTask(project.id, task.id, { expectedVersion: 1, close: { reason: 'Merged as #3.', resolution: 'done' } }, AGENT);

    expect(closed.status).toBe('closed');
    expect(closed.close).toEqual({ at: time.now(), reason: 'Merged as #3.', resolution: 'done', duplicateOf: null, by: 'agent-a', model: 'model-a' });
    expect(closed.ready).toBe(false);
  });

  it('closes a task as a duplicate of another in the project', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const original = (await tasks.createTask(project.id, { title: 'Original' }, OWNER)).task;
    const copy = (await tasks.createTask(project.id, { title: 'Copy' }, OWNER)).task;

    const { task } = await tasks.writeTask(
      project.id,
      copy.id,
      { expectedVersion: 1, close: { reason: 'Same work.', resolution: 'duplicate', duplicateOf: original.id } },
      AGENT,
    );

    expect(task.close).toMatchObject({ resolution: 'duplicate', duplicateOf: original.id });
    await expectRefusal(
      tasks.writeTask(project.id, original.id, { expectedVersion: 1, close: { reason: 'x', resolution: 'duplicate', duplicateOf: original.id } }, AGENT),
      'invalid',
    );
  });

  it('reopens a closed task with no close left on it, and keeps the earlier close in history (rule 6)', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Again' }, OWNER);
    await tasks.writeTask(project.id, task.id, { expectedVersion: 1, close: { reason: 'Thought done.', resolution: 'done' } }, AGENT);

    const { task: reopened } = await tasks.writeTask(project.id, task.id, { expectedVersion: 2, reopen: true, comment: 'It broke again.' }, OWNER);

    expect(reopened).toMatchObject({ status: 'open', close: null, version: 3, ready: true });
    const closes = (await historyOf(tasks, project.id, task.id)).filter((event) => event.kind === 'closed');
    expect(closes).toHaveLength(1);
    expect(closes[0]!.changes.close).toMatchObject({ reason: 'Thought done.', by: 'agent-a' });
  });

  it('refuses to close a closed task, reopen an open one, or set the status of a closed one', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Strict' }, OWNER);

    await expectRefusal(tasks.writeTask(project.id, task.id, { expectedVersion: 1, reopen: true }, OWNER), 'invalid');
    await tasks.writeTask(project.id, task.id, { expectedVersion: 1, close: { reason: 'Done.', resolution: 'done' } }, OWNER);
    await expectRefusal(tasks.writeTask(project.id, task.id, { expectedVersion: 2, close: { reason: 'Again.', resolution: 'done' } }, OWNER), 'invalid');
    await expectRefusal(tasks.writeTask(project.id, task.id, { expectedVersion: 2, set: { status: 'open' } }, OWNER), 'invalid');
  });
});

describe('history (rule 4)', () => {
  it('records one event per change and rebuilds the task from its events', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const blocker = (await tasks.createTask(project.id, { title: 'Blocker' }, OWNER)).task;
    const { task } = await tasks.createTask(project.id, { title: 'Tracked', labels: ['a'], metadata: { n: 1 } }, OWNER);
    const writes = [
      { set: { title: 'Tracked closely', priority: 1 } },
      { set: { assignee: AGENT.name, status: 'in_progress' as const } },
      { addLabels: ['b'], removeLabels: ['a'], metadata: { n: 2 } },
      { addLinks: [{ taskId: blocker.id, type: 'blocks' as const }] },
      { close: { reason: 'Done.', resolution: 'done' as const } },
    ];
    for (const [index, write] of writes.entries()) {
      time.advance(1);
      await tasks.writeTask(project.id, task.id, { expectedVersion: index + 1, ...write }, AGENT);
    }

    const events = await historyOf(tasks, project.id, task.id);
    expect(events.map((event) => [event.kind, event.version])).toEqual([
      ['created', 1],
      ['updated', 2],
      ['updated', 3],
      ['updated', 4],
      ['updated', 5],
      ['closed', 6],
    ]);
    const rebuilt: Record<string, Json> = {};
    for (const event of events) Object.assign(rebuilt, event.changes);
    const current = (await tasks.getTask(project.id, task.id))!;
    const fields = ['title', 'priority', 'status', 'assignee', 'assigneeModel', 'startedAt', 'labels', 'metadata', 'close'] as const;
    for (const field of fields) expect(rebuilt[field], field).toEqual(current[field]);
    expect(rebuilt.dependencies).toEqual(current.dependencies.map((link) => ({ taskId: link.taskId, type: link.type })));
  });

  it('pages history newest first', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Busy' }, OWNER);
    for (let version = 1; version <= 3; version += 1) {
      await tasks.writeTask(project.id, task.id, { expectedVersion: version, set: { priority: version } }, OWNER);
    }

    const newest = await tasks.listHistory(project.id, task.id, { limit: 2 });
    const older = await tasks.listHistory(project.id, task.id, { limit: 2, beforeSeq: newest.at(-1)!.seq });

    expect(newest.map((event) => event.version)).toEqual([4, 3]);
    expect(older.map((event) => event.version)).toEqual([2, 1]);
  });

  it('lists every change after a sequence number, for a client keeping a copy', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { lastSeq: before } = await tasks.listChanges({ after: 0, limit: 1, projectId: project.id });
    const { task } = await tasks.createTask(project.id, { title: 'Synced' }, OWNER);
    await tasks.addComment(project.id, task.id, 'Noted.', AGENT);
    await tasks.writeTask(project.id, task.id, { expectedVersion: 1, set: { priority: 0 } }, AGENT);

    const page = await tasks.listChanges({ after: before, limit: 10, projectId: project.id });

    expect(page.events.map((event) => event.kind)).toEqual(['created', 'commented', 'updated']);
    expect(page.lastSeq).toBe(page.events.at(-1)!.seq);
    expect((await tasks.listChanges({ after: page.lastSeq, limit: 10, projectId: project.id })).events).toEqual([]);
  });
});

describe('retries (rule 3)', () => {
  it('answers a repeated create with the same task, writing nothing', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const request = { title: 'Once only' };
    const retry = await retryFor(`create-${crypto.randomUUID()}`, request, 'create_task');

    const first = await tasks.createTask(project.id, request, AGENT, retry);
    const second = await tasks.createTask(project.id, request, AGENT, retry);

    expect(second.replayed).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    expect((await tasks.listTasks(project.id, { limit: 50 })).tasks).toHaveLength(1);
  });

  it('answers a repeated write with the same result, without a second change', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Commented once' }, OWNER);
    const write = { expectedVersion: 1, comment: 'Shipped in #4.', close: { reason: 'Done.', resolution: 'done' as const } };
    const retry = await retryFor(`close-${crypto.randomUUID()}`, write, 'close_task');

    await tasks.writeTask(project.id, task.id, write, AGENT, retry);
    const again = await tasks.writeTask(project.id, task.id, write, AGENT, retry);

    expect(again.replayed).toBe(true);
    expect(again.task).toMatchObject({ version: 2, status: 'closed', commentCount: 1 });
    expect(await historyOf(tasks, project.id, task.id)).toHaveLength(3);
  });

  it('refuses a key reused for a different request, or in another project', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const other = await newProject(tasks);
    const key = `create-${crypto.randomUUID()}`;
    await tasks.createTask(project.id, { title: 'First' }, AGENT, await retryFor(key, { title: 'First' }, 'create_task'));

    await expectRefusal(tasks.createTask(project.id, { title: 'Second' }, AGENT, await retryFor(key, { title: 'Second' }, 'create_task')), 'retry_conflict');
    await expectRefusal(tasks.createTask(other.id, { title: 'First' }, AGENT, await retryFor(key, { title: 'First' }, 'create_task')), 'retry_conflict');
  });

  it('answers a repeated comment with the same comment', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Chatty' }, OWNER);
    const retry = await retryFor(`comment-${crypto.randomUUID()}`, 'Hello.', 'comment');

    const first = await tasks.addComment(project.id, task.id, 'Hello.', AGENT, retry);
    const again = await tasks.addComment(project.id, task.id, 'Hello.', AGENT, retry);

    expect(again).toEqual({ comment: first.comment, replayed: true });
    expect(await tasks.listComments(project.id, task.id)).toHaveLength(1);
  });

  it('answers again once a refused write is retried with its key, as a new attempt', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Retried after refusal' }, OWNER);
    const write = { expectedVersion: 2, set: { priority: 0 } };
    const retry = await retryFor(`stale-${crypto.randomUUID()}`, write, 'update_task');

    await expectRefusal(tasks.writeTask(project.id, task.id, write, AGENT, retry), 'version_conflict');
    await tasks.writeTask(project.id, task.id, { expectedVersion: 1, set: { title: 'Bumped' } }, OWNER);
    const { task: after, replayed } = await tasks.writeTask(project.id, task.id, write, AGENT, retry);

    expect(replayed).toBe(false);
    expect(after.priority).toBe(0);
  });
});

describe('decisions', () => {
  it('records a person\'s choice and the close in one write', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const choices = { question: 'Which database?', options: [{ key: 'a', label: 'D1', recommended: true }, { key: 'b', label: 'Postgres' }] } as const;
    const { task } = await tasks.createTask(project.id, { title: 'Pick the database', type: 'decision', choices }, AGENT);

    const { task: decided } = await tasks.writeTask(
      project.id,
      task.id,
      {
        expectedVersion: 1,
        set: { choice: { option: 'a', label: 'D1', by: 'owner', at: '2026-11-06T12:00:00.000Z' } },
        comment: 'Chose (a) D1.',
        close: { reason: 'Chose (a) D1.', resolution: 'done' },
      },
      OWNER,
    );

    expect(decided).toMatchObject({ choices, choice: { option: 'a', label: 'D1' }, status: 'closed', commentCount: 1, version: 2 });
  });

  it('refuses a choice on a task with no choices', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Not a decision' }, AGENT);

    await expectRefusal(tasks.writeTask(project.id, task.id, { expectedVersion: 1, set: { choice: { option: 'a' } } }, OWNER), 'invalid');
  });
});

describe('the result of a write', () => {
  it('is the task as it stands after the write', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Fresh' }, OWNER);

    const { task: written } = await tasks.writeTask(project.id, task.id, { expectedVersion: 1, set: { title: 'Fresher' }, comment: 'Renamed.' }, AGENT);

    expect(written).toEqual((await tasks.getTask(project.id, task.id)) as Task);
  });
});
