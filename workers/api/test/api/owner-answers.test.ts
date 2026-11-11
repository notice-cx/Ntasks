// The owner answers an agent records with reconcile_task, and the maintenance
// it does with evidence: what counts as the owner's authority. An answer is
// recorded as the option the agent names on the proposal version the owner
// saw, with the owner's words as a quote; nothing reads the quote.
import { TASK_LIMITS, type Project, type Task, type TaskComment, type TaskEngine } from '@ntasks/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { SCOPES, type Principal } from '../../src/auth.ts';
import { disputeWrite, MAINTENANCE } from '../../src/owner-answers.ts';
import { clock, newProject, OWNER as ENGINE_OWNER } from '../engine/helpers.ts';
import { api, callTool, get, read, send, WORKSPACE, type TestApi } from './helpers.ts';

/** The person the agent acts for, as their own writes are recorded. */
const OWNER = 'Owner';
/** An agent acting for the owner. */
const AGENT: Principal = Object.freeze({
  id: 'principal-claude',
  name: 'agent:claude',
  scopes: [SCOPES.read, SCOPES.write],
  projects: 'all',
  person: OWNER,
});
/** The owner, signed in to the web app. */
const PERSON: Principal = Object.freeze({
  id: 'person:owner',
  name: OWNER,
  scopes: [SCOPES.read, SCOPES.write, SCOPES.backup, SCOPES.decide],
  projects: 'all',
  person: OWNER,
});

const time = clock('2026-11-06T12:00:00.000Z');
let agent: TestApi;
let person: TestApi;
let engine: TaskEngine;

beforeAll(() => {
  agent = api({ principal: AGENT, now: time.now });
  engine = agent.engine;
  person = api({ principal: PERSON, now: time.now, engine });
});

const key = () => `key-${crypto.randomUUID()}`;

const choices = {
  question: 'Which local layout should we build?',
  options: [
    { key: 'a', label: 'Compact layout', detail: 'Build the compact local layout.', recommended: true },
    { key: 'b', label: 'Wide layout' },
  ],
} as const;

interface McpTask {
  readonly id: string;
  readonly status: string;
  readonly assignee: string | null;
  readonly labels: string[];
  readonly ready: boolean;
  readonly awaitingHuman: boolean;
  readonly resolution: string | null;
  readonly closeReason: string | null;
  readonly closeAcceptance: Record<string, unknown> | null;
  readonly choice: { option: string; by: string } | null;
  readonly answer: Record<string, unknown> | null;
  readonly metadata: { noticeos_maintenance?: Record<string, unknown> & { events?: Record<string, unknown>[] } };
}

async function make(project: Project, title: string, input: Partial<Parameters<TaskEngine['createTask']>[1]> = {}) {
  const { task, created } = await engine.createTask(project.id, { title, ...input }, ENGINE_OWNER);
  return { task, gate: created[0] };
}

async function current(project: Project, id: string): Promise<Task> {
  return (await engine.getTask(project.id, id))!;
}

async function comments(project: Project, id: string): Promise<readonly TaskComment[]> {
  return engine.listComments(project.id, id);
}

async function versionOf(project: Project, task: string, as = agent): Promise<string> {
  return (await read<{ proposalVersion: string }>(as, 'get_task', { project: project.id, task })).proposalVersion;
}

/** reconcile_task on the task's proposal as get_task shows it now; `fields` adds to or replaces the arguments. */
async function reconcile(project: Project, task: string, fields: Record<string, unknown>, as = agent) {
  return callTool<{ task: McpTask; replayed: boolean }>(as, 'reconcile_task', {
    workspace: WORKSPACE.id,
    project: project.id,
    task,
    proposal_version: await versionOf(project, task, as),
    idempotency_key: key(),
    detail: 'full',
    ...fields,
  });
}

async function answered(project: Project, task: string, fields: Record<string, unknown>, as = agent): Promise<McpTask> {
  const result = await reconcile(project, task, fields, as);
  if (result.refused !== null) throw new Error(`refused: ${result.refused}`);
  return result.value.task;
}

async function refusedWith(project: Project, task: string, fields: Record<string, unknown>): Promise<string> {
  const result = await reconcile(project, task, fields);
  if (result.refused === null) throw new Error(`answered: ${JSON.stringify(result.value)}`);
  return result.refused;
}

/** Maintenance with evidence. */
const EVIDENCE = {
  explanation: 'The recorded evidence resolves this request.',
  evidence: 'commit abc1234 and the referenced owner source',
};

/** An answer the owner gave in a local session, relayed by the agent. */
const RELAY = { action: 'answer', source: 'claude-code:session/synthetic-session' };

const SCOPE = 'Upload 12 new photos to production bucket example-images; add files only and read one back';

async function relayGate() {
  const project = await newProject(engine);
  const { task: photos, gate } = await make(project, 'Upload the photos', {
    labels: ['human'],
    requestApproval: { reason: SCOPE },
  });
  return { project, photos, gate: gate! };
}

describe('an owner answer an agent relays', () => {
  it('closes an approval that names its own gate, showing the quote, the source, the recorder and the version it answered', async () => {
    const { project, photos, gate } = await relayGate();
    const proposalVersion = await versionOf(project, gate.id);
    const quote = `Approve ${gate.id}`;

    const done = await answered(project, gate.id, { ...RELAY, quote });

    const answer = {
      option: 'approve',
      quote,
      source: RELAY.source,
      recordedBy: AGENT.name,
      relayed: true,
      proposalVersion,
      disputedBy: null,
    };
    expect(done).toMatchObject({ status: 'closed', resolution: 'done', awaitingHuman: false, answer });
    expect((await get(person, `/api/tasks/${gate.id}?project=${project.id}`)).body.task).toMatchObject({ answer });
    expect((await current(project, photos.id)).labels).toEqual([]);
    const closed = await callTool(agent, 'close_task', {
      workspace: WORKSPACE.id,
      project: project.id,
      task: photos.id,
      reason: 'Implemented in abc1234',
      idempotency_key: key(),
    });
    expect(closed.refused).toBeNull();
  });

  it('records the option the agent names and the quote as given, whatever the quote says', async () => {
    for (const quote of ['Maybe B? Fine, B.', 'not sure, but B', 'A']) {
      const project = await newProject(engine);
      const { task } = await make(project, 'Build the layout', { labels: ['human'], choices });
      await engine.writeTask(
        project.id,
        task.id,
        { expectedVersion: 1, set: { assignee: 'abandoned-agent', status: 'in_progress' } },
        { name: 'abandoned-agent' },
      );

      const done = await answered(project, task.id, { ...RELAY, option: 'b', quote });

      expect(done, quote).toMatchObject({
        status: 'open',
        assignee: null,
        labels: [],
        awaitingHuman: false,
        choice: { option: 'b', by: OWNER },
        answer: { option: 'b', quote, relayed: true },
      });
      expect((await current(project, task.id)).close, 'answering is not implementation completion').toBeNull();
    }
  });

  it('hands a task back without a pick when the owner chose none of its options', async () => {
    const project = await newProject(engine);
    const { task } = await make(project, 'Build the layout', { labels: ['human'], choices });
    const quote = 'Use a two-column layout with the summary first';
    const done = await answered(project, task.id, { ...RELAY, quote });
    expect(done).toMatchObject({ status: 'open', labels: [], choice: null, answer: { option: null, quote } });
  });

  it('leaves a decision open for its implementation evidence and keeps unrelated blockers', async () => {
    const project = await newProject(engine);
    const { task: decision } = await make(project, 'Pick the layout', { type: 'decision', labels: ['human'], choices });
    const { task: blocker } = await make(project, 'Prepare the data');
    const { task: work } = await make(project, 'Build the layout', {
      labels: ['human'],
      choices,
      links: [{ direction: 'depends-on', taskId: blocker.id, type: 'blocks' }],
    });

    const decided = await answered(project, decision.id, { ...RELAY, option: 'a', quote: 'A' });
    expect(decided).toMatchObject({ status: 'open', awaitingHuman: false });
    const built = await answered(project, work.id, { ...RELAY, option: 'a', quote: 'A' });
    expect(built).toMatchObject({ awaitingHuman: false, ready: false });
    expect((await current(project, work.id)).dependencies.map((link) => link.taskId)).toEqual([blocker.id]);
  });

  it('refuses an answer to a proposal that changed after the owner saw it, writing nothing', async () => {
    const project = await newProject(engine);
    const { task } = await make(project, 'Build the layout', { labels: ['human'], choices });
    const seen = await versionOf(project, task.id);
    await engine.writeTask(
      project.id,
      task.id,
      { expectedVersion: 1, set: { title: 'Changed proposal' } },
      ENGINE_OWNER,
    );
    const before = await current(project, task.id);

    const refused = await reconcile(project, task.id, { ...RELAY, option: 'a', quote: 'A', proposal_version: seen });

    expect(refused.refused).toMatch(/^refused: proposal_version: /u);
    expect(refused.refusal?.retry, 'the refusal says nothing was written').toBe('safe');
    expect(await current(project, task.id)).toEqual(before);
    expect(await comments(project, task.id)).toEqual([]);
  });

  it('names the argument at fault in every refusal, and says nothing was written', async () => {
    const project = await newProject(engine);
    const { task: asked } = await make(project, 'Build the layout', { labels: ['human'], choices });
    const { task: plain } = await make(project, 'Answer a question', { labels: ['human'] });
    const { task: nobody } = await make(project, 'Nobody asked');
    const { gate } = await make(project, 'Deploy', { requestApproval: { reason: 'Deploy once' } });
    const cases: readonly [string, string, Record<string, unknown>][] = [
      ['quote', asked.id, { option: 'a' }],
      ['source', asked.id, { option: 'a', quote: 'A', source: undefined }],
      ['option', asked.id, { option: 'c', quote: 'C' }],
      ['option', plain.id, { option: 'a', quote: 'A' }],
      ['option', gate!.id, { option: 'a', quote: 'Yes' }],
      ['option', gate!.id, { action: 'declined', option: 'a', quote: 'No' }],
      ['action', asked.id, { action: 'declined', quote: 'No' }],
      ['action', asked.id, { action: 'owner_performed', quote: 'I did it' }],
      ['task', nobody.id, { quote: 'Yes' }],
      ['proposal_version', asked.id, { option: 'a', quote: 'A', proposal_version: 'not-a-version' }],
      // A version of 12 hexadecimal characters, which a crafted pair of proposals could share.
      ['proposal_version', asked.id, { option: 'a', quote: 'A', proposal_version: '0123456789ab' }],
    ];
    for (const [field, id, fields] of cases) {
      const before = await current(project, id);
      const refused = await reconcile(project, id, { ...RELAY, ...fields });
      expect(refused.refused, JSON.stringify(fields)).toMatch(
        new RegExp(`^(?:refused|invalid arguments): ${field}\\b`, 'u'),
      );
      expect(refused.refusal?.retry, 'the refusal says nothing was written').toBe('safe');
      expect(await current(project, id)).toEqual(before);
    }
    expect(await comments(project, asked.id)).toEqual([]);
  });

  it('answers briefly unless asked for the whole task, with the answer it recorded', async () => {
    const project = await newProject(engine);
    const { task } = await make(project, 'Build the layout', { labels: ['human'], choices });
    const brief = await reconcile(project, task.id, { ...RELAY, option: 'b', quote: 'B', detail: undefined });
    expect(brief.value).toEqual({
      id: task.id,
      status: 'open',
      assignee: null,
      resolution: null,
      awaitingHuman: false,
      answer: expect.objectContaining({ option: 'b', quote: 'B', relayed: true }),
      version: (await current(project, task.id)).version,
      replayed: false,
    });
  });

  it('answers a retry with the same key once', async () => {
    const project = await newProject(engine);
    const { task } = await make(project, 'Build the layout', { labels: ['human'], choices });
    const fields = { ...RELAY, option: 'a', quote: 'A', idempotency_key: 'relayed-answer-retry-0001' };
    const first = await reconcile(project, task.id, fields);
    const again = await reconcile(project, task.id, fields);
    expect(first.value).toMatchObject({ replayed: false, task: { awaitingHuman: false, choice: { option: 'a' } } });
    expect(again.value).toMatchObject({ replayed: true, task: { awaitingHuman: false, choice: { option: 'a' } } });
    expect(await comments(project, task.id)).toHaveLength(1);
  });
});

describe('maintenance with evidence', () => {
  it('closes completed and obsolete requests with evidence and returns routine work to agents', async () => {
    for (const action of ['completed', 'obsolete', 'superseded', 'routine']) {
      const project = await newProject(engine);
      const { task } = await make(project, 'An old ask', { labels: ['human'] });
      const done = await answered(project, task.id, { action, ...EVIDENCE });
      expect(done.status).toBe(action === 'routine' ? 'open' : 'closed');
      expect(done.resolution).toBe(
        action === 'routine' ? null : action === 'completed' ? 'already-handled' : 'no-longer-needed',
      );
      expect(done.metadata.noticeos_maintenance!.permission).toBe('none');
      expect((await comments(project, task.id))[0]!.text).toMatch(/Evidence: commit abc1234/u);
      if (action === 'routine') expect(done.labels).toEqual([]);
    }
    const project = await newProject(engine);
    const { task } = await make(project, 'A business decision', { labels: ['human'], type: 'decision' });
    const refused = await refusedWith(project, task.id, { action: 'completed', ...EVIDENCE });
    expect(refused, 'implementation evidence cannot approve a business decision').toMatch(/business decision/u);
  });

  it('retires a production approval without granting it, and leaves the remaining work available', async () => {
    const project = await newProject(engine);
    const { task: prod, gate } = await make(project, 'Check production', {
      labels: ['human'],
      requestApproval: { reason: 'Read production logs once' },
    });
    for (const action of ['routine', 'completed', 'release']) {
      const fields =
        action === 'release'
          ? { holder: 'old-agent', inactive: true, activity_check: 'No active session', progress: 'No change' }
          : {};
      await refusedWith(project, gate!.id, { action, ...EVIDENCE, ...fields });
    }
    const retired = await answered(project, gate!.id, { action: 'obsolete', ...EVIDENCE });
    expect(retired.metadata.noticeos_maintenance!.permission).toBe('none');
    expect(retired.resolution).toBe('no-longer-needed');
    const after = await current(project, prod.id);
    expect(after.status).toBe('open');
    expect((await comments(project, prod.id)).some((comment) => /No permission granted/u.test(comment.text))).toBe(
      true,
    );
  });

  it('releases an assignment only with checked inactivity, keeps its progress, and loses to a new holder', async () => {
    const project = await newProject(engine);
    const { task } = await make(project, 'Held work', { labels: ['human'] });
    await engine.writeTask(
      project.id,
      task.id,
      { expectedVersion: 1, set: { assignee: 'old-agent', status: 'in_progress' } },
      { name: 'old-agent' },
    );
    const fields = {
      action: 'release',
      ...EVIDENCE,
      holder: 'old-agent',
      activity_check: 'Agent registry has no live session for this holder.',
      progress: 'Commit abc1234 is ready for review.',
    };
    expect(await refusedWith(project, task.id, fields)).toMatch(/requires inactive: true/u);
    expect(await refusedWith(project, task.id, { ...fields, inactive: true, holder: 'different-agent' })).toMatch(
      /The assignment changed/u,
    );

    // Another agent takes the task between this call's read and its write.
    let raced = false;
    const racing = api({
      principal: AGENT,
      now: time.now,
      engine,
      wrap: (inner) => ({
        ...inner,
        async writeTask(projectId, taskId, write, actor, retry) {
          if (!raced) {
            raced = true;
            const now = (await inner.getTask(projectId, taskId))!;
            await inner.writeTask(
              projectId,
              taskId,
              { expectedVersion: now.version, set: { assignee: null } },
              { name: 'old-agent' },
            );
            await inner.writeTask(
              projectId,
              taskId,
              { expectedVersion: now.version + 1, set: { assignee: 'new-agent' } },
              { name: 'new-agent' },
            );
          }
          return inner.writeTask(projectId, taskId, write, actor, retry);
        },
      }),
    });
    const lost = await reconcile(project, task.id, { ...fields, inactive: true }, racing);
    expect(lost.refused).toMatch(/The assignment changed/u);
    expect((await current(project, task.id)).assignee).toBe('new-agent');

    const back = await current(project, task.id);
    await engine.writeTask(
      project.id,
      task.id,
      { expectedVersion: back.version, set: { assignee: 'old-agent' } },
      ENGINE_OWNER,
    );
    const released = await answered(project, task.id, { ...fields, inactive: true });
    expect(released).toMatchObject({ status: 'open', assignee: null, labels: ['human'] });
    expect(
      (await comments(project, task.id)).some((comment) => /Progress preserved: Commit abc1234/u.test(comment.text)),
    ).toBe(true);
  });

  it('releases a dormant assignment and keeps blocked and deferred work as it was', async () => {
    for (const status of ['blocked', 'deferred'] as const) {
      const project = await newProject(engine);
      const { task } = await make(project, 'Dormant');
      await engine.writeTask(
        project.id,
        task.id,
        { expectedVersion: 1, set: { assignee: 'old-agent', status } },
        ENGINE_OWNER,
      );
      const released = await answered(project, task.id, {
        action: 'release',
        ...EVIDENCE,
        holder: 'old-agent',
        inactive: true,
        activity_check: 'Registry confirms the holder stopped.',
        progress: 'Local patch retained at abc1234.',
      });
      expect(released).toMatchObject({ status, assignee: null });
    }
  });
});

describe('approvals', () => {
  const scope = 'Read production logs once; no writes';

  it('declines one approval as wont-do, tells the task waiting on it, and keeps its other approval blocking', async () => {
    const project = await newProject(engine);
    const { task: work, gate } = await make(project, 'Work', { labels: ['human'], requestApproval: { reason: scope } });
    await callTool(agent, 'request_human_approval', {
      workspace: WORKSPACE.id,
      project: project.id,
      task: work.id,
      reason: 'Deploy once',
    });
    const other = (await current(project, work.id)).dependencies.find((link) => link.taskId !== gate!.id)!;

    const declined = await answered(project, gate!.id, { ...RELAY, action: 'declined', quote: 'No' });

    expect(declined).toMatchObject({ status: 'closed', resolution: 'wont-do', answer: { option: 'decline' } });
    expect(declined.metadata.noticeos_maintenance).toMatchObject({ permission: 'none', outcome: 'declined' });
    expect((await current(project, work.id)).labels).toEqual([]);
    const told = await comments(project, work.id);
    expect(told.some((comment) => comment.text.includes(scope))).toBe(true);
    const refusal = await callTool(agent, 'close_task', {
      workspace: WORKSPACE.id,
      project: project.id,
      task: work.id,
      reason: 'Implemented in abc1234',
      idempotency_key: key(),
    });
    expect(refusal.refused).toMatch(new RegExp(`${other.taskId}.*reconcile_task`, 'u'));
    expect((await current(project, other.taskId)).status).toBe('open');
  });

  it('lets a claimed decision be answered after its approval is declined, then closed with implementation evidence', async () => {
    const project = await newProject(engine);
    const { task: decision, gate } = await make(project, 'Pick the layout', {
      type: 'decision',
      labels: ['human'],
      choices,
      requestApproval: { reason: 'Read production speed once; no writes' },
    });
    await callTool(agent, 'claim_task', {
      workspace: WORKSPACE.id,
      project: project.id,
      task: decision.id,
      idempotency_key: key(),
    });
    const early = await callTool(agent, 'close_task', {
      workspace: WORKSPACE.id,
      project: project.id,
      task: decision.id,
      reason: 'Built in abc1234',
      idempotency_key: key(),
    });
    expect(early.refused).toMatch(/reconcile_task/u);

    const declined = await answered(project, gate!.id, {
      ...RELAY,
      action: 'declined',
      quote: 'Skip the production speed check. Commit now and note that it was not run.',
    });
    expect(declined).toMatchObject({ status: 'closed', resolution: 'wont-do' });
    expect((await current(project, decision.id)).status).toBe('in_progress');

    const picked = await answered(project, decision.id, { ...RELAY, option: 'a', quote: 'A' });
    expect(picked).toMatchObject({ status: 'open', choice: { option: 'a' } });
    const closed = await callTool<{ task: McpTask }>(agent, 'close_task', {
      workspace: WORKSPACE.id,
      project: project.id,
      task: decision.id,
      reason: 'Implemented in abc1234; declined production check was not run.',
      idempotency_key: key(),
      detail: 'full',
    });
    expect(closed.value?.task.closeReason).toMatch(/abc1234/u);
  });

  it('retires a duplicate only for the same full scope, moving the task waiting on it to the survivor', async () => {
    const project = await newProject(engine);
    const { task: prod, gate: old } = await make(project, 'Production read', {
      requestApproval: { reason: 'One bounded production read' },
    });
    const { gate: other } = await make(project, 'Deploy', { requestApproval: { reason: 'Deploy the app' } });
    expect(await refusedWith(project, old!.id, { action: 'duplicate', ...EVIDENCE, duplicate_of: other!.id })).toMatch(
      /same requested scope/u,
    );
    // The same words gating another pull request ask for another merge.
    const { gate: elsewhere } = await make(project, 'Production read elsewhere', {
      requestApproval: { reason: 'One bounded production read', pullRequest: 'https://github.com/example/site/pull/9' },
    });
    expect(
      await refusedWith(project, old!.id, { action: 'duplicate', ...EVIDENCE, duplicate_of: elsewhere!.id }),
    ).toMatch(/same requested scope/u);
    const { gate: survivor } = await make(project, 'Production read again', {
      requestApproval: { reason: 'One bounded production read' },
    });

    const retired = await answered(project, old!.id, { action: 'duplicate', ...EVIDENCE, duplicate_of: survivor!.id });
    expect(retired).toMatchObject({ status: 'closed', resolution: 'duplicate' });
    expect((await current(project, survivor!.id)).status).toBe('open');
    const waiting = await current(project, prod.id);
    expect(waiting.dependencies.find((link) => link.taskId === survivor!.id)?.type).toBe('blocks');
    expect(waiting.ready).toBe(false);
  });

  it('tells and hands back every task waiting on it, more than a page of them, in one write', async () => {
    const project = await newProject(engine);
    const { task: first, gate } = await make(project, 'Waits 0', {
      labels: ['human'],
      requestApproval: { reason: scope },
    });
    const waiting = [first];
    for (let i = 1; i < 205; i += 1) {
      const { task } = await make(project, `Waits ${i}`, {
        labels: ['human'],
        links: [{ direction: 'depends-on', taskId: gate!.id, type: 'blocks' }],
      });
      waiting.push(task);
    }

    const done = await answered(project, gate!.id, { ...RELAY, quote: 'yes' });

    expect(done.status).toBe('closed');
    expect(done.metadata.noticeos_maintenance).toMatchObject({ permission: 'approved-scope-only' });
    const after = await engine.listBoard(project.id, { statuses: ['open'] });
    expect(after.map((task) => task.id).sort()).toEqual(waiting.map((task) => task.id).sort());
    expect(after.every((task) => task.labels.length === 0 && task.ready && task.commentCount === 1)).toBe(true);
  }, 60_000);

  it('refuses, naming the limit, a decision that would change more tasks than one write takes', async () => {
    const project = await newProject(engine);
    const { task, gate } = await make(project, 'Waits', { labels: ['human'], requestApproval: { reason: scope } });
    const relayed = {
      ...gate!,
      metadata: { [MAINTENANCE]: { verification: 'agent-recorded', approved: true, by: AGENT.name, source: 'x' } },
    };
    const many = Array.from({ length: TASK_LIMITS.others + 1 }, (_, i) => ({ ...task, id: `${task.id}-${i}` }));
    expect(() =>
      disputeWrite(relayed, { comments: [], blockers: [], dependents: many, children: [] }, OWNER, time.now()),
    ).toThrow(
      `${gate!.id} has ${TASK_LIMITS.others + 1} open tasks waiting on it, more than the ${TASK_LIMITS.others} one decision tells.`,
    );
  });
});

describe('relayed approvals and their disputes', () => {
  const relay = { ...RELAY, quote: 'Yes' };

  it('keeps the record NoticeOS reads: who relayed it, the owner’s words, the question, the scope and the source', async () => {
    const { project, gate } = await relayGate();
    const approved = await answered(project, gate.id, relay);
    expect(approved.metadata.noticeos_maintenance).toMatchObject({
      verification: 'agent-recorded',
      approved: true,
      outcome: 'approved',
      by: AGENT.name,
      response: 'Yes',
      question: SCOPE,
      scope: SCOPE,
      source: RELAY.source,
    });
    const performed = await answered(project, gate.id, {
      ...RELAY,
      action: 'owner_performed',
      source: 'claude-code:session/completion',
      quote: 'I uploaded all 12 photos.',
    });
    expect(performed.metadata.noticeos_maintenance).toMatchObject({
      outcome: 'owner-performed',
      performedBy: OWNER,
      recordedBy: AGENT.name,
      response: 'I uploaded all 12 photos.',
      scope: SCOPE,
    });
    expect(performed.metadata.noticeos_maintenance!.events!.map((event) => event.response)).toEqual(['Yes']);
    const other = await newProject(engine);
    const { task } = await make(other, 'Build the layout', { labels: ['human'], choices });
    const picked = await answered(other, task.id, { ...RELAY, option: 'b', quote: 'B' });
    expect(picked.metadata.noticeos_maintenance).toMatchObject({
      response: 'B',
      question: choices.question,
      scope: 'Wide layout',
    });
  });

  it('refuses any relayed answer on a closed approval but the owner’s report, so a person’s approval stays as given', async () => {
    const service: Principal = Object.freeze({
      id: 'service:credential-2/relay-agent',
      name: 'service:installation/relay-agent',
      scopes: [SCOPES.read, SCOPES.write],
      projects: 'all',
    });
    const as = api({ principal: service, now: time.now, engine });
    const { project, photos, gate } = await relayGate();
    expect((await send(person, 'POST', `/api/gates/${gate.id}/resolve`, { projectId: project.id })).status).toBe(200);
    const before = await current(project, gate.id);
    const told = await comments(project, photos.id);

    for (const fields of [relay, { ...RELAY, action: 'declined', quote: 'No' }]) {
      const refused = await reconcile(project, gate.id, fields, as);
      expect(refused.refused, JSON.stringify(fields)).toMatch(/^refused: task: /u);
      expect(refused.refusal?.retry, 'the refusal says nothing was written').toBe('safe');
    }

    expect(await current(project, gate.id)).toEqual(before);
    expect(await comments(project, photos.id)).toEqual(told);
  });

  it('refuses a dispute of a person’s direct approval, even after an agent relays that the owner did the action', async () => {
    const { project, photos, gate } = await relayGate();
    expect((await send(person, 'POST', `/api/gates/${gate.id}/resolve`, { projectId: project.id })).status).toBe(200);
    await answered(project, gate.id, { ...RELAY, action: 'owner_performed', quote: 'I uploaded all 12 photos.' });
    const told = (await comments(project, photos.id)).length;

    const disputed = await send(person, 'POST', `/api/tasks/${gate.id}/dispute`, { projectId: project.id });

    expect(disputed).toMatchObject({ status: 409, body: { error: 'task_refused' } });
    expect((await current(project, gate.id)).status).toBe('closed');
    expect(await comments(project, photos.id)).toHaveLength(told);
  });

  it('lets a person dispute a report an agent relayed after their own approval was reopened', async () => {
    const { project, photos, gate } = await relayGate();
    expect((await send(person, 'POST', `/api/gates/${gate.id}/resolve`, { projectId: project.id })).status).toBe(200);
    const reopened = await callTool(agent, 'update_task', {
      workspace: WORKSPACE.id,
      project: project.id,
      task: gate.id,
      status: 'open',
      idempotency_key: key(),
    });
    expect(reopened.refused).toBeNull();
    const relayed = await answered(project, gate.id, {
      ...RELAY,
      action: 'owner_performed',
      quote: 'I uploaded all 12 photos.',
    });
    expect(relayed).toMatchObject({ status: 'closed', answer: { relayed: true } });

    const disputed = await send(person, 'POST', `/api/tasks/${gate.id}/dispute`, { projectId: project.id });

    expect(disputed).toMatchObject({ status: 200, body: { task: { status: 'open' } } });
    expect((await current(project, photos.id)).ready).toBe(false);
  });

  it('refuses the owner’s report on an approval whose request changed after it was approved', async () => {
    const { project, gate } = await relayGate();
    await answered(project, gate.id, relay);
    const approved = await current(project, gate.id);
    await engine.writeTask(
      project.id,
      gate.id,
      { expectedVersion: approved.version, set: { description: `${SCOPE}; also delete the originals` } },
      ENGINE_OWNER,
    );
    const before = await current(project, gate.id);

    const refused = await refusedWith(project, gate.id, {
      ...RELAY,
      action: 'owner_performed',
      quote: 'I uploaded the photos and deleted the originals.',
    });

    expect(refused).toMatch(/^refused: task: /u);
    expect(await current(project, gate.id)).toEqual(before);
  });

  it('closes an open approval on the owner’s own completed action, granting no future action', async () => {
    const { project, photos, gate } = await relayGate();
    const done = await answered(project, gate.id, {
      ...RELAY,
      action: 'owner_performed',
      quote: 'I uploaded all 12 photos and the read-back matches.',
    });
    expect(done).toMatchObject({ resolution: 'done', answer: { option: 'done', relayed: true } });
    expect(done.metadata.noticeos_maintenance!.permission).toBe('none');
    expect((await current(project, photos.id)).labels).toEqual([]);
    expect((await comments(project, photos.id)).map((comment) => comment.text)).toEqual([
      `The owner's report that they did the action of ${gate.id} themselves is recorded, so no agent does it. Check the result yourself before continuing.`,
    ]);
  });

  it('closes obsolete and superseded approvals as no longer needed, and a declined one as wont-do', async () => {
    for (const action of ['obsolete', 'superseded']) {
      const { project, gate } = await relayGate();
      const done = await answered(project, gate.id, { action, ...EVIDENCE });
      expect(done.resolution).toBe('no-longer-needed');
      expect(done.metadata.noticeos_maintenance!.permission).toBe('none');
    }
    const { project, gate } = await relayGate();
    expect((await answered(project, gate.id, { ...relay, action: 'declined', quote: 'No' })).resolution).toBe(
      'wont-do',
    );
  });

  it('reopens a relayed approval on the owner’s dispute, withdraws it, tells the waiting task, and refuses the old relay', async () => {
    const { project, photos, gate } = await relayGate();
    await answered(project, gate.id, relay);
    // The waiting task's own approval is answered; the implementation is free to go.
    expect((await current(project, photos.id)).ready).toBe(true);
    time.advance(5);

    const disputed = await send(person, 'POST', `/api/tasks/${gate.id}/dispute`, { projectId: project.id });

    expect(disputed.status).toBe(200);
    expect(disputed.body.task).toMatchObject({ status: 'open', answer: { relayed: true, disputedBy: OWNER } });
    expect((await current(project, gate.id)).metadata.noticeos_maintenance).toMatchObject({
      permission: 'none',
      approved: false,
      disputed: { by: OWNER, agent: AGENT.name, sources: [relay.source] },
    });
    expect((await comments(project, photos.id)).at(-1)!.text).toMatch(new RegExp(`disputed approval ${gate.id}`, 'u'));
    expect((await current(project, photos.id)).ready).toBe(false);
    expect(await refusedWith(project, gate.id, relay)).toMatch(/^refused: source: /u);
    // A second dispute changes nothing.
    const again = await send(person, 'POST', `/api/tasks/${gate.id}/dispute`, { projectId: project.id });
    expect(again.status).toBe(200);
    expect(await comments(project, photos.id)).toHaveLength(2);
  });

  it('refuses a dispute once the owner approved directly what an agent had relayed', async () => {
    const { project, photos, gate } = await relayGate();
    await answered(project, gate.id, relay);
    time.advance(5);
    expect((await send(person, 'POST', `/api/tasks/${gate.id}/dispute`, { projectId: project.id })).status).toBe(200);
    time.advance(5);
    const approved = await send(person, 'POST', `/api/gates/${gate.id}/resolve`, { projectId: project.id });
    expect(approved.status).toBe(200);
    expect(approved.body.task).toMatchObject({ answer: { option: 'approve', recordedBy: OWNER, relayed: false } });
    const told = (await comments(project, photos.id)).length;
    time.advance(5);

    const again = await send(person, 'POST', `/api/tasks/${gate.id}/dispute`, { projectId: project.id });

    expect(again).toMatchObject({ status: 409, body: { error: 'task_refused' } });
    expect((await current(project, gate.id)).status).toBe('closed');
    expect(await comments(project, photos.id)).toHaveLength(told);
  });

  it('tells the waiting tasks of a dispute once, however often it is sent', async () => {
    const { project, photos, gate } = await relayGate();
    await answered(project, gate.id, relay);
    time.advance(5);
    expect((await send(person, 'POST', `/api/tasks/${gate.id}/dispute`, { projectId: project.id })).status).toBe(200);
    // The reopened gate is set aside, so the same dispute sent again has a status to change.
    const reopened = await current(project, gate.id);
    await engine.writeTask(
      project.id,
      gate.id,
      { expectedVersion: reopened.version, set: { status: 'blocked' } },
      ENGINE_OWNER,
    );
    time.advance(5);

    const again = await send(person, 'POST', `/api/tasks/${gate.id}/dispute`, { projectId: project.id });

    expect(again.status).toBe(200);
    expect((await current(project, gate.id)).status).toBe('open');
    const notices = (await comments(project, photos.id)).filter((comment) =>
      comment.text.startsWith(`Owner disputed approval ${gate.id}`),
    );
    expect(notices).toHaveLength(1);
  });

  it('invalidates every earlier approval in a disputed owner-performed record', async () => {
    const { project, gate } = await relayGate();
    await answered(project, gate.id, relay);
    await answered(project, gate.id, {
      ...RELAY,
      action: 'owner_performed',
      source: 'claude-code:session/synthetic-completion',
      quote: 'I uploaded all 12 files and read one back.',
    });
    expect((await send(person, 'POST', `/api/tasks/${gate.id}/dispute`, { projectId: project.id })).status).toBe(200);
    expect(await refusedWith(project, gate.id, relay)).toMatch(/^refused: source: /u);
    expect((await current(project, gate.id)).status).toBe('open');
  });

  it('corrects a wrongly retired approval after it is reopened, keeping the old event', async () => {
    const { project, gate } = await relayGate();
    await answered(project, gate.id, { action: 'obsolete', ...EVIDENCE });
    const reopened = await callTool(agent, 'update_task', {
      workspace: WORKSPACE.id,
      project: project.id,
      task: gate.id,
      status: 'open',
      idempotency_key: key(),
    });
    expect(reopened.refused).toBeNull();
    await answered(project, gate.id, relay);
    const done = await answered(project, gate.id, {
      ...RELAY,
      action: 'owner_performed',
      quote: 'UPLOAD DONE: all 12 files are sent, and the file read back matches.',
    });
    expect(done.resolution).toBe('done');
    expect(done.metadata.noticeos_maintenance!.events!.map((event) => event.action)).toEqual(['obsolete', 'answer']);
  });
});

describe('requests to do steps', () => {
  async function stepsGate() {
    const project = await newProject(engine);
    const { task: update } = await make(project, 'Update the demo', { labels: ['human'] });
    const { created } = await engine.writeTask(
      project.id,
      update.id,
      {
        expectedVersion: update.version,
        requestAction: {
          title: 'Update the demo',
          context: 'The demo still runs the old release.',
          steps: [{ text: 'On the demo host, update to the merged commit.', command: './update.sh --commit a1b2c3d4' }],
        },
      },
      ENGINE_OWNER,
    );
    return { project, update, gate: created[0]! };
  }

  it('closes on the owner’s report that they did the steps, and hands the waiting task back to agents', async () => {
    const { project, update, gate } = await stepsGate();
    const done = await answered(project, gate.id, { ...RELAY, action: 'owner_performed', quote: 'Ran it, all good.' });
    expect(done).toMatchObject({ status: 'closed', resolution: 'done', answer: { option: 'done', relayed: true } });
    expect(done.metadata.noticeos_maintenance!.permission).toBe('none');
    expect(await current(project, update.id)).toMatchObject({ labels: [], ready: true });
    expect((await current(project, gate.id)).steps!.map((step) => step.done)).toEqual([null]);
  });

  it('refuses an answer that approves it, writing nothing', async () => {
    const { project, gate } = await stepsGate();
    expect(await refusedWith(project, gate.id, { ...RELAY, quote: 'Yes.' })).toMatch(/^refused: action: /u);
    expect(await current(project, gate.id)).toMatchObject({ status: 'open', version: 1 });
  });

  it('opens again on the owner’s dispute of a relayed report, for them to tick each step', async () => {
    const { project, update, gate } = await stepsGate();
    await answered(project, gate.id, { ...RELAY, action: 'owner_performed', quote: 'Done.' });
    const disputed = await send(person, 'POST', `/api/tasks/${gate.id}/dispute`, { projectId: project.id });
    expect(disputed.body.task).toMatchObject({ status: 'open' });
    const ticked = await send(person, 'POST', `/api/gates/${gate.id}/steps`, {
      projectId: project.id,
      step: 1,
      done: true,
    });
    expect(ticked.body.task).toMatchObject({ status: 'closed', closedBy: OWNER });
    expect((await current(project, update.id)).ready).toBe(true);
  });
});

describe('acceptances an agent relays', () => {
  const CRITERIA = '- Contributions are live.\n- An accountant confirms the tax treatment.';
  const accepted = {
    action: 'accepted',
    met: [1],
    quote: 'Close it. I accept the tax risk.',
    source: 'claude-code:session/synthetic-session',
  };

  /** A task with CRITERIA, and a task waiting on it through a blocks link. */
  async function accepting() {
    const project = await newProject(engine);
    const { task: work } = await make(project, 'Take contributions', { acceptance: CRITERIA });
    const { task: launch } = await make(project, 'Announce contributions', {
      links: [{ direction: 'depends-on', taskId: work.id, type: 'blocks' }],
    });
    return { project, work, launch };
  }

  it('closes the task as done, accepted by the owner and relayed by the agent, each criterion met or waived', async () => {
    const { project, work, launch } = await accepting();

    const done = await answered(project, work.id, accepted);

    expect(done).toMatchObject({
      status: 'closed',
      resolution: 'done',
      closeReason: 'Accepted as done',
      closeAcceptance: {
        by: OWNER,
        relayed: { by: AGENT.name, source: accepted.source, quote: accepted.quote },
        criteria: [
          { text: 'Contributions are live.', met: true },
          { text: 'An accountant confirms the tax treatment.', met: false },
        ],
      },
      metadata: {
        noticeos_maintenance: {
          action: 'accepted',
          met: [1],
          verification: 'agent-recorded',
          answerMode: 'relayed',
          permission: 'none',
        },
      },
    });
    expect((await comments(project, work.id)).at(-1)).toMatchObject({ author: AGENT.name });
    expect((await current(project, launch.id)).ready).toBe(true);
  });

  it('refuses it without met, with a criterion the task lacks, on a request to the owner and on a closed task, writing nothing', async () => {
    const { project, work } = await accepting();
    const { project: gates, gate } = await relayGate();
    const { met: _met, ...withoutMet } = accepted;
    expect(await refusedWith(project, work.id, withoutMet)).toMatch(/^refused: met: /u);
    expect(await refusedWith(project, work.id, { ...accepted, met: [3] })).toMatch(/^invalid arguments: met /u);
    expect(await refusedWith(project, work.id, { ...accepted, met: [1], action: 'answer' })).toMatch(/\bmet\b/u);
    expect(await current(project, work.id)).toMatchObject({ status: 'open', version: 1, metadata: {} });
    expect(await refusedWith(gates, gate.id, accepted)).toMatch(/^refused: action: /u);

    await answered(project, work.id, accepted);
    const closed = await current(project, work.id);
    expect(await refusedWith(project, work.id, { ...accepted, source: 'comment:other' })).toMatch(/^refused: task: /u);
    expect(await current(project, work.id)).toEqual(closed);
  });

  it('refuses one from a sender that acts for no person, such as a service, writing nothing', async () => {
    const service: Principal = Object.freeze({
      id: 'service:credential-1/relay-agent',
      name: 'service:installation/relay-agent',
      scopes: [SCOPES.read, SCOPES.write],
      projects: 'all',
    });
    const as = api({ principal: service, now: time.now, engine });
    const { project, work } = await accepting();
    const refused = await reconcile(project, work.id, accepted, as);
    expect(refused.refused).toMatch(/^refused: action: /u);
    expect(await current(project, work.id)).toMatchObject({ status: 'open', version: 1, metadata: {} });
  });

  it('opens the task again on the owner’s dispute, tells the waiting task, and refuses the disputed source', async () => {
    const { project, work, launch } = await accepting();
    await answered(project, work.id, accepted);
    time.advance(5);

    const disputed = await send(person, 'POST', `/api/tasks/${work.id}/dispute`, { projectId: project.id });

    expect(disputed.status).toBe(200);
    expect(disputed.body.task).toMatchObject({ status: 'open', resolution: null, closeAcceptance: null });
    expect((await current(project, work.id)).metadata.noticeos_maintenance).toMatchObject({
      action: 'accepted',
      disputed: { by: OWNER, agent: AGENT.name, sources: [accepted.source] },
    });
    expect((await current(project, launch.id)).ready).toBe(false);
    expect(await comments(project, launch.id)).toHaveLength(1);
    const history = await engine.listHistory(project.id, work.id, { limit: 10 });
    expect(history.map((event) => event.kind).filter((kind) => kind !== 'commented')).toEqual([
      'reopened',
      'closed',
      'created',
    ]);
    expect(await refusedWith(project, work.id, accepted)).toMatch(/^refused: source: /u);
    // A second dispute changes nothing.
    const again = await send(person, 'POST', `/api/tasks/${work.id}/dispute`, { projectId: project.id });
    expect(again.status).toBe(200);
    expect(await comments(project, launch.id)).toHaveLength(1);
    // The owner can still accept it, in their own words from another source, or in the web app.
    expect(await answered(project, work.id, { ...accepted, source: 'comment:later' })).toMatchObject({
      status: 'closed',
    });
  });
});

describe('who records an owner answer', () => {
  it('records a service’s answer only as relayed by the service, which cannot answer as a person', async () => {
    const service: Principal = Object.freeze({
      id: 'service:credential-1/relay-agent',
      name: 'service:installation/relay-agent',
      scopes: [SCOPES.read, SCOPES.write],
      projects: 'all',
    });
    const as = api({ principal: service, now: time.now, engine });
    const project = await newProject(engine);
    const { task } = await make(project, 'Build the layout', { labels: ['human'], choices });
    const { task: other } = await make(project, 'Build the other layout', { labels: ['human'], choices });

    const done = await answered(project, task.id, { ...RELAY, option: 'b', quote: 'B' }, as);

    expect(done).toMatchObject({
      choice: { option: 'b', by: service.name },
      answer: { recordedBy: service.name, relayed: true },
    });
    const direct = await send(as, 'POST', `/api/tasks/${other.id}/choose`, { projectId: project.id, option: 'b' });
    expect(direct).toMatchObject({ status: 403, body: { error: 'insufficient_scope' } });
    expect(await current(project, other.id)).toMatchObject({ choice: null, version: 1, metadata: {} });
  });

  it('needs the write scope in the project', async () => {
    const project = await newProject(engine);
    const { task } = await make(project, 'Pick', { type: 'decision', labels: ['human'], choices });
    const reader = api({ principal: { ...AGENT, scopes: [SCOPES.read] }, now: time.now, engine });
    const refused = await reconcile(project, task.id, { ...RELAY, option: 'a', quote: 'A' }, reader);
    expect(refused.refused).toMatch(/^refused: this call needs tasks:write/u);
    expect(await current(project, task.id)).toMatchObject({ status: 'open', choice: null, version: 1 });
  });

  it('shows the task it answers with no link to a project the agent cannot reach', async () => {
    const project = await newProject(engine);
    const hidden = await newProject(engine);
    const { task: secret } = await make(hidden, 'Secret');
    const { task } = await make(project, 'Pick', {
      labels: ['human'],
      choices,
      links: [{ direction: 'depends-on', taskId: secret.id, type: 'related' }],
    });
    const limited = api({
      principal: { ...AGENT, projects: new Map([[project.id, 'write' as const]]) },
      now: time.now,
      engine,
    });
    const result = await answered(project, task.id, { ...RELAY, option: 'a', quote: 'A' }, limited);
    expect((result as unknown as { dependencies: unknown[] }).dependencies).toEqual([]);
    expect((await current(project, task.id)).dependencies.map((link) => link.taskId)).toEqual([secret.id]);
  });
});

describe('the MCP refusals of reconcile_task', () => {
  it('names a missing action, an unknown argument, and an argument the action needs or does not take', async () => {
    const project = await newProject(engine);
    const { task } = await make(project, 'Ask', { labels: ['human'] });
    const base = {
      workspace: WORKSPACE.id,
      project: project.id,
      task: task.id,
      proposal_version: await versionOf(project, task.id),
      idempotency_key: key(),
    };
    expect((await callTool(agent, 'reconcile_task', base)).refused).toMatch(/\baction\b/u);
    expect((await callTool(agent, 'reconcile_task', { ...base, action: 'routine', extra: 1 })).refused).toMatch(
      /\bextra\b/u,
    );
    expect((await callTool(agent, 'reconcile_task', { ...base, action: 'routine' })).refused).toMatch(
      /\bexplanation\b/u,
    );
    expect(
      (await callTool(agent, 'reconcile_task', { ...base, action: 'routine', ...EVIDENCE, quote: 'A' })).refused,
    ).toMatch(/\bquote\b/u);
    expect(await current(project, task.id)).toMatchObject({ version: 1, labels: ['human'] });
  });
});
