// The HTTP routes of a person's decisions, in the shapes NoticeOS's Tasks API
// took: answering, picking, dismissing, approving, ticking the steps of a
// request to do steps, accepting a task as done, and disputing, who may send
// them, how a retry is answered, and what each refusal says. The rules of a
// pick and an answer are ported from NoticeOS's
// scripts/hosted-task-command.test.mjs (choiceSteps and answerSteps).
import { TASK_LIMITS, WORK_DETAILS, WORK_LIMITS, type Project, type Task, type TaskEngine } from '@ntasks/domain';
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

const STEPS = [
  { text: 'Back up the database.', command: 'pnpm backup' },
  { text: 'Update to the merged commit.', command: './update.sh --commit a1b2c3d4' },
  { text: 'Open the site and sign in.' },
] as const;

/** A task labelled human that waits on a request that a person do STEPS. */
async function doRequest(): Promise<{ readonly waiting: Task; readonly gate: string }> {
  const { task: waiting } = await task();
  const { created } = await engine.writeTask(
    project.id,
    waiting.id,
    {
      expectedVersion: waiting.version,
      requestAction: { title: 'Update the site', context: 'The site runs the old release.', steps: STEPS },
    },
    AGENT,
  );
  return { waiting: await current(waiting.id), gate: created[0]!.id };
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
    const steps = (await doRequest()).gate;
    const { task: work } = await engine.createTask(project.id, { title: 'Ship it', acceptance: '- Shipped.' }, OWNER);
    const shown = '0123456789abcdef0123456789abcdef';
    const service: Principal = { ...WRITER, id: 'service:x/tower', name: 'service:noticeos/tower' };
    for (const sender of [WRITER, service]) {
      const as = api({ principal: sender, now: time.now, engine });
      for (const [path, body] of [
        [`/api/tasks/${asked.id}/respond`, { response: 'A' }],
        [`/api/tasks/${asked.id}/choose`, { option: 'a' }],
        [`/api/tasks/${asked.id}/dismiss`, {}],
        [`/api/tasks/${gate.id}/dispute`, {}],
        [`/api/gates/${gate.id}/resolve`, {}],
        [`/api/gates/${steps}/steps`, { step: 1, done: true }],
        [`/api/gates/${steps}/steps`, { step: 2, stuck: 'Stopped here.' }],
        [`/api/tasks/${work.id}/accept`, { met: [], proposalVersion: shown }],
        [`/api/tasks/${work.id}/release`, {}],
      ] as const) {
        expect(await post(path, body, {}, as), path).toEqual({
          status: 403,
          body: {
            error: 'insufficient_scope',
            detail:
              'Only a person signed in to Ntasks answers a decision, approves an approval, ticks a step, accepts a task as done or frees a task on their own call, or disputes an answer relayed for them. Answer it in the Ntasks web app.',
          },
        });
      }
    }
    expect(await current(work.id)).toMatchObject({ status: 'open', close: null, version: 1 });
    expect(await current(asked.id)).toMatchObject({ status: 'open', choice: null, version: 1 });
    expect((await current(gate.id)).status).toBe('open');
    expect(await current(steps)).toMatchObject({ status: 'open', version: 1 });
    expect((await current(steps)).steps!.every((step) => step.done === null && step.stuck === null)).toBe(true);
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
      'step',
      'accept',
      'release',
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

  it('records a reply as given, never reading it as a pick of an option', async () => {
    for (const response of ['yes, your recommendation', 'Maybe the first?']) {
      const { task: decision } = await task({ type: 'decision', choices: CHOICES });
      const answered = await post(`/api/tasks/${decision.id}/respond`, { response });
      expect(answered.body.task, response).toMatchObject({
        status: 'closed',
        closeReason: 'Responded',
        choice: null,
        answer: { option: null, quote: response, recordedBy: 'Person', relayed: false },
      });
    }
  });

  it('refuses a task that waits on nobody, an approval and a reply too long for a comment', async () => {
    const { task: asked } = await task({ choices: CHOICES });
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

  it('hands back a waiting task labelled human, as an approval an agent relays does, and leaves a decision as it is', async () => {
    const { task: waiting, created } = await task({ requestApproval: { reason: 'Upload the photos once' } });
    const gate = created[0]!;
    await engine.writeTask(
      project.id,
      waiting.id,
      { expectedVersion: 1, set: { assignee: AGENT.name, status: 'blocked' } },
      AGENT,
    );
    const { task: decision } = await task({
      type: 'decision',
      choices: CHOICES,
      links: [{ direction: 'depends-on', taskId: gate.id, type: 'blocks' }],
    });

    expect((await post(`/api/gates/${gate.id}/resolve`, {})).status).toBe(200);

    expect(await current(waiting.id)).toMatchObject({ status: 'open', assignee: null, labels: ['ui'], ready: true });
    expect(await texts(waiting.id)).toEqual([
      `Owner approval recorded on ${gate.id}. Continue only within that recorded scope; other approvals are unchanged.`,
    ]);
    expect(await current(decision.id)).toMatchObject({ labels: ['human', 'ui'], commentCount: 0 });
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

describe('POST /api/gates/:id/steps', () => {
  type Step = NonNullable<Task['steps']>[number];
  const tick = (gate: string, body: Record<string, unknown>) => post(`/api/gates/${gate}/steps`, body);
  const stepsOf = (answer: { body: Record<string, unknown> }) => (answer.body.task as { steps: Step[] }).steps;

  it('records each tick with the person and the time, in any order, and frees the waiting task on the last', async () => {
    const { waiting, gate } = await doRequest();
    const { proposalVersion } = (await get(target, `/api/tasks/${gate}?project=${project.id}`)).body;
    expect(waiting.ready).toBe(false);

    const third = await tick(gate, { step: 3, done: true, proposalVersion });
    expect(third.body.task).toMatchObject({ status: 'open' });
    expect(stepsOf(third).map((step) => step.done)).toEqual([null, null, { by: 'Person', at: time.now() }]);
    time.advance(5);
    await tick(gate, { step: 1, done: true, proposalVersion });
    expect(await current(waiting.id)).toMatchObject({ ready: false, labels: ['human', 'ui'] });
    time.advance(5);
    const last = await tick(gate, { step: 2, done: true, proposalVersion });

    expect(last.body.task).toMatchObject({
      status: 'closed',
      resolution: 'done',
      closedBy: 'Person',
      closedAt: time.now(),
    });
    expect(stepsOf(last).map((step) => step.done?.at)).toEqual([
      '2026-11-06T12:05:00.000Z',
      time.now(),
      '2026-11-06T12:00:00.000Z',
    ]);
    expect(stepsOf(last).map(({ text, command }) => ({ text, command }))).toEqual(
      STEPS.map((step) => ({ text: step.text, command: 'command' in step ? step.command : null })),
    );
    expect(await current(waiting.id)).toMatchObject({ status: 'open', assignee: null, ready: true, labels: ['ui'] });
    expect(await texts(waiting.id)).toEqual([expect.stringContaining(gate)]);
    const history = (await get(target, `/api/tasks/${gate}/history?project=${project.id}`)).body.changes as {
      actor: string;
      fields: Record<string, unknown>;
    }[];
    // Newest first: the three ticks, then the agent's filing of the steps.
    expect(history.filter((change) => 'steps' in change.fields).map((change) => change.actor)).toEqual([
      'Person',
      'Person',
      'Person',
      AGENT.name,
    ]);
  });

  it('marks where the person is stuck and why, tells the waiting task, and clears the mark on a tick', async () => {
    const { waiting, gate } = await doRequest();
    await tick(gate, { step: 1, done: true });

    const stuck = await tick(gate, { step: 2, stuck: 'The host asks for a password.' });

    expect(stuck.body.task).toMatchObject({ status: 'open' });
    expect(stepsOf(stuck)[1]).toMatchObject({
      done: null,
      stuck: { reason: 'The host asks for a password.', by: 'Person', at: time.now() },
    });
    expect(await current(waiting.id)).toMatchObject({ ready: false });
    expect(await texts(waiting.id)).toEqual([expect.stringContaining('The host asks for a password.')]);
    const version = (await current(gate)).version;
    await tick(gate, { step: 2, stuck: 'The host asks for a password.' });
    expect((await current(gate)).version).toBe(version);

    const ticked = await tick(gate, { step: 2, done: true });
    expect(stepsOf(ticked)[1]).toMatchObject({ done: { by: 'Person' }, stuck: null });
    const again = await tick(gate, { step: 1, stuck: 'The backup failed after all.' });
    expect(stepsOf(again)[0]).toMatchObject({ done: null, stuck: { reason: 'The backup failed after all.' } });
    expect(again.body.task).toMatchObject({ status: 'open' });
  });

  it('keeps a note on a step with who left it, takes it off, and unticks a step', async () => {
    const { gate } = await doRequest();
    const noted = await tick(gate, { step: 3, done: true, note: 'Signed in as the demo visitor.' });
    expect(stepsOf(noted)[2]).toMatchObject({
      done: { by: 'Person' },
      note: { text: 'Signed in as the demo visitor.', by: 'Person', at: time.now() },
    });
    const cleared = await tick(gate, { step: 3, done: false, note: null });
    expect(stepsOf(cleared)[2]).toMatchObject({ done: null, note: null });
    expect(cleared.body.task).toMatchObject({ status: 'open' });
  });

  it('refuses an approval of the request, a step it does not have and a closed request, writing nothing', async () => {
    const { gate } = await doRequest();
    expect(await post(`/api/gates/${gate}/resolve`, {})).toMatchObject({
      status: 409,
      body: { error: 'task_refused' },
    });
    expect(await tick(gate, { step: 4, done: true })).toMatchObject({ status: 400, body: { field: 'step' } });
    expect((await tick(gate, { step: 1 })).status).toBe(400);
    expect((await tick(gate, { step: 1, done: true, stuck: 'Both.' })).status).toBe(400);
    expect(await current(gate)).toMatchObject({ status: 'open', version: 1 });

    const { created } = await task({ requestApproval: { reason: 'Deploy once' } });
    expect(await tick(created[0]!.id, { step: 1, done: true })).toMatchObject({ status: 409 });
    for (const step of [1, 2, 3]) await tick(gate, { step, done: true });
    expect(await tick(gate, { step: 1, done: false })).toEqual({
      status: 409,
      body: { error: 'task_refused', detail: `${gate} is already closed.` },
    });
  });
});

describe('POST /api/tasks/:id/accept', () => {
  const CRITERIA =
    '- Contributions are live.\n- An accountant confirms the tax\n  treatment.\n- The docs say how to give.';
  const shownOn = async (id: string) =>
    (await get(target, `/api/tasks/${id}?project=${project.id}`)).body.proposalVersion as string;
  const accept = async (id: string, body: Record<string, unknown>) =>
    post(`/api/tasks/${id}/accept`, { proposalVersion: await shownOn(id), ...body });

  it('closes the task as done by the person, whoever holds it, each criterion met or waived, with their reason', async () => {
    const { task: work } = await engine.createTask(
      project.id,
      { title: 'Take contributions', acceptance: CRITERIA, claim: true },
      AGENT,
    );

    const accepted = await accept(work.id, { met: [3, 1], reason: 'I accept the tax risk.' });

    expect(accepted.status).toBe(200);
    expect(accepted.body.task).toMatchObject({
      status: 'closed',
      resolution: 'done',
      closedBy: 'Person',
      closeReason: 'I accept the tax risk.',
      proof: null,
      closeAcceptance: {
        by: 'Person',
        criteria: [
          { text: 'Contributions are live.', met: true },
          { text: 'An accountant confirms the tax treatment.', met: false },
          { text: 'The docs say how to give.', met: true },
        ],
      },
    });
    const { closeAcceptance } = accepted.body.task as { closeAcceptance: Record<string, unknown> };
    expect(closeAcceptance).not.toHaveProperty('relayed');
    const [closed] = await engine.listHistory(project.id, work.id, { limit: 1 });
    expect(closed).toMatchObject({
      kind: 'closed',
      actor: 'Person',
      changes: { close: { resolution: 'done', acceptance: closeAcceptance } },
    });
  });

  it('closes with its own reason when the person gives none, and with no criteria on a task that has none', async () => {
    const { task: work } = await engine.createTask(project.id, { title: 'Tidy the page' }, OWNER);
    const accepted = await accept(work.id, { met: [] });
    expect(accepted.body.task).toMatchObject({
      closeReason: 'Accepted as done',
      closeAcceptance: { by: 'Person', criteria: [] },
    });
  });

  it('is cleared by a reopen, whose history keeps it', async () => {
    const { task: work } = await engine.createTask(project.id, { title: 'Ship it', acceptance: '- Shipped.' }, OWNER);
    await accept(work.id, { met: [] });
    const reopened = await send(target, 'PATCH', `/api/tasks/${work.id}`, { projectId: project.id, status: 'open' });
    expect(reopened.body.task).toMatchObject({ status: 'open', closeAcceptance: null, resolution: null });
    const history = await engine.listHistory(project.id, work.id, { limit: 2 });
    expect(history.map((event) => event.kind)).toEqual(['reopened', 'closed']);
    expect(history[1]!.changes.close).toMatchObject({ acceptance: { criteria: [{ text: 'Shipped.', met: false }] } });
  });

  it('refuses a criterion the task lacks, an unread or stale proposal, a closed task, a request and a task waiting on one, writing nothing', async () => {
    const { task: work } = await engine.createTask(project.id, { title: 'Ship it', acceptance: CRITERIA }, OWNER);
    const shown = await shownOn(work.id);
    expect(await accept(work.id, { met: [4] })).toMatchObject({
      status: 400,
      body: { error: 'invalid_request', field: 'met' },
    });
    for (const met of [[0], [1, 1], '1'])
      expect(await accept(work.id, { met }), JSON.stringify(met)).toMatchObject({ status: 400 });
    expect(await post(`/api/tasks/${work.id}/accept`, { met: [] })).toMatchObject({
      status: 400,
      body: { field: 'proposalVersion' },
    });
    await engine.writeTask(
      project.id,
      work.id,
      { expectedVersion: 1, set: { acceptance: '- Something else.' } },
      OWNER,
    );
    expect(await post(`/api/tasks/${work.id}/accept`, { met: [], proposalVersion: shown })).toMatchObject({
      status: 409,
      body: { field: 'proposalVersion' },
    });
    expect(await current(work.id)).toMatchObject({ status: 'open', close: null, version: 2 });

    const { task: done } = await engine.createTask(project.id, { title: 'Done', close: { reason: 'Shipped' } }, OWNER);
    const { task: waiting, created } = await task({ requestApproval: { reason: 'Deploy once' } });
    for (const id of [done.id, created[0]!.id, waiting.id])
      expect(await accept(id, { met: [] }), id).toMatchObject({ status: 409, body: { error: 'task_refused' } });
    expect(await current(waiting.id)).toMatchObject({ status: 'open', close: null });
    expect(await current(created[0]!.id)).toMatchObject({ status: 'open', close: null });
  });
});

describe('POST /api/tasks/:id/release', () => {
  /** A task AGENT claimed, with work details and a comment, then left. */
  async function left(status: 'in_progress' | 'blocked' = 'in_progress') {
    const { task: made } = await engine.createTask(project.id, { title: 'Rebuild the home page' }, OWNER);
    await engine.writeTask(
      project.id,
      made.id,
      {
        expectedVersion: 1,
        set: {
          assignee: AGENT.name,
          status,
          assigneeFor: 'page-rebuild-2',
          work: { branch: 'agent-a/home', pr: 'https://example.com/pull/7', next: 'Write the hero copy' },
        },
      },
      AGENT,
    );
    await engine.addComment(project.id, made.id, 'Found the old layout\nin the theme.', AGENT);
    return current(made.id);
  }

  it('frees a task on the person’s call, keeping who held it and where the work stopped in a comment', async () => {
    const held = await left();
    time.advance(5);

    const freed = await post(`/api/tasks/${held.id}/release`, {});

    expect(freed.status).toBe(200);
    expect(await current(held.id)).toMatchObject({ status: 'open', assignee: null, assigneeFor: null, work: {} });
    const comment = (await texts(held.id)).find((text) =>
      text.startsWith(`Person freed ${held.id} on their own call.`),
    );
    expect(comment).toBeDefined();
    for (const line of [
      `- Held by: ${AGENT.name} for page-rebuild-2`,
      `- Last activity: ${held.lastActivityAt}`,
      '- Next step: Write the hero copy',
      '- Branch: agent-a/home',
      '- Pull request: https://example.com/pull/7',
      'Found the old layout in the theme.',
    ])
      expect(comment).toContain(line);
    const [event] = (await engine.listHistory(project.id, held.id, { limit: 5 })).filter(
      (entry) => entry.kind !== 'commented',
    );
    expect(event).toMatchObject({ actor: 'Person', changes: { assignee: null, status: 'open' } });
  });

  it('frees a task whose holder left work details as long as they may be, cutting each to fit one comment', async () => {
    const { task: made } = await engine.createTask(project.id, { title: 'Rebuild the pricing page' }, OWNER);
    const long = (detail: keyof typeof WORK_LIMITS) =>
      detail === 'pr' ? `https://example.com/${'p'.repeat(WORK_LIMITS.pr - 20)}` : 'w'.repeat(WORK_LIMITS[detail]);
    await engine.writeTask(
      project.id,
      made.id,
      {
        expectedVersion: 1,
        set: {
          assignee: AGENT.name,
          status: 'in_progress',
          work: Object.fromEntries(WORK_DETAILS.map((detail) => [detail, long(detail)])),
        },
      },
      AGENT,
    );

    const freed = await post(`/api/tasks/${made.id}/release`, {});

    expect(freed.status).toBe(200);
    const comment = (await texts(made.id)).find((text) => text.includes('on their own call'))!;
    expect(comment.length).toBeLessThanOrEqual(TASK_LIMITS.comment);
    expect(comment).toContain(`- Pull request: https://example.com/`);
    // The task's history keeps each detail whole.
    const history = await engine.listHistory(project.id, made.id, { limit: 10 });
    expect(JSON.stringify(history)).toContain(long('session'));
  });

  it('keeps a blocked task’s status, and refuses a task nobody holds and a closed one, writing nothing', async () => {
    const blocked = await left('blocked');
    await post(`/api/tasks/${blocked.id}/release`, {});
    expect(await current(blocked.id)).toMatchObject({ status: 'blocked', assignee: null });

    const { task: free } = await engine.createTask(project.id, { title: 'Nobody holds this' }, OWNER);
    const { task: done } = await engine.createTask(project.id, { title: 'Done', close: { reason: 'Shipped' } }, OWNER);
    for (const id of [free.id, done.id]) {
      expect(await post(`/api/tasks/${id}/release`, {}), id).toMatchObject({
        status: 409,
        body: { error: 'task_refused' },
      });
      expect((await current(id)).version, id).toBe(1);
    }
  });
});

describe('POST /api/tasks/:id/dispute', () => {
  it('needs an approval or an acceptance an agent recorded', async () => {
    const { task: work } = await engine.createTask(project.id, { title: 'Ship it' }, OWNER);
    const shown = (await get(target, `/api/tasks/${work.id}?project=${project.id}`)).body.proposalVersion as string;
    await post(`/api/tasks/${work.id}/accept`, { met: [], proposalVersion: shown });
    expect(await post(`/api/tasks/${work.id}/dispute`, {})).toMatchObject({
      status: 409,
      body: { error: 'task_refused' },
    });
    expect((await current(work.id)).status).toBe('closed');
  });

  it('needs an approval an agent recorded', async () => {
    const { created } = await task({ requestApproval: { reason: 'Deploy once' } });
    await post(`/api/gates/${created[0]!.id}/resolve`, {});
    expect(await post(`/api/tasks/${created[0]!.id}/dispute`, {})).toMatchObject({
      status: 409,
      body: { error: 'task_refused' },
    });
    expect((await current(created[0]!.id)).status).toBe('closed');
  });
});

describe('the proposal version a person answers', () => {
  const detail = async (id: string) => (await get(target, `/api/tasks/${id}?project=${project.id}`)).body;

  it('is on the task read, and on a board task while it waits on a person', async () => {
    const { task: asked } = await task({ choices: CHOICES });
    const { task: plain } = await engine.createTask(project.id, { title: 'Nobody asked' }, OWNER);
    const read = await detail(asked.id);
    expect(read.proposalVersion).toMatch(/^[0-9a-f]{32}$/u);
    expect((await detail(plain.id)).proposalVersion).toMatch(/^[0-9a-f]{32}$/u);
    const board = (await get(target, `/api/tasks?project=${project.id}`)).body.tasks as {
      id: string;
      proposalVersion: string | null;
    }[];
    expect(board.find((row) => row.id === asked.id)?.proposalVersion).toBe(read.proposalVersion);
    expect(board.find((row) => row.id === plain.id)?.proposalVersion).toBeNull();
  });

  it('records an answer with the version its page showed, and refuses one whose proposal changed since, writing nothing', async () => {
    const { task: asked } = await task({ choices: CHOICES });
    const shown = (await detail(asked.id)).proposalVersion as string;
    await engine.writeTask(project.id, asked.id, { expectedVersion: 1, set: { title: 'Asks a person again' } }, OWNER);
    const before = await current(asked.id);

    const stale = await post(`/api/tasks/${asked.id}/choose`, { option: 'b', proposalVersion: shown });

    expect(stale).toMatchObject({ status: 409, body: { error: 'task_refused', field: 'proposalVersion' } });
    expect(await current(asked.id)).toEqual(before);
    const fresh = (await detail(asked.id)).proposalVersion as string;
    const picked = await post(`/api/tasks/${asked.id}/choose`, { option: 'b', proposalVersion: fresh });
    expect(picked.body.task).toMatchObject({
      choice: { option: 'b' },
      answer: { option: 'b', quote: null, source: null, recordedBy: 'Person', relayed: false, proposalVersion: fresh },
    });
  });

  it('refuses a version that is not 32 hexadecimal characters, such as one of 12, writing nothing', async () => {
    const { task: asked } = await task();
    const shown = (await detail(asked.id)).proposalVersion as string;
    for (const proposalVersion of ['x', shown.slice(0, 12)]) {
      const refused = await post(`/api/tasks/${asked.id}/respond`, { response: 'Yes', proposalVersion });
      expect(refused, proposalVersion).toMatchObject({
        status: 400,
        body: { error: 'invalid_request', field: 'proposalVersion' },
      });
    }
    expect(await current(asked.id)).toMatchObject({ version: 1, commentCount: 0 });
  });

  it('records an approval with the version its page showed', async () => {
    const { created } = await task({ requestApproval: { reason: 'Deploy once' } });
    const gate = created[0]!;
    const shown = (await detail(gate.id)).proposalVersion as string;
    const approved = await post(`/api/gates/${gate.id}/resolve`, { proposalVersion: shown });
    expect(approved.body.task).toMatchObject({
      status: 'closed',
      answer: { option: 'approve', relayed: false, proposalVersion: shown },
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
