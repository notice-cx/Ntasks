// The burn-down: how GET /api/tasks/burndown counts each day's open, created
// and closed tasks, the days it covers, and who may read it.
import {
  burndownDays,
  burndownWindow,
  type BurndownDay,
  type BurndownItem,
  type Project,
  type TaskEngine,
} from '@ntasks/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { SCOPES, type Principal } from '../../src/auth.ts';
import type { BurndownPayload } from '../../src/burndown.ts';
import { AGENT, clock, newProject, OWNER } from '../engine/helpers.ts';
import { api, get, granted, type TestApi } from './helpers.ts';

const HOUR = 3_600_000;
/** Noon in Los Angeles on Tuesday 10 November 2026. */
const NOW = Date.parse('2026-11-10T20:00:00.000Z');
/** Long before the eight weeks, so every day of them is recorded. */
const LONG_AGO = '2026-01-01T00:00:00.000Z';

const item = (createdAt: string, closedAt: string | null = null, resolution: BurndownItem['resolution'] = null) => ({
  createdAt,
  closedAt,
  resolution: closedAt !== null && resolution === null ? ('done' as const) : resolution,
});

/** The burn-down of `items` as of NOW, by day. */
function count(
  items: readonly BurndownItem[],
  { zone = 'UTC', created = [LONG_AGO], closedBefore = false } = {},
): { recordedFrom: string | null; byDay: Map<string, BurndownDay>; days: readonly BurndownDay[] } {
  const { recordedFrom, days } = burndownDays({ items, closedBefore }, created, burndownWindow(NOW, zone));
  return { recordedFrom, days, byDay: new Map(days.map((day) => [day.day, day])) };
}

describe('the days a burn-down covers', () => {
  it('is the eight weeks up to and including today, cut at midnight in the time zone', () => {
    const utc = burndownWindow(NOW);
    expect(utc.days).toHaveLength(56);
    expect([utc.days[0], utc.days.at(-1), utc.from, utc.to]).toEqual([
      '2026-09-16',
      '2026-11-10',
      '2026-09-16T00:00:00.000Z',
      '2026-11-11T00:00:00.000Z',
    ]);
    const local = burndownWindow(NOW, 'America/Los_Angeles');
    // Summer time until 1 Nov, so the first midnight is 7 am UTC and the last 8 am.
    expect([local.from, local.to]).toEqual(['2026-09-16T07:00:00.000Z', '2026-11-11T08:00:00.000Z']);
    const fallBack = local.days.indexOf('2026-11-01');
    expect(local.bounds[fallBack + 1]! - local.bounds[fallBack]!).toBe(25 * HOUR);
    // 5 am on 11 Nov in Tokyo.
    expect(burndownWindow(NOW, 'Asia/Tokyo').days.at(-1)).toBe('2026-11-11');
  });
});

describe('how a day is counted', () => {
  it('counts a task created and closed on the same day as created and done, and never open', () => {
    const { byDay } = count([item('2026-11-09T09:00:00.000Z', '2026-11-09T17:00:00.000Z')]);
    expect(byDay.get('2026-11-08')).toEqual({ day: '2026-11-08', open: 0, created: 0, done: 0, closedNotDone: 0 });
    expect(byDay.get('2026-11-09')).toEqual({ day: '2026-11-09', open: 0, created: 1, done: 1, closedNotDone: 0 });
    expect(byDay.get('2026-11-10')).toEqual({ day: '2026-11-10', open: 0, created: 0, done: 0, closedNotDone: 0 });
  });

  it('keeps a task open from the day it was created until the day it closes, and tells done from other closes', () => {
    const { byDay, days } = count([
      // Open since before the eight weeks.
      item('2026-08-01T00:00:00.000Z'),
      item('2026-10-01T10:00:00.000Z', '2026-10-05T10:00:00.000Z', 'wont-do'),
      item('2026-10-03T10:00:00.000Z', '2026-11-02T10:00:00.000Z', 'done'),
      item('2026-10-03T11:00:00.000Z', '2026-10-03T12:00:00.000Z', 'duplicate'),
      // Closed before the eight weeks: never open on any of their days, though the store would not read it.
      item('2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
    ]);
    expect(byDay.get('2026-09-16')?.open).toBe(1);
    expect(byDay.get('2026-10-01')).toMatchObject({ open: 2, created: 1 });
    expect(byDay.get('2026-10-03')).toMatchObject({ open: 3, created: 2, done: 0, closedNotDone: 1 });
    expect(byDay.get('2026-10-05')).toMatchObject({ open: 2, closedNotDone: 1 });
    expect(byDay.get('2026-11-02')).toMatchObject({ open: 1, done: 1 });
    expect(byDay.get('2026-11-10')?.open).toBe(1);
    // Each day's open count is the day before's, plus what it created, less what it closed.
    for (const [i, day] of days.entries()) {
      if (i === 0) continue;
      const before = days[i - 1]!;
      expect(day.open, day.day).toBe(before.open! + day.created! - day.done! - day.closedNotDone!);
    }
  });

  it("puts a task on the person's own day, where clocks change too", () => {
    // 6 pm on 9 Nov in Los Angeles is 10 Nov in UTC.
    const created = [item('2026-11-10T02:00:00.000Z')];
    expect(count(created).byDay.get('2026-11-09')).toMatchObject({ open: 0, created: 0 });
    expect(count(created).byDay.get('2026-11-10')).toMatchObject({ open: 1, created: 1 });
    const local = count(created, { zone: 'America/Los_Angeles' });
    expect(local.byDay.get('2026-11-09')).toMatchObject({ open: 1, created: 1 });
    // 11:30 pm on 1 Nov, the day Los Angeles leaves summer time, which lasts 25 hours.
    const closed = [item('2026-10-20T12:00:00.000Z', '2026-11-02T07:30:00.000Z')];
    expect(count(closed, { zone: 'America/Los_Angeles' }).byDay.get('2026-11-01')).toMatchObject({ open: 0, done: 1 });
    expect(count(closed).byDay.get('2026-11-01')).toMatchObject({ open: 1, done: 0 });
    expect(count(closed).byDay.get('2026-11-02')).toMatchObject({ open: 0, done: 1 });
  });

  it('shows the days before the first record as not recorded, never as zero', () => {
    const fresh = count([item('2026-10-21T09:00:00.000Z')], { created: ['2026-10-20T15:00:00.000Z'] });
    expect(fresh.recordedFrom).toBe('2026-10-20');
    expect(fresh.byDay.get('2026-10-19')).toEqual({
      day: '2026-10-19',
      open: null,
      created: null,
      done: null,
      closedNotDone: null,
    });
    expect(fresh.byDay.get('2026-10-20')).toMatchObject({ open: 0, created: 0 });
    expect(fresh.byDay.get('2026-10-21')).toMatchObject({ open: 1, created: 1 });
    // A task imported from before the project was made is a record of that day.
    expect(count([item('2026-10-01T09:00:00.000Z')], { created: ['2026-10-20T15:00:00.000Z'] }).recordedFrom).toBe(
      '2026-10-01',
    );
    // So is a task closed before the eight weeks: the days since then are recorded.
    expect(count([], { created: ['2026-10-20T15:00:00.000Z'], closedBefore: true }).recordedFrom).toBe('2026-09-16');
  });

  it('counts a project with no tasks as zero from the day it was made, and no project as nothing recorded', () => {
    const empty = count([], { created: ['2026-11-04T10:00:00.000Z'] });
    expect(empty.recordedFrom).toBe('2026-11-04');
    expect(empty.days.filter((day) => day.open === null)).toHaveLength(49);
    expect(empty.byDay.get('2026-11-04')).toEqual({
      day: '2026-11-04',
      open: 0,
      created: 0,
      done: 0,
      closedNotDone: 0,
    });
    const none = count([], { created: [] });
    expect(none.recordedFrom).toBeNull();
    expect(none.days.every((day) => day.open === null && day.created === null)).toBe(true);
  });
});

/** The owner, signed in to the web app. */
const PERSON: Principal = Object.freeze({
  id: 'person:owner',
  name: 'Person',
  scopes: [SCOPES.read, SCOPES.write, SCOPES.decide],
  projects: 'all',
  person: 'Person',
});

/** GET /api/tasks/burndown, its answer read as the payload, with its days by day. */
async function burndownOf(sender: TestApi, query = '') {
  const { status, body } = await get(sender, `/api/tasks/burndown${query}`);
  const payload = body as unknown as BurndownPayload;
  return { status, body: payload, byDay: new Map((payload.days ?? []).map((day) => [day.day, day])) };
}

describe('GET /api/tasks/burndown', () => {
  const time = clock('2026-11-03T12:00:00.000Z');
  let target: TestApi;
  let engine: TaskEngine;
  let project: Project;
  let hidden: Project;
  let reopened: string;

  beforeAll(async () => {
    target = api({ principal: PERSON, now: time.now });
    engine = target.engine;
    project = await newProject(engine);
    hidden = await newProject(engine);
    const make = async (where: Project, title: string) => (await engine.createTask(where.id, { title }, OWNER)).task;
    const close = (id: string, version: number) =>
      engine.writeTask(
        project.id,
        id,
        { expectedVersion: version, close: { reason: 'Done.', resolution: 'done' } },
        AGENT,
      );

    // 3 Nov: two tasks created, one of them closed the same day.
    reopened = (await make(project, 'Fix the sign-in link')).id;
    await close((await make(project, 'Rename the page')).id, 1);
    await make(hidden, 'Hidden work');
    // 4 Nov: the first closes; 5 Nov: it is reopened.
    time.advance(24 * 60);
    await close(reopened, 1);
    time.advance(24 * 60);
    await engine.writeTask(project.id, reopened, { expectedVersion: 2, reopen: true }, AGENT);
    time.advance(2 * 24 * 60);
  });

  it('counts each day of the project, with a reopened task open again and its earlier close not counted', async () => {
    const { status, body, byDay } = await burndownOf(target, `?project=${project.id}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      readAt: time.now(),
      timeZone: 'UTC',
      from: '2026-09-13T00:00:00.000Z',
      to: '2026-11-08T00:00:00.000Z',
      projects: 1,
      recordedFrom: '2026-11-03',
    });
    expect(body.days).toHaveLength(56);
    expect(byDay.get('2026-11-02')).toMatchObject({ open: null, created: null });
    expect(byDay.get('2026-11-03')).toEqual({ day: '2026-11-03', open: 1, created: 2, done: 1, closedNotDone: 0 });
    expect(byDay.get('2026-11-04')).toEqual({ day: '2026-11-04', open: 1, created: 0, done: 0, closedNotDone: 0 });
    expect(byDay.get('2026-11-07')).toMatchObject({ open: 1, done: 0 });

    await engine.writeTask(
      project.id,
      reopened,
      { expectedVersion: 3, close: { reason: 'Fixed again.', resolution: 'done' } },
      AGENT,
    );
    const again = await burndownOf(target, `?project=${project.id}`);
    expect(again.byDay.get('2026-11-06')).toMatchObject({ open: 1, done: 0 });
    expect(again.byDay.get('2026-11-07')).toMatchObject({ open: 0, done: 1 });
  });

  it('counts a project with no tasks as zero from the day it was made', async () => {
    const empty = await newProject(engine);
    const { body, byDay } = await burndownOf(target, `?project=${empty.id}`);
    expect(body.recordedFrom).toBe('2026-11-07');
    expect(byDay.get('2026-11-06')).toMatchObject({ open: null });
    expect(byDay.get('2026-11-07')).toEqual({ day: '2026-11-07', open: 0, created: 0, done: 0, closedNotDone: 0 });
  });

  it('cuts the days in the time zone it names', async () => {
    const { body } = await burndownOf(target, `?project=${project.id}&timeZone=America/Los_Angeles`);
    expect(body).toMatchObject({ timeZone: 'America/Los_Angeles', from: '2026-09-13T07:00:00.000Z' });
    expect(body.days.at(-1)?.day).toBe('2026-11-07');
  });

  it('reads every project the sender reaches when it names none, and refuses one it cannot reach', async () => {
    const every = await burndownOf(target);
    expect(every.body.projects).toBeGreaterThanOrEqual(3);
    expect(every.byDay.get('2026-11-03')?.created).toBeGreaterThanOrEqual(3);
    const limited = api({ principal: granted({ [project.id]: 'read' }), now: time.now, engine });
    const reached = await burndownOf(limited);
    expect(reached.body.projects).toBe(1);
    expect(reached.byDay.get('2026-11-03')).toMatchObject({ created: 2 });
    expect((await get(limited, `/api/tasks/burndown?project=${hidden.id}`)).status).toBe(404);
    for (const query of ['timeZone=Mars/Olympus_Mons', 'before=2026-11-01'])
      expect((await get(target, `/api/tasks/burndown?project=${project.id}&${query}`)).status, query).toBe(400);
  });
});
