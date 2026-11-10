// The wins feed: what GET /api/tasks/wins counts and lists, the days it
// covers, and who may read it.
import type { Project, TaskEngine, WinItem } from '@ntasks/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { SCOPES, type Principal } from '../../src/auth.ts';
import { readWins, winsWindow, type WinsPayload } from '../../src/wins.ts';
import { AGENT, clock, newProject, OWNER } from '../engine/helpers.ts';
import { api, get, granted, send, type TestApi } from './helpers.ts';

const DAY = 86_400_000;

function item(id: string, over: Partial<WinItem> = {}): WinItem {
  return {
    id,
    projectId: 'p',
    type: 'task',
    title: `Task ${id}`,
    status: 'closed',
    resolution: 'done',
    closedAt: '2026-11-08T10:00:00.000Z',
    closedBy: 'agent:claude',
    closedModel: 'claude-opus-5-5',
    choice: null,
    pullRequest: null,
    commit: null,
    mergeCommit: null,
    stage: null,
    mergedAt: null,
    liveAt: null,
    done: 0,
    ...over,
  };
}

describe('the days a read covers', () => {
  const now = Date.parse('2026-11-10T00:20:00.000Z');

  it('ends with today when it names no day, and offers the seven days before', () => {
    expect(winsWindow(now, undefined)).toEqual({
      timeZone: 'UTC',
      from: '2026-11-04T00:00:00.000Z',
      to: '2026-11-11T00:00:00.000Z',
      earlier: '2026-11-04',
      days: ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'],
    });
    expect(winsWindow(now, '2026-11-04')).toMatchObject({
      from: '2026-10-28T00:00:00.000Z',
      to: '2026-11-04T00:00:00.000Z',
      earlier: '2026-10-28',
    });
  });

  it("cuts the days at midnight in the viewer's time zone", () => {
    // 4:20 pm on 9 Nov in Los Angeles: today there is still 9 Nov.
    expect(winsWindow(now, undefined, 'America/Los_Angeles')).toEqual({
      timeZone: 'America/Los_Angeles',
      from: '2026-11-03T08:00:00.000Z',
      to: '2026-11-10T08:00:00.000Z',
      earlier: '2026-11-03',
      days: ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'],
    });
    // Before 1 Nov, when Los Angeles left summer time, midnight was 7 am UTC.
    expect(winsWindow(now, '2026-11-03', 'America/Los_Angeles')).toMatchObject({
      from: '2026-10-27T07:00:00.000Z',
      to: '2026-11-03T08:00:00.000Z',
    });
    expect(winsWindow(now, undefined, 'Asia/Tokyo')?.days.at(-1)).toBe('2026-11-10');
  });

  it('reaches back eight weeks and no further, and refuses anything but a calendar day', () => {
    // Eight weeks of days up to and including today start on 16 Sep.
    expect(winsWindow(now, '2026-09-23')).toMatchObject({
      from: '2026-09-16T00:00:00.000Z',
      to: '2026-09-23T00:00:00.000Z',
      earlier: null,
    });
    for (const before of ['2026-09-22', '2026-11-12', '2026-02-30', '2026-11-4', 'tomorrow', ''])
      expect(winsWindow(now, before), before).toBeNull();
  });
});

describe('what counts as a win', () => {
  const window = winsWindow(Date.parse('2026-11-10T12:00:00.000Z'), undefined)!;
  const pr = 'https://github.com/example/app/pull/7';

  it('puts a 6 pm win in Los Angeles under that day there, not the next', () => {
    const local = winsWindow(Date.parse('2026-11-10T04:00:00.000Z'), undefined, 'America/Los_Angeles')!;
    const chosen = { option: 'c', label: 'Wins feed', by: 'Person', at: '2026-11-10T02:00:00.000Z' };
    const { days } = readWins([item('d-1', { type: 'decision', choice: chosen })], local);
    expect(days.at(-1)).toEqual({ day: '2026-11-09', shipped: 0, decided: 1, finished: 0 });
    expect(readWins([item('d-1', { type: 'decision', choice: chosen })], window).days.at(-1)).toEqual({
      day: '2026-11-10',
      shipped: 0,
      decided: 1,
      finished: 0,
    });
  });

  it('counts a pull request once, however many tasks closed with it, and a change live without a merge', () => {
    const { wins, totals } = readWins(
      [
        item('a-1', { pullRequest: pr, stage: 'merged', mergedAt: '2026-11-09T21:00:00.000Z' }),
        item('a-2', {
          pullRequest: pr,
          stage: 'live',
          mergedAt: '2026-11-09T20:00:00.000Z',
          liveAt: '2026-11-09T22:00:00.000Z',
        }),
        item('a-3', { commit: 'abc1234', stage: 'live', liveAt: '2026-11-06T09:00:00.000Z' }),
        // Merged before these days, and a change still waiting for its merge.
        item('a-4', {
          pullRequest: 'https://github.com/example/app/pull/2',
          stage: 'merged',
          mergedAt: '2026-11-03T23:59:59.999Z',
        }),
        item('a-5', { pullRequest: 'https://github.com/example/app/pull/3', stage: 'built' }),
      ],
      window,
    );
    expect(totals).toEqual({ shipped: 2, decided: 0, finished: 0, approved: 0 });
    expect(wins).toEqual([
      {
        kind: 'shipped',
        at: '2026-11-09T20:00:00.000Z',
        projectId: 'p',
        stage: 'live',
        pullRequest: pr,
        commit: null,
        tasks: [
          { id: 'a-2', title: 'Task a-2' },
          { id: 'a-1', title: 'Task a-1' },
        ],
      },
      expect.objectContaining({
        kind: 'shipped',
        stage: 'live',
        pullRequest: null,
        commit: 'abc1234',
        at: '2026-11-06T09:00:00.000Z',
      }),
    ]);
  });

  it('lists answers and epics closed as done, counts approvals without listing them, and skips every other close', () => {
    const chosen = { option: 'c', label: 'Wins feed', by: 'Person', at: '2026-11-10T00:07:00.000Z' };
    const { wins, totals, days } = readWins(
      [
        item('d-1', { type: 'decision', choice: chosen }),
        // An answer on a task still open counts too; the same task read twice counts once.
        item('d-2', {
          status: 'open',
          resolution: null,
          closedAt: null,
          choice: { ...chosen, option: 'a', label: 'Keep it' },
        }),
        item('d-2', {
          status: 'open',
          resolution: null,
          closedAt: null,
          choice: { ...chosen, option: 'a', label: 'Keep it' },
        }),
        item('d-3', { type: 'decision', choice: { ...chosen, at: '2026-11-01T00:00:00.000Z' } }),
        // A choice recorded with no one who made it is not a person's answer.
        item('d-4', { type: 'decision', choice: { option: 'a', label: 'Keep it', at: chosen.at } }),
        item('e-1', { type: 'epic', done: 33, closedAt: '2026-11-08T11:49:00.000Z' }),
        item('e-2', { type: 'epic', resolution: 'no-longer-needed' }),
        item('g-1', { type: 'gate' }),
        item('g-2', { type: 'gate', resolution: 'no-longer-needed' }),
        item('t-1'),
        item('t-2', { resolution: 'wont-do' }),
      ],
      window,
    );
    expect(totals).toEqual({ shipped: 0, decided: 2, finished: 1, approved: 1 });
    expect(wins.map((win) => [win.kind, win.kind === 'shipped' ? win.tasks[0]!.id : win.id])).toEqual([
      ['decided', 'd-1'],
      ['decided', 'd-2'],
      ['finished', 'e-1'],
    ]);
    expect(wins[0]).toEqual({
      kind: 'decided',
      at: chosen.at,
      projectId: 'p',
      id: 'd-1',
      title: 'Task d-1',
      option: 'c',
      label: 'Wins feed',
      by: 'Person',
    });
    expect(wins[2]).toEqual({
      kind: 'finished',
      at: '2026-11-08T11:49:00.000Z',
      projectId: 'p',
      id: 'e-1',
      title: 'Task e-1',
      done: 33,
    });
    expect(days.map((day) => day.day)).toEqual([
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
    ]);
    expect(days.at(-1)).toEqual({ day: '2026-11-10', shipped: 0, decided: 2, finished: 0 });
    expect(days[4]).toEqual({ day: '2026-11-08', shipped: 0, decided: 0, finished: 1 });
  });
});

/** The owner, signed in to the web app, who answers decisions. */
const PERSON: Principal = Object.freeze({
  id: 'person:owner',
  name: 'Person',
  scopes: [SCOPES.read, SCOPES.write, SCOPES.decide],
  projects: 'all',
  person: 'Person',
});

/** GET /api/tasks/wins, its answer read as the feed's payload. */
async function winsOf(sender: TestApi, query = ''): Promise<{ status: number; body: WinsPayload }> {
  const { status, body } = await get(sender, `/api/tasks/wins${query}`);
  return { status, body: body as unknown as WinsPayload };
}

describe('GET /api/tasks/wins', () => {
  const time = clock('2026-11-06T12:00:00.000Z');
  let target: TestApi;
  let engine: TaskEngine;
  let project: Project;
  let hidden: Project;
  const pr = 'https://github.com/example/app/pull/12';

  beforeAll(async () => {
    target = api({ principal: PERSON, now: time.now });
    engine = target.engine;
    project = await newProject(engine);
    hidden = await newProject(engine);
    const make = async (where: Project, title: string, input: object = {}) =>
      (await engine.createTask(where.id, { title, ...input }, OWNER)).task;
    const close = (where: Project, id: string, close: object) =>
      engine.writeTask(
        where.id,
        id,
        { expectedVersion: 1, close: { reason: 'Done.', resolution: 'done', ...close } },
        AGENT,
      );

    // Two tasks closed with one pull request, which merges.
    const first = await make(project, 'Wins feed page');
    const second = await make(project, 'Wins feed read');
    await close(project, first.id, { commit: 'abcdef1', pullRequest: pr });
    await close(project, second.id, { commit: 'abcdef2', pullRequest: pr });
    time.advance(60);
    expect(
      await send(target, 'POST', '/api/delivery', { repository: 'example/app', stage: 'merged', pullRequests: [pr] }),
    ).toMatchObject({
      status: 200,
    });
    // An answered decision.
    time.advance(10);
    const decision = await make(project, 'Pick the page', {
      type: 'decision',
      labels: ['human'],
      choices: {
        question: 'Which?',
        options: [
          { key: 'a', label: 'Scoreboard' },
          { key: 'b', label: 'Wins feed', recommended: true },
        ],
      },
    });
    const chose = await send(target, 'POST', `/api/tasks/${decision.id}/choose`, {
      projectId: project.id,
      option: 'b',
    });
    expect(chose, JSON.stringify(chose.body)).toMatchObject({ status: 200 });
    // An epic that closed as done with the second of its two tasks; another closed as no longer needed.
    time.advance(10);
    const epic = await make(project, 'Productivity page', { type: 'epic' });
    for (const title of ['Read', 'Page'])
      await close(project, (await make(project, title, { parentId: epic.id })).id, {});
    const dropped = await make(project, 'Old plan', { type: 'epic' });
    await engine.writeTask(
      project.id,
      dropped.id,
      { expectedVersion: 1, close: { reason: 'Dropped.', resolution: 'no-longer-needed' } },
      AGENT,
    );
    // Busywork: a close with nothing shipped, and a close as won't do.
    await close(project, (await make(project, 'Tidy notes')).id, {});
    await engine.writeTask(
      project.id,
      (await make(project, 'Skip it')).id,
      { expectedVersion: 1, close: { reason: 'No.', resolution: 'wont-do' } },
      AGENT,
    );
    // Another project's win counts only for a sender who reaches it.
    await close(hidden, (await make(hidden, 'Hidden epic', { type: 'epic' })).id, {});
  });

  it('lists the wins of the seven days up to today, newest first, with each day counted', async () => {
    const { status, body } = await winsOf(target, `?project=${project.id}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      readAt: time.now(),
      from: '2026-10-31T00:00:00.000Z',
      to: '2026-11-07T00:00:00.000Z',
      earlier: '2026-10-31',
      projects: 1,
      shippedBefore: false,
      totals: { shipped: 1, decided: 1, finished: 1, approved: 0 },
    });
    expect(body.wins.map((win) => win.kind)).toEqual(['finished', 'decided', 'shipped']);
    expect(body.wins[0]).toMatchObject({ title: 'Productivity page', done: 2 });
    expect(body.wins[1]).toMatchObject({ title: 'Pick the page', option: 'b', label: 'Wins feed', by: 'Person' });
    const shipped = body.wins[2]!;
    expect(shipped).toMatchObject({ kind: 'shipped', stage: 'merged', pullRequest: pr });
    // Both merged at once, so they come in the order of their ids.
    expect(shipped.kind === 'shipped' && shipped.tasks.map((task) => task.title).sort()).toEqual([
      'Wins feed page',
      'Wins feed read',
    ]);
    expect(body.days).toHaveLength(7);
    expect(body.days.at(-1)).toEqual({ day: '2026-11-06', shipped: 1, decided: 1, finished: 1 });
  });

  it('reads every project the sender reaches when it names none, and refuses one it cannot reach', async () => {
    const every = await winsOf(target);
    expect(every.body.totals.finished).toBeGreaterThanOrEqual(2);
    const limited = api({ principal: granted({ [project.id]: 'read' }), now: time.now, engine });
    expect((await winsOf(limited)).body).toMatchObject({ projects: 1, totals: { finished: 1 } });
    expect((await get(limited, `/api/tasks/wins?project=${hidden.id}`)).status).toBe(404);
  });

  it('reads earlier days, knows a change shipped before them, and refuses a day it does not reach', async () => {
    time.advance(8 * 24 * 60);
    const later = await winsOf(target, `?project=${project.id}`);
    expect(later.body).toMatchObject({ shippedBefore: true, totals: { shipped: 0, decided: 0, finished: 0 } });
    const earlier = await winsOf(target, `?project=${project.id}&before=${later.body.earlier}`);
    expect(earlier.body).toMatchObject({ shippedBefore: false, totals: { shipped: 1, decided: 1, finished: 1 } });
    expect(Date.parse(earlier.body.to) - Date.parse(earlier.body.from)).toBe(7 * DAY);
    const local = await winsOf(target, `?project=${project.id}&timeZone=America/Los_Angeles`);
    expect(local.body).toMatchObject({ timeZone: 'America/Los_Angeles' });
    expect(local.body.from.slice(11)).toMatch(/^0[78]:00:00\.000Z$/);
    for (const query of ['before=2026-01-01', 'before=soon', 'status=open', 'timeZone=Mars/Olympus_Mons'])
      expect((await get(target, `/api/tasks/wins?project=${project.id}&${query}`)).status, query).toBe(400);
  });
});
