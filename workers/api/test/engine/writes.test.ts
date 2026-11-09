// How the engine changes a task: claims and races, closing and reopening,
// history, retries and decisions. These are the rules in docs/architecture.md
// ("Rules every change keeps"). The groups follow Beads' backend conformance
// suite (MIT License, Copyright (c) 2025 Beads Contributors;
// THIRD_PARTY_NOTICES.md), backend/conformance/conformance.go in v1.3.1.
import { TaskRefused, type Json, type Task, type TaskEngine } from '@ntasks/domain';
import { describe, expect, it } from 'vitest';
import type { Database } from '../../src/engine/database.ts';
import { createEngine } from '../../src/engine/index.ts';
import { storeDatabase } from '../store.ts';
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

    const { task: claimed } = await tasks.writeTask(
      project.id,
      task.id,
      { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress' } },
      AGENT,
    );

    expect(claimed).toMatchObject({
      assignee: 'agent-a',
      assigneeModel: 'model-a',
      status: 'in_progress',
      startedAt: time.now(),
      version: 2,
    });
  });

  it('refuses a claim on a task someone else holds, naming the holder', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Taken' }, OWNER);
    await tasks.writeTask(
      project.id,
      task.id,
      { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress' } },
      AGENT,
    );

    const refusal = await expectRefusal(
      tasks.writeTask(
        project.id,
        task.id,
        { expectedVersion: 2, set: { assignee: OTHER.name, status: 'in_progress' } },
        OTHER,
      ),
      'held',
    );
    expect(refusal.message).toContain('agent-a');
  });

  it('lets a person give a held task to someone else, or release it', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Handed over' }, OWNER);
    await tasks.writeTask(
      project.id,
      task.id,
      { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress' } },
      AGENT,
    );

    const { task: given } = await tasks.writeTask(
      project.id,
      task.id,
      { expectedVersion: 2, set: { assignee: OTHER.name } },
      OWNER,
    );
    expect(given).toMatchObject({ assignee: 'agent-b', assigneeModel: null });

    const { task: released } = await tasks.writeTask(
      project.id,
      task.id,
      { expectedVersion: 3, set: { assignee: null, status: 'open' } },
      OWNER,
    );
    expect(released).toMatchObject({ assignee: null, status: 'open', ready: true });
  });

  it('lets exactly one of two agents that read the same version claim the task, and records nothing for the other', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Contested' }, OWNER);

    const outcomes = await Promise.allSettled(
      [AGENT, OTHER].map((actor) =>
        tasks.writeTask(
          project.id,
          task.id,
          {
            expectedVersion: 1,
            set: { assignee: actor.name, status: 'in_progress' },
            comment: `${actor.name} starts.`,
          },
          actor,
        ),
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
    expect((await historyOf(tasks, project.id, task.id)).map((event) => event.kind)).toEqual([
      'created',
      'commented',
      'updated',
    ]);
  });

  it('lets exactly one of two closes of the same version succeed', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Closed twice' }, OWNER);

    const outcomes = await Promise.allSettled([
      tasks.writeTask(
        project.id,
        task.id,
        { expectedVersion: 1, close: { reason: 'Shipped.', resolution: 'done' } },
        AGENT,
      ),
      tasks.writeTask(
        project.id,
        task.id,
        { expectedVersion: 1, close: { reason: 'Not needed.', resolution: 'wont-do' } },
        OTHER,
      ),
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

    await expectRefusal(
      tasks.writeTask(project.id, task.id, { expectedVersion: 1, set: { priority: 0 }, addLabels: ['late'] }, AGENT),
      'version_conflict',
    );
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

    const { task: closed } = await tasks.writeTask(
      project.id,
      task.id,
      { expectedVersion: 1, close: { reason: 'Merged as #3.', resolution: 'done' } },
      AGENT,
    );

    expect(closed.status).toBe('closed');
    expect(closed.close).toEqual({
      at: time.now(),
      reason: 'Merged as #3.',
      resolution: 'done',
      duplicateOf: null,
      by: 'agent-a',
      model: 'model-a',
      link: null,
    });
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
      tasks.writeTask(
        project.id,
        original.id,
        { expectedVersion: 1, close: { reason: 'x', resolution: 'duplicate', duplicateOf: original.id } },
        AGENT,
      ),
      'invalid',
    );
  });

  it('reopens a closed task with no close left on it, and keeps the earlier close in history (rule 6)', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Again' }, OWNER);
    await tasks.writeTask(
      project.id,
      task.id,
      { expectedVersion: 1, close: { reason: 'Thought done.', resolution: 'done' } },
      AGENT,
    );

    const { task: reopened } = await tasks.writeTask(
      project.id,
      task.id,
      { expectedVersion: 2, reopen: true, comment: 'It broke again.' },
      OWNER,
    );

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
    await tasks.writeTask(
      project.id,
      task.id,
      { expectedVersion: 1, close: { reason: 'Done.', resolution: 'done' } },
      OWNER,
    );
    await expectRefusal(
      tasks.writeTask(
        project.id,
        task.id,
        { expectedVersion: 2, close: { reason: 'Again.', resolution: 'done' } },
        OWNER,
      ),
      'invalid',
    );
    await expectRefusal(
      tasks.writeTask(project.id, task.id, { expectedVersion: 2, set: { status: 'open' } }, OWNER),
      'invalid',
    );
  });
});

describe('history (rule 4)', () => {
  it('records one event per change and rebuilds the task from its events', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const blocker = (await tasks.createTask(project.id, { title: 'Blocker' }, OWNER)).task;
    const other = (await tasks.createTask(project.id, { title: 'Replaced' }, OWNER)).task;
    const { task } = await tasks.createTask(project.id, { title: 'Tracked', labels: ['a'], metadata: { n: 1 } }, OWNER);
    const writes = [
      { set: { title: 'Tracked closely', priority: 1 } },
      { set: { assignee: AGENT.name, status: 'in_progress' as const } },
      { addLabels: ['b'], removeLabels: ['a'], metadata: { n: 2 } },
      { addLinks: [{ taskId: blocker.id, type: 'blocks' as const }] },
      { set: { notes: 'Seen on mobile.', design: 'One query.', estimateMinutes: 30 } },
      {
        addLinks: [{ taskId: other.id, type: 'supersedes' as const }],
        addExternalLinks: [
          { url: 'https://example.com/acme/web/pull/4', title: 'The fix', kind: 'pull-request' as const },
        ],
      },
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
      ['updated', 6],
      ['updated', 7],
      ['closed', 8],
    ]);
    const rebuilt: Record<string, Json> = {};
    for (const event of events) Object.assign(rebuilt, event.changes);
    const current = (await tasks.getTask(project.id, task.id))!;
    const fields = [
      'title',
      'priority',
      'status',
      'assignee',
      'assigneeModel',
      'startedAt',
      'labels',
      'metadata',
      'notes',
      'design',
      'estimateMinutes',
      'externalLinks',
      'close',
    ] as const;
    for (const field of fields) expect(rebuilt[field], field).toEqual(current[field]);
    expect(rebuilt.dependencies).toEqual(
      current.dependencies.map((link) => ({ taskId: link.taskId, type: link.type })),
    );
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
    const write = {
      expectedVersion: 1,
      comment: 'Shipped in #4.',
      close: { reason: 'Done.', resolution: 'done' as const },
    };
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
    await tasks.createTask(
      project.id,
      { title: 'First' },
      AGENT,
      await retryFor(key, { title: 'First' }, 'create_task'),
    );

    await expectRefusal(
      tasks.createTask(project.id, { title: 'Second' }, AGENT, await retryFor(key, { title: 'Second' }, 'create_task')),
      'retry_conflict',
    );
    await expectRefusal(
      tasks.createTask(other.id, { title: 'First' }, AGENT, await retryFor(key, { title: 'First' }, 'create_task')),
      'retry_conflict',
    );
  });

  it('reads back an earlier write by its key, without writing, for the API to check before a rule the write broke', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const other = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Closed once' }, OWNER);
    const write = { expectedVersion: 1, close: { reason: 'Done.', resolution: 'done' as const } };
    const key = `close-${crypto.randomUUID()}`;
    const retry = await retryFor(key, write, 'close_task');

    expect(await tasks.recordedWrite(project.id, retry)).toBeNull();
    await tasks.writeTask(project.id, task.id, write, AGENT, retry);
    const recorded = await tasks.recordedWrite(project.id, retry);

    expect(recorded).toMatchObject({
      task: { id: task.id, status: 'closed', version: 2 },
      created: [],
      replayed: true,
    });
    await expectRefusal(
      tasks.recordedWrite(project.id, await retryFor(key, { other: true }, 'close_task')),
      'retry_conflict',
    );
    await expectRefusal(tasks.recordedWrite(other.id, retry), 'retry_conflict');
    const commented = await retryFor(`comment-${crypto.randomUUID()}`, 'Hi.', 'close_task');
    await tasks.addComment(project.id, task.id, 'Hi.', AGENT, commented);
    await expectRefusal(tasks.recordedWrite(project.id, commented), 'retry_conflict');
    expect(await historyOf(tasks, project.id, task.id)).toHaveLength(3);
  });

  it("reads back a derived key's record of a new task only while the task is unchanged, and for a day", async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const request = { title: 'Filed once' };
    const derived = async () => ({
      ...(await retryFor(`auto:${crypto.randomUUID()}`, request, 'create_task')),
      derived: true,
    });

    const today = await derived();
    await tasks.createTask(project.id, request, AGENT, today);
    expect(await tasks.recordedWrite(project.id, today)).toMatchObject({ replayed: true });
    time.advance(24 * 60 + 1);
    expect(await tasks.recordedWrite(project.id, today)).toBeNull();
    // Read as a caller's own key, the same record still answers for seven days.
    expect(await tasks.recordedWrite(project.id, { ...today, derived: false })).toMatchObject({ replayed: true });

    const changed = await derived();
    const { task } = await tasks.createTask(project.id, request, AGENT, changed);
    await tasks.writeTask(project.id, task.id, { expectedVersion: 1, set: { priority: 0 } }, OWNER);
    expect(await tasks.recordedWrite(project.id, changed)).toBeNull();
  });

  it('records the key of a write that changed nothing, without a new version or history', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Already so' }, OWNER);
    const key = `noop-${crypto.randomUUID()}`;
    const retry = await retryFor(key, { title: 'Already so' }, 'update_task');

    const recorded = await tasks.recordUnchanged(project.id, task.id, 1, retry);
    expect(recorded).toMatchObject({ task: { id: task.id, version: 1 }, created: [], replayed: false });
    expect(await historyOf(tasks, project.id, task.id)).toHaveLength(1);

    await tasks.writeTask(project.id, task.id, { expectedVersion: 1, set: { title: 'Moved on' } }, OWNER);
    expect(await tasks.recordUnchanged(project.id, task.id, 1, retry)).toMatchObject({
      task: { title: 'Moved on', version: 2 },
      replayed: true,
    });
    expect(await tasks.recordedWrite(project.id, retry)).toMatchObject({ replayed: true });
    await expectRefusal(
      tasks.recordedWrite(project.id, await retryFor(key, { title: 'Other' }, 'update_task')),
      'retry_conflict',
    );
  });

  it('records nothing for a task that changed since it was read, or that does not exist', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Moving' }, OWNER);
    await tasks.writeTask(project.id, task.id, { expectedVersion: 1, set: { title: 'Moved' } }, OWNER);
    const retry = await retryFor(`stale-${crypto.randomUUID()}`, { title: 'Moved' }, 'update_task');

    await expectRefusal(tasks.recordUnchanged(project.id, task.id, 1, retry), 'version_conflict');
    expect(await tasks.recordedWrite(project.id, retry)).toBeNull();
    await expectRefusal(tasks.recordUnchanged(project.id, `${project.prefix}-none`, 1, retry), 'not_found');
    expect(await tasks.recordUnchanged(project.id, task.id, 2, retry)).toMatchObject({ replayed: false });
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

  it('answers two copies of one retried write sent at once with the same result, changing the task once', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Sent twice' }, OWNER);
    const write = { expectedVersion: 1, set: { priority: 0 }, comment: 'Raised.' };
    const retry = await retryFor(`twice-${crypto.randomUUID()}`, write, 'update_task');

    const outcomes = await Promise.allSettled(
      [1, 2].map(() => tasks.writeTask(project.id, task.id, write, AGENT, retry)),
    );

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    const results = outcomes.map(
      (outcome) => (outcome as PromiseFulfilledResult<Awaited<ReturnType<TaskEngine['writeTask']>>>).value,
    );
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(results.map((result) => result.task.version)).toEqual([2, 2]);
    expect((await tasks.getTask(project.id, task.id))?.commentCount).toBe(1);
  });
});

describe('a new task that asks for an approval', () => {
  it('opens the approval in the same batch, and answers a retry with both', async () => {
    const time = clock();
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const input = {
      title: 'Deploy',
      priority: 1,
      requestApproval: { reason: 'Deploy to production.\nIt creates the database.' },
    };
    const retry = await retryFor(`create-${crypto.randomUUID()}`, input, 'create_task');

    const { task, created } = await tasks.createTask(project.id, input, AGENT, retry);

    const [gate] = created;
    expect(gate).toMatchObject({
      type: 'gate',
      awaitType: 'human',
      status: 'open',
      priority: 1,
      title: 'Deploy to production.',
      filedBy: AGENT.name,
    });
    expect(task.dependencies).toEqual([{ taskId: gate!.id, type: 'blocks', title: gate!.title, status: 'open' }]);
    expect(task.ready).toBe(false);
    const [event] = await historyOf(tasks, project.id, task.id);
    expect(event!.changes.dependencies).toEqual([{ taskId: gate!.id, type: 'blocks' }]);

    const again = await tasks.createTask(project.id, input, AGENT, retry);
    expect(again).toMatchObject({ replayed: true, task: { id: task.id }, created: [{ id: gate!.id }] });
    expect((await tasks.listTasks(project.id, { limit: 10 })).tasks).toHaveLength(2);
  });

  it("titles the approval with the reason's first line that is not blank, without its spaces or carriage return", async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const reason = '\n  \r\n  Rotate the signing key.  \r\nIt signs every session out.';
    const { created } = await tasks.createTask(project.id, { title: 'Rotate', requestApproval: { reason } }, AGENT);
    const { task } = await tasks.createTask(project.id, { title: 'Later' }, AGENT);
    const asked = await tasks.writeTask(
      project.id,
      task.id,
      { expectedVersion: 1, requestApproval: { reason } },
      AGENT,
    );

    for (const gate of [created[0]!, asked.created[0]!]) {
      expect(gate).toMatchObject({ title: 'Rotate the signing key.', description: reason });
    }
  });

  it('refuses an approval with no reason, filing nothing', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    await expectRefusal(
      tasks.createTask(project.id, { title: 'Ask', requestApproval: { reason: ' ' } }, AGENT),
      'invalid',
    );
    expect((await tasks.listTasks(project.id, { limit: 10 })).tasks).toEqual([]);
  });
});

describe('a request that a person do steps', () => {
  const steps = [{ text: 'Run the update.', command: './update.sh' }, { text: 'Sign in.' }];

  async function asked() {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Update' }, AGENT);
    const { created } = await tasks.writeTask(
      project.id,
      task.id,
      { expectedVersion: 1, requestAction: { title: 'Update the site', context: 'Why.', steps } },
      AGENT,
    );
    return { tasks, project, task, gate: created[0]! };
  }

  it('changes only the marks on its steps, never their text or commands, and only on a request', async () => {
    const { tasks, project, task, gate } = await asked();
    const marks = gate.steps!.map((step, index) =>
      index === 0 ? { ...step, done: { by: OWNER.name, at: '2026-11-06T12:00:00.000Z' } } : step,
    );
    const { task: ticked } = await tasks.writeTask(
      project.id,
      gate.id,
      { expectedVersion: 1, set: { steps: marks } },
      OWNER,
    );
    expect(ticked.steps![0]!.done).toEqual({ by: OWNER.name, at: '2026-11-06T12:00:00.000Z' });
    for (const changed of [
      marks.map((step, index) => (index === 1 ? { ...step, text: 'Sign out.' } : step)),
      marks.map((step, index) => (index === 0 ? { ...step, command: 'rm -rf /' } : step)),
      marks.slice(0, 1),
      marks.map((step, index) =>
        index === 0 ? { ...step, stuck: { by: OWNER.name, at: '2026-11-06T12:00:00.000Z', reason: 'Stopped.' } } : step,
      ),
    ]) {
      await expectRefusal(
        tasks.writeTask(project.id, gate.id, { expectedVersion: 2, set: { steps: changed } }, AGENT),
        'invalid',
      );
    }
    await expectRefusal(
      tasks.writeTask(project.id, task.id, { expectedVersion: task.version + 1, set: { steps: marks } }, AGENT),
      'invalid',
    );
    expect((await tasks.getTask(project.id, gate.id))!.version).toBe(2);
  });

  it('opens one request a write: an approval or steps, not both', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Update' }, AGENT);
    await expectRefusal(
      tasks.writeTask(
        project.id,
        task.id,
        {
          expectedVersion: 1,
          requestApproval: { reason: 'Update?' },
          requestAction: { title: 'Update the site', context: '', steps },
        },
        AGENT,
      ),
      'invalid',
    );
    expect((await tasks.getTask(project.id, task.id))!.dependencies).toEqual([]);
  });
});

describe('a new task that blocks another', () => {
  it("keeps the other task's history whole while that task changes at the same moment", async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const waiting = (await tasks.createTask(project.id, { title: 'Waiting' }, OWNER)).task;

    // Each round races a create, which links into `waiting`, against a direct edit of it.
    for (let round = 0; round < 10; round += 1) {
      const current = (await tasks.getTask(project.id, waiting.id))!;
      await Promise.allSettled([
        tasks.createTask(
          project.id,
          { title: `Blocker ${round}`, links: [{ direction: 'blocks', taskId: waiting.id, type: 'blocks' }] },
          AGENT,
        ),
        tasks.writeTask(
          project.id,
          waiting.id,
          { expectedVersion: current.version, set: { priority: round % 5 } },
          OWNER,
        ),
      ]);
    }

    const after = (await tasks.getTask(project.id, waiting.id))!;
    const versions = (await historyOf(tasks, project.id, waiting.id))
      .filter((event) => event.kind !== 'commented')
      .map((event) => event.version);
    expect(versions).toEqual(Array.from({ length: after.version }, (_, index) => index + 1));
    const rebuilt: Record<string, Json> = {};
    for (const event of await historyOf(tasks, project.id, waiting.id)) Object.assign(rebuilt, event.changes);
    expect(rebuilt.dependencies).toEqual(after.dependencies.map((link) => ({ taskId: link.taskId, type: link.type })));
    expect(after.dependencies).toHaveLength(10);
  });
});

describe('decisions', () => {
  it("records a person's choice and the close in one write", async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const choices = {
      question: 'Which database?',
      options: [
        { key: 'a', label: 'D1', recommended: true },
        { key: 'b', label: 'Postgres' },
      ],
    } as const;
    const { task } = await tasks.createTask(
      project.id,
      { title: 'Pick the database', type: 'decision', choices },
      AGENT,
    );

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

    expect(decided).toMatchObject({
      choices,
      choice: { option: 'a', label: 'D1' },
      status: 'closed',
      commentCount: 1,
      version: 2,
    });
  });

  it('refuses a choice on a task with no choices', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Not a decision' }, AGENT);

    await expectRefusal(
      tasks.writeTask(project.id, task.id, { expectedVersion: 1, set: { choice: { option: 'a' } } }, OWNER),
      'invalid',
    );
  });
});

describe('changes to other tasks in the same write', () => {
  /** An approval with a task waiting on it, the task labelled human and held. */
  async function waitingOnApproval(tasks: TaskEngine) {
    const project = await newProject(tasks);
    const { task, created } = await tasks.createTask(
      project.id,
      { title: 'Ship it', labels: ['human'], requestApproval: { reason: 'Deploy once' } },
      OWNER,
    );
    await tasks.writeTask(project.id, task.id, { expectedVersion: 1, set: { assignee: AGENT.name } }, AGENT);
    return { project, gate: created[0]!, waiting: (await tasks.getTask(project.id, task.id))! };
  }

  it('closes an approval, comments on and hands back the task waiting on it, in one batch', async () => {
    const tasks = engine();
    const { project, gate, waiting } = await waitingOnApproval(tasks);

    const { task: closed } = await tasks.writeTask(
      project.id,
      gate.id,
      {
        expectedVersion: gate.version,
        close: { reason: 'Owner approved the recorded scope', resolution: 'done' },
        others: [
          {
            taskId: waiting.id,
            expectedVersion: waiting.version,
            set: { status: 'open', assignee: null },
            removeLabels: ['human'],
            comment: 'Owner approval recorded.',
          },
        ],
      },
      OWNER,
    );

    expect(closed.status).toBe('closed');
    const after = (await tasks.getTask(project.id, waiting.id))!;
    expect(after).toMatchObject({ assignee: null, labels: [], ready: true, version: waiting.version + 1 });
    expect((await tasks.listComments(project.id, waiting.id)).map((comment) => comment.text)).toEqual([
      'Owner approval recorded.',
    ]);
    expect((await historyOf(tasks, project.id, waiting.id)).at(-1)).toMatchObject({ actor: 'owner' });
  });

  it('leaves the version of a task it only comments on, as a comment does', async () => {
    const tasks = engine();
    const { project, gate, waiting } = await waitingOnApproval(tasks);

    await tasks.writeTask(
      project.id,
      gate.id,
      {
        expectedVersion: gate.version,
        close: { reason: 'Retired', resolution: 'no-longer-needed' },
        others: [{ taskId: waiting.id, expectedVersion: waiting.version, comment: 'Approval retired.' }],
      },
      OWNER,
    );

    const after = (await tasks.getTask(project.id, waiting.id))!;
    expect(after).toMatchObject({ version: waiting.version, commentCount: 1 });
    const events = await historyOf(tasks, project.id, waiting.id);
    expect(events.at(-1)).toMatchObject({ kind: 'commented', version: waiting.version });
  });

  it('writes nothing when a task it only comments on changes between its read and its batch', async () => {
    const inner = storeDatabase();
    let beforeBatch: (() => Promise<void>) | null = null;
    const db: Database = {
      prepare: (sql) => inner.prepare(sql),
      async batch(statements) {
        const hook = beforeBatch;
        beforeBatch = null;
        if (hook) await hook();
        return inner.batch(statements);
      },
    };
    const tasks = createEngine(db);
    const { project, gate, waiting } = await waitingOnApproval(tasks);
    // Another write lands after this one read the task and before its batch.
    beforeBatch = () =>
      inner.prepare('UPDATE tasks SET priority = 0, version = version + 1 WHERE id = ?1').bind(waiting.id).run();

    await expectRefusal(
      tasks.writeTask(
        project.id,
        gate.id,
        {
          expectedVersion: gate.version,
          close: { reason: 'Retired', resolution: 'no-longer-needed' },
          others: [{ taskId: waiting.id, expectedVersion: waiting.version, comment: 'Approval retired.' }],
        },
        OWNER,
      ),
      'version_conflict',
    );
    expect((await tasks.getTask(project.id, gate.id))!.status).toBe('open');
    expect(await tasks.listComments(project.id, waiting.id)).toEqual([]);
  });

  it('writes nothing when another task changed since it was read', async () => {
    const tasks = engine();
    const { project, gate, waiting } = await waitingOnApproval(tasks);
    await tasks.writeTask(project.id, waiting.id, { expectedVersion: waiting.version, set: { priority: 0 } }, AGENT);

    await expectRefusal(
      tasks.writeTask(
        project.id,
        gate.id,
        {
          expectedVersion: gate.version,
          close: { reason: 'Approved', resolution: 'done' },
          others: [{ taskId: waiting.id, expectedVersion: waiting.version, set: { assignee: null } }],
        },
        OWNER,
      ),
      'version_conflict',
    );
    expect((await tasks.getTask(project.id, gate.id))!.status).toBe('open');
  });

  it('refuses another task named twice, the task itself, an approval or a task outside the project', async () => {
    const tasks = engine();
    const { project, gate, waiting } = await waitingOnApproval(tasks);
    const outside = await newProject(tasks);
    const { task: elsewhere } = await tasks.createTask(outside.id, { title: 'Elsewhere' }, OWNER);
    const base = { expectedVersion: gate.version, close: { reason: 'Approved', resolution: 'done' as const } };
    const other = { taskId: waiting.id, expectedVersion: waiting.version, comment: 'Told.' };

    await expectRefusal(tasks.writeTask(project.id, gate.id, { ...base, others: [other, other] }, OWNER), 'invalid');
    await expectRefusal(
      tasks.writeTask(project.id, gate.id, { ...base, others: [{ ...other, taskId: gate.id }] }, OWNER),
      'invalid',
    );
    await expectRefusal(
      tasks.writeTask(
        project.id,
        gate.id,
        { ...base, others: [{ ...other, requestApproval: { reason: 'Again' } } as typeof other] },
        OWNER,
      ),
      'invalid',
    );
    await expectRefusal(
      tasks.writeTask(project.id, gate.id, { ...base, others: [{ ...other, taskId: elsewhere.id }] }, OWNER),
      'not_found',
    );
    expect((await tasks.getTask(project.id, gate.id))!.status).toBe('open');
  });
});

describe('reading several tasks and the work agents did', () => {
  it('reads the tasks named, leaving out ids the project does not hold', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task: first } = await tasks.createTask(project.id, { title: 'First' }, OWNER);
    const { task: second } = await tasks.createTask(project.id, { title: 'Second' }, OWNER);

    const found = await tasks.getTasks(project.id, [second.id, first.id, `${project.prefix}-none`]);

    expect(found.map((task) => task.title).sort()).toEqual(['First', 'Second']);
  });

  it('lists the work in progress or blocked, and closed from a time, with who held and closed it', async () => {
    const time = clock('2026-11-01T12:00:00.000Z');
    const tasks = engine({ now: time.now });
    const project = await newProject(tasks);
    const make = async (title: string) => (await tasks.createTask(project.id, { title }, OWNER)).task;
    const held = await make('Held');
    const waiting = await make('Waiting');
    const early = await make('Closed early');
    const late = await make('Closed late');
    await make('Open');
    await tasks.writeTask(
      project.id,
      held.id,
      { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress' } },
      AGENT,
    );
    await tasks.writeTask(project.id, waiting.id, { expectedVersion: 1, set: { status: 'blocked' } }, OWNER);
    await tasks.writeTask(
      project.id,
      early.id,
      { expectedVersion: 1, close: { reason: 'Done', resolution: 'done' } },
      OTHER,
    );
    time.advance(60 * 24 * 3);
    await tasks.writeTask(
      project.id,
      late.id,
      { expectedVersion: 1, close: { reason: 'Done', resolution: 'done' } },
      OTHER,
    );

    const work = await tasks.listWork([project.id], '2026-11-02T00:00:00.000Z');

    expect(work.map((item) => item.id).sort()).toEqual([held.id, late.id, waiting.id].sort());
    expect(work.find((item) => item.id === held.id)).toMatchObject({
      projectId: project.id,
      status: 'in_progress',
      assignee: 'agent-a',
      assigneeModel: 'model-a',
      startedAt: '2026-11-01T12:00:00.000Z',
    });
    expect(work.find((item) => item.id === late.id)).toMatchObject({
      status: 'closed',
      closedBy: 'agent-b',
      closedModel: 'model-b',
      closedAt: '2026-11-04T12:00:00.000Z',
    });
    expect(await tasks.listWork([], '2026-11-02T00:00:00.000Z')).toEqual([]);
  });
});

describe('the result of a write', () => {
  it('is the task as it stands after the write', async () => {
    const tasks = engine();
    const project = await newProject(tasks);
    const { task } = await tasks.createTask(project.id, { title: 'Fresh' }, OWNER);

    const { task: written } = await tasks.writeTask(
      project.id,
      task.id,
      { expectedVersion: 1, set: { title: 'Fresher' }, comment: 'Renamed.' },
      AGENT,
    );

    expect(written).toEqual((await tasks.getTask(project.id, task.id)) as Task);
  });
});
