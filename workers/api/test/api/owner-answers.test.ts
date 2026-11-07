// The owner answers an agent records with reconcile_task, and the maintenance
// it does with evidence: what counts as the owner's authority. Ported from
// NoticeOS's scripts/task-tool-guards.test.mjs, which held these rules. Its
// stand-in task client ran each decision as several commands, some of which a
// test could fail; here each decision is one batch, so those cases become a
// retry that replays.
import type { Project, Task, TaskComment, TaskEngine, TaskEvent } from '@ntasks/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { SCOPES, type Principal } from '../../src/auth.ts';
import { commentProposalMatches, replyOption, type TaskMaintenance } from '../../src/owner-answers.ts';
import { proposalOf } from '../../src/views.ts';
import { clock, newProject, OWNER as ENGINE_OWNER } from '../engine/helpers.ts';
import { api, callTool, read, send, WORKSPACE, type TestApi } from './helpers.ts';

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
const BY_OWNER = { name: OWNER };

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
  readonly choice: { option: string; by: string } | null;
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

/** reconcile_task on the task as get_task shows it now, with evidence; `fields` adds to or replaces the arguments. */
async function maintain(project: Project, task: string, fields: Record<string, unknown>) {
  const detail = await read<{ proposal: string }>(agent, 'get_task', { project: project.id, task });
  return callTool<{ task: McpTask; replayed: boolean }>(agent, 'reconcile_task', {
    workspace: WORKSPACE.id,
    project: project.id,
    task,
    proposal: detail.proposal,
    explanation: 'The recorded evidence resolves this request.',
    evidence: 'commit abc1234 and the referenced owner source',
    idempotency_key: key(),
    ...fields,
  });
}

async function answered(project: Project, task: string, fields: Record<string, unknown>): Promise<McpTask> {
  const result = await maintain(project, task, fields);
  if (result.refused !== null) throw new Error(`refused: ${result.refused}`);
  return result.value.task;
}

async function refusedWith(project: Project, task: string, fields: Record<string, unknown>): Promise<string> {
  const result = await maintain(project, task, fields);
  if (result.refused === null) throw new Error(`answered: ${JSON.stringify(result.value)}`);
  return result.refused;
}

const directAnswer = {
  action: 'answer',
  answer_mode: 'direct',
  owner: OWNER,
  source: 'codex://threads/owner-layout',
  question: 'Which local layout should we build?',
  scope: 'Local layout implementation only; no deployment',
};

describe('an owner answer an agent relays', () => {
  it('releases implementation with letters, recommendation replies and directions, preserving proposal and scope', async () => {
    for (const response of ['A', 'yes, your recommendation', 'Use a two-column layout with the summary first']) {
      const project = await newProject(engine);
      const { task } = await make(project, 'Build the layout', { labels: ['human'], choices });
      await engine.writeTask(
        project.id,
        task.id,
        { expectedVersion: 1, set: { assignee: 'abandoned-agent', status: 'in_progress' } },
        { name: 'abandoned-agent' },
      );

      const done = await answered(project, task.id, { ...directAnswer, response });

      expect(done).toMatchObject({ status: 'open', assignee: null, labels: [] });
      expect(done.metadata.noticeos_maintenance).toMatchObject({
        response,
        scope: directAnswer.scope,
        permission: 'none',
        verification: 'agent-recorded',
      });
      expect(done.choice?.option ?? null).toBe(response.startsWith('Use ') ? null : 'a');
      expect((await current(project, task.id)).close, 'answering is not implementation completion').toBeNull();
    }
  });

  it('clears awaitingHuman and records the recorder, the question, the source and the proposal it answered', async () => {
    const project = await newProject(engine);
    const { task } = await make(project, 'Build the layout', { labels: ['human'], choices });
    const response = 'Use compact cards (Recommended) — keep the summary visible.';

    const done = await answered(project, task.id, { ...directAnswer, response, option: 'a' });

    expect(done).toMatchObject({ awaitingHuman: false, ready: true, status: 'open', assignee: null });
    expect(done.choice).toMatchObject({ option: 'a', by: OWNER });
    expect(done.metadata.noticeos_maintenance).toMatchObject({
      by: AGENT.name,
      verification: 'agent-recorded',
      response,
      question: directAnswer.question,
      source: directAnswer.source,
      scope: directAnswer.scope,
      permission: 'none',
      proposal: proposalOf(task),
    });
    const [note] = await comments(project, task.id);
    expect(note).toMatchObject({ author: AGENT.name });
    expect(note!.text).toContain(`Recorded by: ${AGENT.name}`);
    expect(note!.text).toContain(`Answer: ${response}`);
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

    const decided = await answered(project, decision.id, { ...directAnswer, response: 'A' });
    expect(decided).toMatchObject({ status: 'open', awaitingHuman: false });
    const built = await answered(project, work.id, { ...directAnswer, response: 'A' });
    expect(built).toMatchObject({ awaitingHuman: false, ready: false });
    expect((await current(project, work.id)).dependencies.map((link) => link.taskId)).toEqual([blocker.id]);
  });

  it('refuses uncertainty, conflicting picks and absent options without changing anything', async () => {
    for (const fields of [
      { response: 'Maybe compact', option: 'a' },
      { response: 'B', option: 'a' },
      { response: 'Wide layout', option: 'a' },
      { response: 'Your recommendation', option: 'b' },
      { response: 'Wide layout (Recommended) — keep details visible.', option: 'a' },
      { response: 'B — Wide layout', option: 'a' },
      { response: 'B. Wide layout', option: 'a' },
      { response: 'Whatever', option: 'a' },
      { response: 'No, keep it as is', option: 'a' },
      { response: 'A for ex-other', option: 'a' },
      { response: 'yes', option: 'a' },
      { response: 'Use compact cards', option: 'c' },
      { response: 'A', owner: 'claude' },
      { response: 'A', owner: AGENT.name },
      { response: 'A', question: undefined },
      { response: 'A', source: 'comment:owner-1' },
      { response: 'A', source: 'https://owner:secret@example.com/chat' },
    ]) {
      const project = await newProject(engine);
      const { task } = await make(project, 'Build the layout', { labels: ['human'], choices });

      await refusedWith(project, task.id, { ...directAnswer, ...fields });

      const after = await current(project, task.id);
      expect(after.metadata.noticeos_maintenance, JSON.stringify(fields)).toBeUndefined();
      expect(after.labels).toEqual(['human']);
      expect(await comments(project, task.id)).toEqual([]);
    }
    const project = await newProject(engine);
    const { task } = await make(project, 'No options', { labels: ['human'] });
    await refusedWith(project, task.id, { ...directAnswer, response: 'Compact cards', option: 'a' });
  });

  it('names the source and owner a direct answer needs before any change', async () => {
    const project = await newProject(engine);
    const { task } = await make(project, 'Pick the layout', { type: 'decision', labels: ['human'], choices });
    expect(
      await refusedWith(project, task.id, {
        ...directAnswer,
        response: 'A',
        option: 'a',
        source: 'comment:agent-relay',
      }),
    ).toMatch(/direct.*(?:chat|conversation).*source|source.*(?:chat|conversation)/iu);
    expect(
      await refusedWith(project, task.id, { ...directAnswer, owner: undefined, response: 'A', option: 'a' }),
    ).toMatch(/owner.*required/iu);
    expect(await comments(project, task.id)).toEqual([]);
    expect(await answered(project, task.id, { ...directAnswer, response: 'A', option: 'a' })).toMatchObject({
      status: 'open',
    });
  });

  it('asks one clarification for an ambiguous answer and keeps the whole request', async () => {
    const project = await newProject(engine);
    const { task } = await make(project, 'Build the layout', { labels: ['human'], choices });
    expect(await refusedWith(project, task.id, { ...directAnswer, response: 'yes' })).toMatch(/one clarification/u);
    expect((await current(project, task.id)).metadata.noticeos_maintenance).toBeUndefined();
  });

  it('refuses a proposal that changed, and a retry with the same key replays without a second record', async () => {
    const project = await newProject(engine);
    const { task } = await make(project, 'Build the layout', { labels: ['human'], choices });
    const { proposal } = await read<{ proposal: string }>(agent, 'get_task', { project: project.id, task: task.id });
    await engine.writeTask(
      project.id,
      task.id,
      { expectedVersion: 1, set: { title: 'Changed proposal' } },
      ENGINE_OWNER,
    );
    expect(await refusedWith(project, task.id, { ...directAnswer, response: 'A', proposal })).toBe(
      'refused: The proposal changed. Read it again and match the owner’s answer to the proposal they saw.',
    );
    expect(await comments(project, task.id)).toEqual([]);

    const fields = { ...directAnswer, response: 'A', idempotency_key: 'direct-answer-retry-0001' };
    const first = await maintain(project, task.id, fields);
    const again = await maintain(project, task.id, fields);
    expect(first.value).toMatchObject({ replayed: false, task: { awaitingHuman: false, choice: { option: 'a' } } });
    expect(again.value).toMatchObject({ replayed: true, task: { awaitingHuman: false, choice: { option: 'a' } } });
    expect(await comments(project, task.id)).toHaveLength(1);
  });

  it('refuses a combined record too long for a comment before any change', async () => {
    const project = await newProject(engine);
    const { task } = await make(project, 'Build the layout', { labels: ['human'] });
    await refusedWith(project, task.id, {
      ...directAnswer,
      response: `Use ${'x'.repeat(990)}`,
      question: 'q'.repeat(1000),
      scope: 's'.repeat(1000),
      explanation: 'e'.repeat(800),
      evidence: 'v'.repeat(800),
    });
    expect((await current(project, task.id)).metadata).toEqual({});
    expect(await comments(project, task.id)).toEqual([]);
  });

  it('cannot approve a production action from an unverified conversation link or a made-up owner', async () => {
    const project = await newProject(engine);
    const { gate } = await make(project, 'Read the logs', {
      requestApproval: { reason: 'Read production logs once; no writes' },
    });
    await refusedWith(project, gate!.id, {
      action: 'answer',
      response: 'yes',
      owner: 'Made-up Owner',
      source: 'https://example.com/fabricated-answer',
      scope: 'Read production logs once; no writes',
    });
    expect((await current(project, gate!.id)).status).toBe('open');
    expect(await comments(project, gate!.id)).toEqual([]);
  });
});

describe('an owner answer written as a task comment', () => {
  it('records a decision for agents to close; a forged comment, a stale proposal or a later edit does nothing', async () => {
    const project = await newProject(engine);
    const { task: decision } = await make(project, 'Pick the layout', { type: 'decision', labels: ['human'], choices });
    const { task: follow } = await make(project, 'Follow the pick', {
      links: [{ direction: 'depends-on', taskId: decision.id, type: 'blocks' }],
    });
    time.advance(60);
    const { comment } = await engine.addComment(project.id, decision.id, 'A', BY_OWNER);
    const args = { action: 'answer', owner: OWNER, source: `comment:${comment.id}`, scope: 'Local layout' };

    expect(await refusedWith(project, decision.id, { ...args, response: 'B' })).toMatch(
      /does not match owner and exact response/u,
    );
    // An agent's comment with the owner's words is a relay, not the owner's own.
    const { comment: quoted } = await engine.addComment(project.id, decision.id, 'A', { name: AGENT.name });
    expect(await refusedWith(project, decision.id, { ...args, source: `comment:${quoted.id}`, response: 'A' })).toMatch(
      new RegExp(
        `source comment ${quoted.id} does not match owner and exact response \\(author: agent:claude\\).*answer_mode relayed`,
        'u',
      ),
    );
    const { proposal: old } = await read<{ proposal: string }>(agent, 'get_task', {
      project: project.id,
      task: decision.id,
    });
    time.advance(60);
    await engine.writeTask(
      project.id,
      decision.id,
      { expectedVersion: 1, set: { title: 'Changed decision' } },
      ENGINE_OWNER,
    );
    expect(await refusedWith(project, decision.id, { ...args, response: 'A', proposal: old })).toMatch(
      /proposal changed/u,
    );
    // The comment was written against the proposal before the edit: it answers that one, not this.
    expect(await refusedWith(project, decision.id, { ...args, response: 'A' })).toMatch(
      /source could not authenticate the owner answer/u,
    );
    expect((await current(project, decision.id)).metadata.noticeos_maintenance).toBeUndefined();

    time.advance(60);
    const { comment: fresh } = await engine.addComment(project.id, decision.id, 'A', BY_OWNER);
    const done = await answered(project, decision.id, { ...args, source: `comment:${fresh.id}`, response: 'A' });
    expect(done).toMatchObject({ status: 'open', choice: { option: 'a', by: OWNER } });
    expect(done.metadata.noticeos_maintenance).toMatchObject({ verification: 'source-verified' });
    const closed = await callTool(agent, 'close_task', {
      workspace: WORKSPACE.id,
      project: project.id,
      task: decision.id,
      reason: 'Implemented in abc1234',
      idempotency_key: key(),
    });
    expect(closed.refused).toBeNull();
    expect((await current(project, follow.id)).ready).toBe(true);
  });

  it('counts a comment as the owner’s own only when the person the agent acts for wrote it', async () => {
    const project = await newProject(engine);
    const { task } = await make(project, 'Pick the layout', { type: 'decision', labels: ['human'], choices });
    const { comment } = await engine.addComment(project.id, task.id, 'A', { name: 'Someone Else' });
    expect(
      await refusedWith(project, task.id, {
        action: 'answer',
        owner: 'Someone Else',
        source: `comment:${comment.id}`,
        scope: 'Local layout',
        response: 'A',
      }),
    ).toMatch(/source could not authenticate the owner answer/u);
  });

  it('is bound to the proposal at its date, not to replacement choices', () => {
    const old = {
      id: 'ex-choice',
      title: 'Original choice',
      description: '',
      acceptance: '',
      type: 'decision',
      choices,
    } as const;
    const replaced = { ...old, title: 'Replacement choice' };
    const task = { ...replaced, updatedAt: '2026-10-17T12:00:00.000Z' } as unknown as Task;
    const comment = {
      id: 'owner-1',
      taskId: 'ex-choice',
      author: OWNER,
      text: 'A',
      createdAt: '2026-10-17T11:00:00.000Z',
    };
    const history: TaskEvent[] = [
      {
        seq: 1,
        taskId: 'ex-choice',
        projectId: 'p',
        version: 1,
        kind: 'created',
        actor: OWNER,
        model: null,
        at: '2026-10-17T10:00:00.000Z',
        changes: old,
      },
      {
        seq: 2,
        taskId: 'ex-choice',
        projectId: 'p',
        version: 2,
        kind: 'updated',
        actor: OWNER,
        model: null,
        at: '2026-10-17T12:00:00.000Z',
        changes: { title: replaced.title },
      },
    ];
    const op = { source: 'comment:owner-1', proposal: proposalOf(replaced) } as TaskMaintenance;
    expect(commentProposalMatches(op, task, [comment], history)).toBe(false);
    expect(commentProposalMatches({ ...op, proposal: proposalOf(old) }, task, [comment], history)).toBe(true);
    expect(commentProposalMatches(op, task, [comment], []), 'missing history cannot invent approval').toBe(false);
  });
});

describe('reading a reply', () => {
  it('does not release work on an uncertain reply, and maps a clearly named batch reply only to its tasks', () => {
    for (const response of [
      'I am not sure',
      'Maybe A',
      'Can you explain the recommendation?',
      'A for ex-other and ex-next',
    ]) {
      expect(() => replyOption(response, choices, 'ex-choice'), response).toThrow(/clarification/u);
    }
    expect(replyOption('A for ex-choice and ex-other', choices, 'ex-choice')).toBe('a');
  });
});

describe('maintenance with evidence', () => {
  it('closes completed and obsolete requests with evidence and returns routine work to agents', async () => {
    for (const action of ['completed', 'obsolete', 'superseded', 'routine']) {
      const project = await newProject(engine);
      const { task } = await make(project, 'An old ask', { labels: ['human'] });
      const done = await answered(project, task.id, { action });
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
    expect(
      await refusedWith(project, task.id, { action: 'completed' }),
      'implementation evidence cannot approve a business decision',
    ).toMatch(/does not prove a business decision was approved/u);
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
      await refusedWith(project, gate!.id, { action, ...fields });
    }
    const retired = await answered(project, gate!.id, { action: 'obsolete' });
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
    const { proposal } = await read<{ proposal: string }>(agent, 'get_task', { project: project.id, task: task.id });
    const lost = await callTool(racing, 'reconcile_task', {
      workspace: WORKSPACE.id,
      project: project.id,
      task: task.id,
      proposal,
      explanation: 'The holder stopped.',
      evidence: 'Agent registry',
      idempotency_key: key(),
      ...fields,
      inactive: true,
    });
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

  it('need the complete question, the exact scope and an explicit approval', async () => {
    for (const fields of [
      { question: 'Approve a check?' },
      { scope: 'Deploy production' },
      { response: 'Maybe yes' },
      { response: 'The implementation exists' },
    ]) {
      const project = await newProject(engine);
      const { gate } = await make(project, 'Check logs', { requestApproval: { reason: scope } });
      await refusedWith(project, gate!.id, {
        ...directAnswer,
        question: `Approve: ${scope}?`,
        response: 'yes',
        scope,
        ...fields,
      });
      expect(await comments(project, gate!.id)).toEqual([]);
      expect((await current(project, gate!.id)).status).toBe('open');
    }
    const project = await newProject(engine);
    const { task, gate } = await make(project, 'Check logs', { labels: ['human'], requestApproval: { reason: scope } });
    await engine.writeTask(
      project.id,
      task.id,
      { expectedVersion: 1, set: { assignee: 'old-agent', status: 'blocked' } },
      ENGINE_OWNER,
    );
    const done = await answered(project, gate!.id, {
      ...directAnswer,
      question: `Approve: ${scope}?`,
      response: 'yes',
      scope,
    });
    expect(done).toMatchObject({
      status: 'closed',
      resolution: 'done',
      closeReason: 'Owner approved the recorded scope',
    });
    expect(done.metadata.noticeos_maintenance).toMatchObject({
      permission: 'approved-scope-only',
      verification: 'agent-recorded',
      scope,
    });
    // The task waiting on it goes back to agents, within that scope.
    expect(await current(project, task.id)).toMatchObject({ status: 'open', assignee: null, labels: [], ready: true });
    expect((await comments(project, task.id)).map((comment) => comment.text)).toEqual([
      `Owner approval recorded on ${gate!.id}. Continue only within that recorded scope; other approvals are unchanged.`,
    ]);
  });

  it('declines one approval as wont-do, tells the task waiting on it, and never accepts a conditional or unverified refusal', async () => {
    for (const fields of [
      { response: 'Approve' },
      { response: 'Skip it if tests pass' },
      { scope: 'Deploy production' },
      { question: 'Approve something?' },
      { answer_mode: undefined, question: undefined, source: 'codex://threads/untrusted' },
    ]) {
      const project = await newProject(engine);
      const { gate } = await make(project, 'Check logs', { requestApproval: { reason: scope } });
      const refused = await refusedWith(project, gate!.id, {
        ...directAnswer,
        action: 'declined',
        question: `Approve ${scope}?`,
        response: 'No',
        scope,
        ...fields,
      });
      expect(refused).not.toBe(
        'refused: this workspace, project or task is not available to you, or the change was not accepted',
      );
      expect((await current(project, gate!.id)).status).toBe('open');
      expect(await comments(project, gate!.id)).toEqual([]);
    }
    const project = await newProject(engine);
    const { task: work, gate } = await make(project, 'Work', { labels: ['human'], requestApproval: { reason: scope } });
    await callTool(agent, 'request_human_approval', {
      workspace: WORKSPACE.id,
      project: project.id,
      task: work.id,
      reason: 'Deploy once',
    });
    const other = (await current(project, work.id)).dependencies.find((link) => link.taskId !== gate!.id)!;

    const declined = await answered(project, gate!.id, {
      ...directAnswer,
      action: 'declined',
      question: `Approve ${scope}?`,
      response: 'No',
      scope,
    });
    expect(declined).toMatchObject({ status: 'closed', resolution: 'wont-do' });
    expect(declined.metadata.noticeos_maintenance).toMatchObject({ permission: 'none', outcome: 'declined' });
    expect((await current(project, work.id)).labels).toEqual([]);
    const told = await comments(project, work.id);
    expect(told.some((comment) => comment.text.includes(scope) && comment.text.includes('must not'))).toBe(true);
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
    const prodScope = 'Read production speed once; no writes';
    const { task: decision, gate } = await make(project, 'Pick the layout', {
      type: 'decision',
      labels: ['human'],
      choices,
      requestApproval: { reason: prodScope },
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
      ...directAnswer,
      action: 'declined',
      question: `Approve ${prodScope}?`,
      response: 'Skip the production speed check. Commit now and note that it was not run.',
      scope: prodScope,
    });
    expect(declined).toMatchObject({ status: 'closed', resolution: 'wont-do' });
    expect((await current(project, decision.id)).status).toBe('in_progress');
    expect(
      (await comments(project, decision.id)).some((c) => c.text.includes(prodScope) && c.text.includes('must not')),
    ).toBe(true);

    const picked = await answered(project, decision.id, { ...directAnswer, response: 'A', option: 'a' });
    expect(picked).toMatchObject({ status: 'open', choice: { option: 'a' } });
    const closed = await callTool<{ task: McpTask }>(agent, 'close_task', {
      workspace: WORKSPACE.id,
      project: project.id,
      task: decision.id,
      reason: 'Implemented in abc1234; declined production check was not run.',
      idempotency_key: key(),
    });
    expect(closed.value?.task.closeReason).toMatch(/abc1234/u);
  });

  it('retires a duplicate only for the same full scope, moving the task waiting on it to the survivor', async () => {
    const project = await newProject(engine);
    const { task: prod, gate: old } = await make(project, 'Production read', {
      requestApproval: { reason: 'One bounded production read' },
    });
    const { gate: other } = await make(project, 'Deploy', { requestApproval: { reason: 'Deploy the app' } });
    expect(await refusedWith(project, old!.id, { action: 'duplicate', duplicate_of: other!.id })).toMatch(
      /same requested scope/u,
    );
    const { gate: survivor } = await make(project, 'Production read again', {
      requestApproval: { reason: 'One bounded production read' },
    });

    const retired = await answered(project, old!.id, { action: 'duplicate', duplicate_of: survivor!.id });
    expect(retired).toMatchObject({ status: 'closed', resolution: 'duplicate' });
    expect((await current(project, survivor!.id)).status).toBe('open');
    const waiting = await current(project, prod.id);
    expect(waiting.dependencies.find((link) => link.taskId === survivor!.id)?.type).toBe('blocks');
    expect(waiting.ready).toBe(false);
  });
});

describe('relayed approvals and their disputes', () => {
  const relayScope = 'Upload 12 new photos to production bucket example-images; add files only and read one back';
  const relay = {
    action: 'answer',
    answer_mode: 'relayed',
    owner: OWNER,
    source: 'claude-code:session/synthetic-session',
    question: `Approve ${relayScope}?`,
    scope: relayScope,
    response: 'Yes',
  };
  async function relayGate() {
    const project = await newProject(engine);
    const { task: photos, gate } = await make(project, 'Upload the photos', {
      labels: ['human'],
      requestApproval: { reason: relayScope },
    });
    return { project, photos, gate: gate! };
  }

  it('closes the approval on a linkless relay, leaves the inbox and lets the implementation close', async () => {
    const { project, photos, gate } = await relayGate();
    const done = await answered(project, gate.id, relay);
    expect(done).toMatchObject({ status: 'closed', awaitingHuman: false, resolution: 'done' });
    expect(done.metadata.noticeos_maintenance).toMatchObject({
      verification: 'agent-recorded',
      answerMode: 'relayed',
      by: AGENT.name,
      owner: OWNER,
      source: relay.source,
      question: relay.question,
      response: 'Yes',
      scope: relayScope,
      outcome: 'approved',
      permission: 'approved-scope-only',
    });
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

  it('keeps a quoted batch approval and a scoped chat approval as events before the owner’s own completion', async () => {
    const { project, gate } = await relayGate();
    const question = 'Accept my pick on all 9? (Saying yes also approves the live changes exactly as scoped.)';
    const response = 'All except 4 (already done), 7 (not worth the risk)';
    const by = { name: AGENT.name };
    const batch = await engine.addComment(
      project.id,
      gate.id,
      `Round 3 item 3 accepted. Scope: ${relayScope}. Question: "${question}" Reply: "${response}"`,
      by,
    );
    await answered(project, gate.id, {
      ...relay,
      source: `comment:${batch.comment.id}`,
      question,
      response,
      approval_item: 3,
    });
    const secondQuestion = 'Run the photo upload, then merge that branch?';
    const second = await engine.addComment(
      project.id,
      gate.id,
      `Question: "${secondQuestion}" Reply: "Yes, upload and merge". Scope: ${relayScope}`,
      by,
    );
    await answered(project, gate.id, {
      ...relay,
      source: `comment:${second.comment.id}`,
      question: secondQuestion,
      response: 'Yes, upload and merge',
    });
    const completion = 'UPLOAD DONE: all 12 files are sent, and the file read back matches.';
    const result = await engine.addComment(project.id, gate.id, `Owner reported: "${completion}"`, by);
    const done = await answered(project, gate.id, {
      action: 'owner_performed',
      answer_mode: 'relayed',
      owner: OWNER,
      source: `comment:${result.comment.id}`,
      scope: relayScope,
      response: completion,
    });
    expect(done).toMatchObject({ status: 'closed', resolution: 'done' });
    expect(done.metadata.noticeos_maintenance).toMatchObject({
      approved: true,
      outcome: 'owner-performed',
      performedBy: OWNER,
      recordedBy: AGENT.name,
      permission: 'none',
      response: completion,
    });
    expect(done.metadata.noticeos_maintenance!.events!.map((event) => event.response)).toEqual([
      response,
      'Yes, upload and merge',
    ]);
  });

  it('closes an open approval on the owner’s own completed action, granting no future action', async () => {
    const { project, photos, gate } = await relayGate();
    const done = await answered(project, gate.id, {
      action: 'owner_performed',
      answer_mode: 'relayed',
      owner: OWNER,
      source: relay.source,
      scope: relayScope,
      response: 'I uploaded all 12 photos and the read-back matches.',
    });
    expect(done.resolution).toBe('done');
    expect(done.metadata.noticeos_maintenance!.permission).toBe('none');
    expect((await current(project, photos.id)).labels).toEqual([]);
  });

  it('refuses invented quotes, broadening, conditions, ambiguous and negative replies before any write', async () => {
    for (const fields of [
      { response: 'Maybe' },
      { response: 'Yes if tests pass' },
      { response: 'No' },
      { response: 'Yes, upload everything and delete the originals' },
      { scope: 'Deploy the entire production app' },
      { owner: 'claude' },
      { question: 'Approve something?' },
      { source: 'quoted', response: 'Approved' },
      { source: 'conditional', response: 'Yes' },
      { source: 'quoted', approval_item: 7, question: 'Accept all 9?', response: 'All except 7' },
    ]) {
      const { project, gate } = await relayGate();
      const by = { name: AGENT.name };
      const quoted = await engine.addComment(
        project.id,
        gate.id,
        'item 7. Accept all 9? All except 7. Owner said Yes.',
        by,
      );
      const conditional = await engine.addComment(
        project.id,
        gate.id,
        `Question: ${relay.question}\nReply: Yes if all tests pass`,
        by,
      );
      const sources: Record<string, string> = { quoted: quoted.comment.id, conditional: conditional.comment.id };
      const named = (fields as { source?: string }).source;
      const source = named === undefined ? relay.source : `comment:${sources[named]}`;
      await refusedWith(project, gate.id, { ...relay, ...fields, source });
      const after = await current(project, gate.id);
      expect(after.status, JSON.stringify(fields)).toBe('open');
      expect(after.version).toBe(gate.version);
    }
  });

  it('closes obsolete and superseded approvals as no longer needed, and a declined one as wont-do', async () => {
    for (const action of ['obsolete', 'superseded']) {
      const { project, gate } = await relayGate();
      const done = await answered(project, gate.id, { action });
      expect(done.resolution).toBe('no-longer-needed');
      expect(done.metadata.noticeos_maintenance!.permission).toBe('none');
    }
    const { project, gate } = await relayGate();
    expect((await answered(project, gate.id, { ...relay, action: 'declined', response: 'No' })).resolution).toBe(
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
    const after = await current(project, gate.id);
    expect(after.status).toBe('open');
    expect(after.metadata.noticeos_maintenance).toMatchObject({
      permission: 'none',
      approved: false,
      disputed: { by: OWNER, agent: AGENT.name, sources: [relay.source] },
    });
    expect((await comments(project, gate.id)).at(-1)!.text).toBe(
      `Owner disputed the approval relayed by ${AGENT.name}. The gate is reopened; the recorded action requires a new owner approval.\nDisputed source: ${relay.source}`,
    );
    expect((await comments(project, photos.id)).at(-1)!.text).toBe(
      `Owner disputed approval ${gate.id}, relayed by ${AGENT.name}. Stop the recorded action until a new owner approval is recorded.`,
    );
    expect((await current(project, photos.id)).ready).toBe(false);
    expect(await refusedWith(project, gate.id, relay)).toMatch(/source.*disputed/u);
    // A second dispute changes nothing.
    const again = await send(person, 'POST', `/api/tasks/${gate.id}/dispute`, { projectId: project.id });
    expect(again.status).toBe(200);
    expect(await comments(project, photos.id)).toHaveLength(2);
  });

  it('invalidates every earlier approval in a disputed owner-performed record', async () => {
    const { project, gate } = await relayGate();
    await answered(project, gate.id, relay);
    await answered(project, gate.id, {
      ...relay,
      action: 'owner_performed',
      source: 'claude-code:session/synthetic-completion',
      question: undefined,
      response: 'I uploaded all 12 files and read one back.',
    });
    expect((await send(person, 'POST', `/api/tasks/${gate.id}/dispute`, { projectId: project.id })).status).toBe(200);
    expect(await refusedWith(project, gate.id, relay)).toMatch(/source.*disputed/u);
    expect((await current(project, gate.id)).status).toBe('open');
  });

  it('corrects a wrongly retired approval after it is reopened, keeping the old event', async () => {
    const { project, gate } = await relayGate();
    await answered(project, gate.id, { action: 'obsolete' });
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
      ...relay,
      action: 'owner_performed',
      question: undefined,
      response: 'UPLOAD DONE: all 12 files are sent, and the file read back matches.',
    });
    expect(done.resolution).toBe('done');
    expect(done.metadata.noticeos_maintenance!.events!.map((event) => event.action)).toEqual(['obsolete', 'answer']);
  });
});

describe('who records an owner answer', () => {
  it('needs the write scope in the project, and a person’s decision is refused to an agent over HTTP', async () => {
    const project = await newProject(engine);
    const { task } = await make(project, 'Pick', { type: 'decision', labels: ['human'], choices });
    const reader = api({ principal: { ...AGENT, scopes: [SCOPES.read] }, now: time.now, engine });
    const { proposal } = await read<{ proposal: string }>(reader, 'get_task', { project: project.id, task: task.id });
    const refused = await callTool(reader, 'reconcile_task', {
      workspace: WORKSPACE.id,
      project: project.id,
      task: task.id,
      proposal,
      explanation: 'x',
      evidence: 'y',
      idempotency_key: key(),
      ...directAnswer,
      response: 'A',
    });
    expect(refused.refused).toMatch(/^refused: this call needs tasks:write/u);
    const answer = await send(agent, 'POST', `/api/tasks/${task.id}/respond`, { projectId: project.id, response: 'A' });
    expect(answer).toEqual({
      status: 403,
      body: {
        error: 'insufficient_scope',
        detail:
          'Only a person signed in to Ntasks answers a decision, approves an approval or disputes one. Answer it in the Ntasks web app.',
      },
    });
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
    const { proposal } = await read<{ proposal: string }>(limited, 'get_task', { project: project.id, task: task.id });
    const result = await callTool<{ task: { dependencies: unknown[] } }>(limited, 'reconcile_task', {
      workspace: WORKSPACE.id,
      project: project.id,
      task: task.id,
      proposal,
      explanation: 'x',
      evidence: 'y',
      idempotency_key: key(),
      ...directAnswer,
      response: 'A',
    });
    expect(result.value?.task.dependencies).toEqual([]);
    expect((await current(project, task.id)).dependencies.map((link) => link.taskId)).toEqual([secret.id]);
  });
});

describe('the MCP refusals of reconcile_task', () => {
  it('names a missing action, a missing project and an unknown argument as NoticeOS did', async () => {
    const project = await newProject(engine);
    const { task } = await make(project, 'Ask', { labels: ['human'] });
    const base = {
      workspace: WORKSPACE.id,
      project: project.id,
      task: task.id,
      proposal: 'p',
      explanation: 'x',
      evidence: 'y',
      idempotency_key: key(),
    };
    expect((await callTool(agent, 'reconcile_task', base)).refused).toBe(
      'refused: action is required for reconciliation.',
    );
    expect((await callTool(agent, 'reconcile_task', { ...base, action: 'routine', extra: 1 })).refused).toBe(
      'invalid arguments: unknown extra',
    );
    expect((await callTool(agent, 'reconcile_task', { ...base, action: 'answer' })).refused).toBe(
      'refused: response is required, must be text without control characters and must fit within 1000 characters. Send that field again with the same owner words.',
    );
    expect((await callTool(agent, 'reconcile_task', { ...base, action: 'routine', response: 'A' })).refused).toBe(
      'refused: Owner-answer fields require action answer, declined or owner_performed. Omit those fields for maintenance without an owner answer.',
    );
  });
});
