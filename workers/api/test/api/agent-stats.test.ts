// Agent statistics: the counts get_agent_stats and GET /api/tasks/agent-stats
// give, in the shape NoticeOS's Agents page reads. The aggregation cases are
// ported from NoticeOS's apps/tower/test/agent-stats.test.ts.
import type { Project, TaskEngine, WorkItem } from '@ntasks/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { canonicalAgentModel, readAgentStats } from '../../src/agent-stats.ts';
import { clock, newProject, OWNER } from '../engine/helpers.ts';
import { api, callTool, get, granted, read, WORKSPACE, type TestApi } from './helpers.ts';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const HOUR = 3_600_000;
const at = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

function work(id: string, model: string | null, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    projectId: 'p',
    type: 'task',
    awaitType: null,
    status: 'closed',
    priority: 2,
    assignee: 'random-worker',
    assigneeModel: model,
    startedAt: at(4),
    updatedAt: at(2),
    closedAt: at(2),
    closedBy: null,
    closedModel: null,
    ...over,
  };
}
const stats = (tasks: WorkItem[]) => readAgentStats(tasks, NOW);

describe('canonical model identities', () => {
  it.each([
    ['Opus 5.5', 'Claude Opus 5.5'],
    ['claude-opus-5-5-20261001', 'Claude Opus 5.5'],
    ['anthropic/claude-opus-5.5-thinking', 'Claude Opus 5.5'],
    ['Claude 3.5 Sonnet', 'Claude Sonnet 3.5'],
    ['GPT-6.1-Sol-xhigh', 'GPT-6.1 Sol'],
    ['openai/gpt-6.1-sol', 'GPT-6.1 Sol'],
    ['GPT-5.3-Codex', 'GPT-5.3 Codex'],
    ['gpt-5-3-codex-high', 'GPT-5.3 Codex'],
    ['models/gemini-2.5-flash-preview', 'Gemini 2.5 Flash'],
    ['o3-mini', 'o3 mini'],
    ['claude-fable-5-1', 'Claude Fable 5.1'],
    ['build-verifier', 'Other'],
    ['claude-session', 'Other'],
    [null, 'Other'],
  ])('groups %s as %s', (input, expected) => expect(canonicalAgentModel(input)).toBe(expected));

  it('retains different versions and model variants', () => {
    expect(canonicalAgentModel('Opus 5.5')).not.toBe(canonicalAgentModel('Opus 5.6'));
    expect(canonicalAgentModel('gpt-5.3')).not.toBe(canonicalAgentModel('gpt-5.3-codex'));
    expect(canonicalAgentModel('gemini-2.5-pro')).not.toBe(canonicalAgentModel('gemini-2.5-flash'));
  });
});

describe('aggregate agent statistics', () => {
  it('merges model aliases across agents and projects, retaining all counts', () => {
    const counted = stats([
      work('ex-a', 'Opus 5.5'),
      work('ex-b', 'GPT-6.1-Sol', { assignee: '/root' }),
      work('ex-a', 'claude-opus-5-5', { projectId: 'q', assignee: 'claude/build-sponsor', priority: 0 }),
    ]);
    expect(counted.workers.map((worker) => [worker.name, worker.week])).toEqual([
      ['Claude Opus 5.5', 2],
      ['GPT-6.1 Sol', 1],
    ]);
    expect(counted.race.players[0]).toMatchObject({
      name: 'Claude Opus 5.5',
      points: 7,
      closes: [NOW - 2 * HOUR, NOW - 2 * HOUR],
    });
    expect(counted.week).toBe(3);
  });

  it('omits inactive rows and all-zero assigned work, retaining historical velocity', () => {
    const counted = stats([
      work('ex-old', 'Opus 5.5', { startedAt: at(810), closedAt: at(800) }),
      work('ex-working', 'Sonnet 5.5', { status: 'in_progress', closedAt: null }),
      work('ex-blocked', null, { status: 'blocked', closedAt: null }),
    ]);
    expect(counted.workers.map((worker) => worker.name)).toEqual(['Claude Sonnet 5.5', 'Other']);
    expect([counted.week, counted.inHand, counted.blocked]).toEqual([0, 1, 1]);
    expect(counted.race.players).toEqual([]);
    expect(counted.velocity.weeks.reduce((sum, week) => sum + week.total, 0)).toBe(1);
  });

  it('groups every unknown identity under Other without losing anonymous closes', () => {
    const counted = stats([
      work('ex-a', null),
      work('ex-b', 'Verifier 1', { assignee: 'Astra' }),
      work('ex-c', null, { assignee: null }),
    ]);
    expect(counted.workers).toHaveLength(1);
    expect(counted.workers[0]).toMatchObject({ name: 'Other', week: 3 });
    expect(counted.race.players).toHaveLength(1);
    expect(counted.velocity.names['']).toBe('Other');
    expect(counted.trophies).toEqual([]);
  });

  it('counts a close for its closer’s model, falls back to the claim, and computes a task-weighted median', () => {
    const counted = stats([
      work('ex-a', 'Opus 5.5', { closedBy: 'closer', closedModel: 'GPT-6.1-Sol' }),
      work('ex-b', 'Opus 5.5', { startedAt: at(12) }),
      work('ex-c', 'Opus 5.5', { startedAt: at(13), closedBy: '', closedModel: 'GPT-6.1-Sol' }),
      work('ex-d', 'Opus 5.5', { startedAt: at(14) }),
    ]);
    expect(counted.workers.find((worker) => worker.name === 'GPT-6.1 Sol')?.week).toBe(1);
    expect(counted.workers.find((worker) => worker.name === 'Claude Opus 5.5')?.week).toBe(3);
    expect(counted.medianHours).toBe(10.5);
  });

  it('excludes gates, epics, future and out-of-history closes and invalid durations', () => {
    const counted = stats([
      work('ex-epic', 'Opus 5.5', { type: 'epic' }),
      work('ex-gate', 'Opus 5.5', { type: 'gate' }),
      work('ex-await', 'Opus 5.5', { awaitType: 'human' }),
      work('ex-future', 'Opus 5.5', { closedAt: at(-1) }),
      work('ex-old', 'Opus 5.5', { closedAt: at(56 * 24 + 1) }),
      work('ex-negative', 'Opus 5.5', { startedAt: at(1) }),
    ]);
    expect(counted.week).toBe(1);
    expect(counted.medianHours).toBeNull();
  });

  it('uses disjoint seven-day windows', () => {
    const counted = stats([
      work('ex-boundary', 'Opus 5.5', { closedAt: at(7 * 24) }),
      work('ex-previous', 'Opus 5.5', { closedAt: at(14 * 24) }),
      work('ex-now', 'Opus 5.5', { closedAt: at(0) }),
    ]);
    expect([counted.week, counted.lastWeek]).toEqual([1, 1]);
    expect(counted.race.players[0]?.closes).toHaveLength(counted.week);
  });

  it('returns aggregates only, even for a large history', () => {
    const counted = stats(Array.from({ length: 2000 }, (_, i) => work(`ex-${i}`, 'Opus 5.5')));
    const wire = JSON.stringify(counted);
    expect(counted.week).toBe(2000);
    for (const field of ['metadata', 'assignee', 'startedAt', 'description', 'ex-1999', 'random-worker'])
      expect(wire).not.toContain(field);
    expect(counted.workers).toHaveLength(1);
  });
});

describe('get_agent_stats and GET /api/tasks/agent-stats', () => {
  const time = clock('2026-11-06T12:00:00.000Z');
  let target: TestApi;
  let engine: TaskEngine;
  let project: Project;
  let hidden: Project;

  beforeAll(async () => {
    target = api({ now: time.now });
    engine = target.engine;
    project = await newProject(engine);
    hidden = await newProject(engine);
    const claude = { name: 'agent:claude', model: 'claude-opus-5-5' };
    const codex = { name: 'agent:codex', model: 'gpt-5-3-codex-high' };
    const make = async (where: Project, title: string, input: object = {}) =>
      (await engine.createTask(where.id, { title, ...input }, OWNER)).task;
    // Closed ten days ago by codex: last week's.
    time.advance(-10 * 24 * 60);
    const old = await make(project, 'Old work');
    await engine.writeTask(
      project.id,
      old.id,
      { expectedVersion: 1, set: { assignee: codex.name, status: 'in_progress' } },
      codex,
    );
    time.advance(60);
    await engine.writeTask(
      project.id,
      old.id,
      { expectedVersion: 2, close: { reason: 'Done', resolution: 'done' } },
      codex,
    );
    time.advance(10 * 24 * 60 - 60);
    // This week: claude closes an urgent task in two hours, holds one, and codex is blocked on another.
    time.advance(-3 * 60);
    const quick = await make(project, 'Quick work', { priority: 0 });
    await engine.writeTask(
      project.id,
      quick.id,
      { expectedVersion: 1, set: { assignee: claude.name, status: 'in_progress' } },
      claude,
    );
    time.advance(2 * 60);
    await engine.writeTask(
      project.id,
      quick.id,
      { expectedVersion: 2, close: { reason: 'Done in abc1234', resolution: 'done' } },
      claude,
    );
    time.advance(60);
    const held = await make(project, 'Held work');
    await engine.writeTask(
      project.id,
      held.id,
      { expectedVersion: 1, set: { assignee: claude.name, status: 'in_progress' } },
      claude,
    );
    const stuck = await make(project, 'Stuck work');
    await engine.writeTask(
      project.id,
      stuck.id,
      { expectedVersion: 1, set: { assignee: codex.name, status: 'blocked' } },
      codex,
    );
    // Approvals and epics are not agents' work; another project's work counts only for a sender who reaches it.
    await make(project, 'Gated', { requestApproval: { reason: 'Spend once' } });
    const elsewhere = await make(hidden, 'Hidden work');
    await engine.writeTask(
      hidden.id,
      elsewhere.id,
      { expectedVersion: 1, close: { reason: 'Done', resolution: 'done' } },
      claude,
    );
  });

  it("answers NoticeOS's payload for one project, counting each model's work", async () => {
    const answer = await read<Record<string, unknown> & { stats: Record<string, unknown> }>(target, 'get_agent_stats', {
      project: project.id,
    });
    expect(Object.keys(answer)).toEqual(['readAt', 'projects', 'broken', 'stats']);
    expect(answer).toMatchObject({ readAt: time.now(), projects: 1, broken: [] });
    expect(Object.keys(answer.stats)).toEqual([
      'workers',
      'velocity',
      'race',
      'trophies',
      'week',
      'lastWeek',
      'inHand',
      'blocked',
      'medianHours',
    ]);
    expect(answer.stats).toMatchObject({
      workers: [
        { id: 'Claude Opus 5.5', name: 'Claude Opus 5.5', inHand: 1, blocked: 0, week: 1, lastWeek: 0, medianHours: 2 },
        { id: 'GPT-5.3 Codex', name: 'GPT-5.3 Codex', inHand: 0, blocked: 1, week: 0, lastWeek: 1, medianHours: 1 },
      ],
      week: 1,
      lastWeek: 1,
      inHand: 1,
      blocked: 1,
      medianHours: 1.5,
      trophies: [
        { key: 'most', holder: 'Claude Opus 5.5', value: '1', detail: 'task' },
        { key: 'fastest', holder: 'Claude Opus 5.5', value: '2 h', detail: null },
        { key: 'urgent', holder: 'Claude Opus 5.5', value: '1', detail: 'high-priority close' },
      ],
    });
    const velocity = answer.stats.velocity as { weeks: { start: string; current: boolean; total: number }[] };
    expect(velocity.weeks).toHaveLength(8);
    expect(velocity.weeks.at(-1)).toMatchObject({ start: '2026-11-02', current: true, total: 1 });
  });

  it('counts every project the sender reaches when it names none, and refuses one it cannot reach', async () => {
    const everything = await read<{ projects: number; stats: { week: number } }>(target, 'get_agent_stats');
    expect(everything.projects).toBeGreaterThanOrEqual(2);
    expect(everything.stats.week).toBeGreaterThanOrEqual(2);
    const limited = api({ principal: granted({ [project.id]: 'read' }), now: time.now, engine });
    const reached = await read<{ projects: number; stats: { week: number } }>(limited, 'get_agent_stats');
    expect(reached).toMatchObject({ projects: 1, stats: { week: 1 } });
    expect((await callTool(limited, 'get_agent_stats', { workspace: WORKSPACE.id, project: hidden.id })).refused).toBe(
      `refused: project ${hidden.id} names no project in this workspace; list_projects lists each one's projectId, key and prefix.`,
    );
  });

  it('answers the same over HTTP, with 404 for a project the sender cannot reach', async () => {
    const mcp = await read(target, 'get_agent_stats', { project: project.id });
    expect(await get(target, `/api/tasks/agent-stats?project=${project.id}`)).toEqual({ status: 200, body: mcp });
    const limited = api({ principal: granted({ [project.id]: 'read' }), now: time.now, engine });
    expect((await get(limited, `/api/tasks/agent-stats?project=${hidden.id}`)).status).toBe(404);
    expect((await get(limited, '/api/tasks/agent-stats?status=open')).status).toBe(400);
  });
});
