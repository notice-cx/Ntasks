// The HTTP routes of a person's decisions, in the shapes NoticeOS's Tasks API
// took: answering, picking, dismissing, approving and disputing, who may send
// them, how a retry is answered, and what each refusal says. The rules of a
// pick and an answer are ported from NoticeOS's
// scripts/hosted-task-command.test.mjs (choiceSteps and answerSteps).
import type { Project, Task, TaskEngine } from '@ntasks/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { SCOPES, type Principal } from '../../src/auth.ts';
import { createEngine } from '../../src/engine/index.ts';
import { cachedReads } from '../../src/store/cache.ts';
import { AGENT, clock, newProject, OWNER } from '../engine/helpers.ts';
import { storeDatabase } from '../store.ts';
import { api, get, send, WRITER, type TestApi } from './helpers.ts';

/** The owner, signed in to the web app. */
const PERSON: Principal = Object.freeze({
  id: 'person:owner',
  name: 'Person',
  scopes: [SCOPES.read, SCOPES.write, SCOPES.backup, SCOPES.decide],
  projects: 'all',
  person: 'Person',
});

const time = clock('2026-11-06T12:00:00.000Z');
let target: TestApi;
let engine: TaskEngine;
let project: Project;

beforeAll(async () => {
  target = api({ principal: PERSON, now: time.now });
  engine = target.engine;
  project = await newProject(engine);
});

const CHOICES = {
  question: 'What happens to the old page?',
  options: [
    { key: 'a', label: 'Keep the old page', recommended: true },
    { key: 'b', label: 'Redirect to the new page' },
    { key: 'c', label: 'Delete it' },
  ],
} as const;

async function task(input: Partial<Parameters<TaskEngine['createTask']>[1]> = {}) {
  return engine.createTask(project.id, { title: 'Asks a person', labels: ['human', 'ui'], ...input }, OWNER);
}

async function current(id: string): Promise<Task> {
  return (await engine.getTask(project.id, id))!;
}

async function texts(id: string): Promise<string[]> {
  return (await engine.listComments(project.id, id)).map((comment) => comment.text);
}

const post = (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}, as = target) =>
  send(as, 'POST', path, { projectId: project.id, ...body }, headers);

describe('who may decide', () => {
  it('only a person signed in to the web app, whatever an agent or a service was granted', async () => {
    const { task: asked } = await task({ choices: CHOICES });
    const { created } = await task({ requestApproval: { reason: 'Deploy once' } });
    const gate = created[0]!;
    const service: Principal = { ...WRITER, id: 'service:x/tower', name: 'service:noticeos/tower' };
    for (const sender of [WRITER, service]) {
      const as = api({ principal: sender, now: time.now, engine });
      for (const [path, body] of [
        [`/api/tasks/${asked.id}/respond`, { response: 'A' }],
        [`/api/tasks/${asked.id}/choose`, { option: 'a' }],
        [`/api/tasks/${asked.id}/dismiss`, {}],
        [`/api/tasks/${gate.id}/dispute`, {}],
        [`/api/gates/${gate.id}/resolve`, {}],
      ] as const) {
        expect(await post(path, body, {}, as), path).toEqual({
          status: 403,
          body: {
            error: 'insufficient_scope',
            detail:
              'Only a person signed in to Ntasks answers a decision, approves an approval or disputes one. Answer it in the Ntasks web app.',
          },
        });
      }
    }
    expect(await current(asked.id)).toMatchObject({ status: 'open', choice: null, version: 1 });
    expect((await current(gate.id)).status).toBe('open');
  });

  it('are offered in the capabilities of a person, and of nobody else', async () => {
    expect((await get(target, '/api/tasks/capabilities')).body.operations).toEqual([
      'create',
      'update',
      'comment',
      'close',
      'respond',
      'dismiss',
      'resolve',
      'choose',
      'dispute',
    ]);
    const writer = api({ principal: WRITER, now: time.now, engine });
    expect((await get(writer, '/api/tasks/capabilities')).body.operations).toEqual([
      'create',
      'update',
      'comment',
      'close',
    ]);
  });
});

describe('POST /api/tasks/:id/choose', () => {
  it('records the pick, comments it and hands any task but a decision back to ready work', async () => {
    const { task: asked } = await task({ choices: CHOICES });
    await engine.writeTask(
      project.id,
      asked.id,
      { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress' } },
      AGENT,
    );

    const picked = await post(`/api/tasks/${asked.id}/choose`, { option: 'b', note: 'Ship it Friday' });

    expect(picked.status).toBe(200);
    expect(picked.body.task).toMatchObject({
      id: asked.id,
      status: 'open',
      assignee: null,
      labels: ['ui'],
      choice: { option: 'b', label: 'Redirect to the new page', by: 'Person', at: time.now(), note: 'Ship it Friday' },
    });
    expect(await texts(asked.id)).toEqual(['Chose (b) Redirect to the new page. Ship it Friday']);
    // The pick, its comment and the hand-back are one change.
    expect((await current(asked.id)).version).toBe(3);
  });

  it('closes a decision on the pick, past an open blocker and another holder', async () => {
    const { task: blocker } = await engine.createTask(project.id, { title: 'Blocker' }, OWNER);
    const { task: decision } = await task({
      type: 'decision',
      choices: CHOICES,
      links: [{ direction: 'depends-on', taskId: blocker.id, type: 'blocks' }],
    });
    await engine.writeTask(project.id, decision.id, { expectedVersion: 1, set: { assignee: AGENT.name } }, AGENT);

    const picked = await post(`/api/tasks/${decision.id}/choose`, { option: 'a' });

    expect(picked.body.task).toMatchObject({
      status: 'closed',
      closeReason: 'Chose (a) Keep the old page',
      resolution: 'done',
      closedBy: 'Person',
    });
  });

  it('names why it refuses: no options, an option not offered, a closed task, open children or an approval', async () => {
    const refused = async (id: string, option: string) => {
      const answer = await post(`/api/tasks/${id}/choose`, { option });
      expect(answer.status, JSON.stringify(answer.body)).toBe(409);
      expect(answer.body.error).toBe('task_refused');
      return answer.body.detail;
    };
    const { task: plain } = await task();
    expect(await refused(plain.id, 'b')).toBe(`${plain.id} offers no options to choose from.`);
    const { task: asked } = await task({ choices: CHOICES });
    expect(await refused(asked.id, 'e')).toBe(`${asked.id} offers (a), (b) and (c), not (e).`);
    const { task: closed } = await task({ choices: CHOICES });
    await engine.writeTask(
      project.id,
      closed.id,
      { expectedVersion: 1, close: { reason: 'Gone', resolution: 'wont-do' } },
      OWNER,
    );
    expect(await refused(closed.id, 'b')).toBe(`${closed.id} is already closed.`);
    const { task: parent } = await task({ type: 'decision', choices: CHOICES });
    const { task: child } = await engine.createTask(project.id, { title: 'Child', parentId: parent.id }, OWNER);
    expect(await refused(parent.id, 'b')).toBe(`${parent.id} has open tasks under it: ${child.id}.`);
    const { task: gated, created } = await task({
      type: 'decision',
      choices: CHOICES,
      requestApproval: { reason: 'Spend once' },
    });
    expect(await refused(gated.id, 'b')).toBe(`${gated.id} waits on approval ${created[0]!.id}. Approve it first.`);
    expect(await refused(created[0]!.id, 'a')).toBe(`${created[0]!.id} is an approval: approve it instead.`);
  });

  it('refuses a second pick, and finishes an interrupted one for the same person and option', async () => {
    const { task: asked } = await task({ choices: CHOICES });
    // Recorded but not commented, as a pick NoticeOS interrupted after its first step leaves it.
    const earlier = { option: 'b', label: 'Redirect to the new page', by: 'Person', at: '2026-10-16T12:00:00.000Z' };
    await engine.writeTask(project.id, asked.id, { expectedVersion: 1, set: { choice: earlier } }, OWNER);

    const other = await post(`/api/tasks/${asked.id}/choose`, { option: 'a' });
    expect(other).toEqual({
      status: 409,
      body: { error: 'task_refused', detail: `${asked.id} already has a choice: (b) Redirect to the new page.` },
    });
    const someoneElse = api({
      principal: { ...PERSON, id: 'person:other', name: 'Other Person' },
      now: time.now,
      engine,
    });
    expect((await post(`/api/tasks/${asked.id}/choose`, { option: 'b' }, {}, someoneElse)).status).toBe(409);

    const finished = await post(`/api/tasks/${asked.id}/choose`, { option: 'b' });
    expect(finished.status).toBe(200);
    expect(finished.body.task).toMatchObject({ status: 'open', labels: ['ui'], choice: earlier });
    expect(await texts(asked.id)).toEqual(['Chose (b) Redirect to the new page.']);
    // Commented and handed back: the pick is done, and a third is refused.
    expect((await post(`/api/tasks/${asked.id}/choose`, { option: 'b' })).status).toBe(409);
  });
});

describe('POST /api/tasks/:id/respond', () => {
  it('hands a task that is not a decision back to ready work with the answer as a comment', async () => {
    const { task: asked } = await task();
    await engine.writeTask(project.id, asked.id, { expectedVersion: 1, set: { assignee: AGENT.name } }, AGENT);

    const answered = await post(`/api/tasks/${asked.id}/respond`, { response: 'Use OAuth2' });

    expect(answered.body.task).toMatchObject({ status: 'open', assignee: null, labels: ['ui'], ready: true });
    expect(await texts(asked.id)).toEqual(['Answered: Use OAuth2']);
  });

  it('closes a decision on a free answer with the response, as Beads responded', async () => {
    const { task: decision } = await task({ type: 'decision' });
    const answered = await post(`/api/tasks/${decision.id}/respond`, { response: 'Use OAuth2' });
    expect(answered.body.task).toMatchObject({ status: 'closed', closeReason: 'Responded', closedBy: 'Person' });
    expect(await texts(decision.id)).toEqual(['Response: Use OAuth2']);
  });

  it('reads a reply that names an option as that pick', async () => {
    const { task: decision } = await task({ type: 'decision', choices: CHOICES });
    const answered = await post(`/api/tasks/${decision.id}/respond`, { response: 'yes, your recommendation' });
    expect(answered.body.task).toMatchObject({
      status: 'closed',
      closeReason: 'Chose (a) Keep the old page',
      choice: { option: 'a', by: 'Person' },
    });
    expect(await texts(decision.id)).toEqual(['Chose (a) Keep the old page.']);
  });

  it('refuses an unclear reply, a task that waits on nobody, an approval and a reply too long for a comment', async () => {
    const { task: asked } = await task({ choices: CHOICES });
    expect(await post(`/api/tasks/${asked.id}/respond`, { response: 'Maybe the first?' })).toEqual({
      status: 409,
      body: {
        error: 'task_refused',
        detail: 'This reply leaves the decision unresolved. Ask one clarification covering only the uncertainty.',
      },
    });
    const { task: plain } = await engine.createTask(project.id, { title: 'Nobody asked' }, OWNER);
    expect((await post(`/api/tasks/${plain.id}/respond`, { response: 'Yes' })).body).toEqual({
      error: 'task_refused',
      detail: `${plain.id} does not wait on a person's answer.`,
    });
    const long = await post(`/api/tasks/${asked.id}/respond`, { response: 'x'.repeat(4096 - 'Answered: '.length + 1) });
    expect(long.status).toBe(400);
    expect((await post(`/api/tasks/${asked.id}/respond`, { response: 'Yes', extra: 1 })).status).toBe(400);
    expect(await current(asked.id)).toMatchObject({ version: 1, commentCount: 0 });
  });

  it('answers a retry with the same Idempotency-Key once, and refuses the key for another answer', async () => {
    const { task: asked } = await task();
    const headers = { 'idempotency-key': `respond-${crypto.randomUUID()}` };
    const first = await post(`/api/tasks/${asked.id}/respond`, { response: 'Use OAuth2' }, headers);
    const again = await post(`/api/tasks/${asked.id}/respond`, { response: 'Use OAuth2' }, headers);
    expect(again).toEqual(first);
    expect(await texts(asked.id)).toEqual(['Answered: Use OAuth2']);
    expect(await post(`/api/tasks/${asked.id}/respond`, { response: 'Use SAML' }, headers)).toMatchObject({
      status: 409,
      body: { error: 'idempotency_conflict' },
    });
  });
});

describe('POST /api/tasks/:id/dismiss', () => {
  it('closes the ask as wont-do, with the reason the person gave', async () => {
    const { task: asked } = await task();
    const dismissed = await post(`/api/tasks/${asked.id}/dismiss`, { reason: 'Not this quarter' });
    expect(dismissed.body.task).toMatchObject({
      status: 'closed',
      resolution: 'wont-do',
      closeReason: 'Dismissed: Not this quarter',
      closedBy: 'Person',
    });
    const { task: plain } = await task();
    expect((await post(`/api/tasks/${plain.id}/dismiss`, {})).body.task).toMatchObject({ closeReason: 'Dismissed' });
  });

  it('takes a reason only as long as the close reason holds after "Dismissed: "', async () => {
    const most = 2048 - 'Dismissed: '.length;
    const { task: asked } = await task();
    expect(await post(`/api/tasks/${asked.id}/dismiss`, { reason: 'x'.repeat(most + 1) })).toEqual({
      status: 400,
      body: { error: 'invalid_request', detail: `reason (at most ${most} characters; this one has ${most + 1})` },
    });
    const dismissed = await post(`/api/tasks/${asked.id}/dismiss`, { reason: 'x'.repeat(most) });
    expect((dismissed.body.task as { closeReason: string }).closeReason).toHaveLength(2048);
  });

  it('closes a duplicate ask linked to the task it duplicates, and never as done', async () => {
    const { task: first } = await engine.createTask(project.id, { title: 'First ask' }, OWNER);
    const { task: again } = await task();
    const dismissed = await post(`/api/tasks/${again.id}/dismiss`, { resolution: 'duplicate', duplicateOf: first.id });
    expect(dismissed.body.task).toMatchObject({ resolution: 'duplicate', duplicateOf: first.id });
    expect((await current(again.id)).dependencies).toMatchObject([{ taskId: first.id, type: 'related' }]);
    const { task: other } = await task();
    expect((await post(`/api/tasks/${other.id}/dismiss`, { resolution: 'done' })).status).toBe(400);
    expect((await post(`/api/tasks/${other.id}/dismiss`, { duplicateOf: first.id })).status).toBe(400);
    expect(
      (await post(`/api/tasks/${other.id}/dismiss`, { resolution: 'duplicate', duplicateOf: `${project.prefix}-none` }))
        .status,
    ).toBe(404);
    expect((await current(other.id)).status).toBe('open');
  });
});

describe('POST /api/gates/:id/resolve', () => {
  it('approves the approval, recording the person, and frees the task waiting on it', async () => {
    const { task: waiting, created } = await task({ requestApproval: { reason: 'Deploy once' } });
    const gate = created[0]!;
    expect((await current(waiting.id)).ready).toBe(false);

    const approved = await post(`/api/gates/${gate.id}/resolve`, { reason: 'Go ahead' });

    expect(approved.body.task).toMatchObject({
      id: gate.id,
      status: 'closed',
      resolution: 'done',
      closeReason: 'Go ahead',
      closedBy: 'Person',
    });
    expect((await current(waiting.id)).ready).toBe(true);
    const history = await get(target, `/api/tasks/${gate.id}/history?project=${project.id}`);
    expect((history.body.changes as { actor: string; at: string }[])[0]).toMatchObject({
      actor: 'Person',
      at: time.now(),
    });
  });

  it('refuses a task that is not an approval and an approval already closed', async () => {
    const { task: plain } = await task();
    expect((await post(`/api/gates/${plain.id}/resolve`, {})).body).toEqual({
      error: 'task_refused',
      detail: `${plain.id} is not an approval.`,
    });
    const { created } = await task({ requestApproval: { reason: 'Spend once' } });
    expect((await post(`/api/gates/${created[0]!.id}/resolve`, {})).body.task).toMatchObject({
      closeReason: 'Approved',
    });
    expect((await post(`/api/gates/${created[0]!.id}/resolve`, {})).body).toEqual({
      error: 'task_refused',
      detail: `${created[0]!.id} is already closed.`,
    });
  });
});

describe('POST /api/tasks/:id/dispute', () => {
  it('needs an approval an agent recorded', async () => {
    const { created } = await task({ requestApproval: { reason: 'Deploy once' } });
    await post(`/api/gates/${created[0]!.id}/resolve`, {});
    expect((await post(`/api/tasks/${created[0]!.id}/dispute`, {})).body).toEqual({
      error: 'task_refused',
      detail: 'dispute requires a recorded agent-relayed approval on this gate.',
    });
  });
});

describe('the read cache', () => {
  it('forgets a board once a decision changes a task on it', async () => {
    const db = storeDatabase();
    const cached = api({
      principal: PERSON,
      now: time.now,
      engine: cachedReads(createEngine(db, { now: time.now }), time.now),
    });
    const fresh = await newProject(cached.engine);
    const { task: asked } = await cached.engine.createTask(fresh.id, { title: 'Asks', labels: ['human'] }, OWNER);
    const board = async () =>
      ((await get(cached, `/api/tasks?project=${fresh.id}`)).body.tasks as { id: string; labels: string[] }[]).find(
        (entry) => entry.id === asked.id,
      );
    expect((await board())?.labels).toEqual(['human']);
    await send(cached, 'POST', `/api/tasks/${asked.id}/respond`, { projectId: fresh.id, response: 'Use OAuth2' });
    expect((await board())?.labels).toEqual([]);
  });
});
