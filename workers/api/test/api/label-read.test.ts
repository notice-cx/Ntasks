// GET /api/tasks with `label`: every task of a project carrying one label, in
// every status and closed of any age, by id, a page at a time.
import type { Project, TaskEngine } from '@ntasks/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { AGENT, clock, OWNER } from '../engine/helpers.ts';
import { api, get, grantedOnly, type TestApi } from './helpers.ts';

// Long before the reads: a close this old is outside every closed window a board has.
const time = clock('2026-01-05T09:00:00.000Z');
let target: TestApi;
let engine: TaskEngine;
let project: Project;
let near: Project;
const ids: Record<string, string> = {};

async function projectWith(prefix: string): Promise<Project> {
  return engine.createProject({
    id: crypto.randomUUID(),
    key: `${prefix}.example.com`,
    name: `Label ${prefix}`,
    prefix,
  });
}

beforeAll(async () => {
  target = api({ now: time.now });
  engine = target.engine;
  const run = crypto
    .randomUUID()
    .replaceAll('-', '')
    .slice(0, 5)
    .replace(/^[0-9]/u, 'x');
  // A project whose prefix begins with the other's: its tasks are never the other's.
  project = await projectWith(`lb${run}`);
  near = await projectWith(`lb${run}x`);
  const file = async (key: string, title: string, labels: readonly string[], extra = {}) => {
    ids[key] = (await engine.createTask(project.id, { title, labels, ...extra }, AGENT)).task.id;
    time.advance(1);
  };
  await file('shipped', 'Shipped long ago', ['handoff']);
  await engine.writeTask(
    project.id,
    ids.shipped!,
    { expectedVersion: 1, close: { reason: 'Live.', resolution: 'done' } },
    OWNER,
  );
  await file('blocker', 'Must land first', []);
  await file('waiting', 'Waits on the blocker', ['handoff'], {
    links: [{ direction: 'depends-on', taskId: ids.blocker, type: 'blocks' }],
  });
  await file('free', 'Ready to start', ['handoff', 'copy']);
  await file('unlabelled', 'Carries another label', ['copy']);
  ids.elsewhere = (
    await engine.createTask(near.id, { title: 'Same label, other project', labels: ['handoff'] }, AGENT)
  ).task.id;
  // Two hundred days on: the shipped task's close is far behind every board's window.
  time.advance(200 * 24 * 60);
});

const path = (query: string) => `/api/tasks?project=${project.id}&${query}`;
const idsOf = (body: Record<string, unknown>) => (body.tasks as { id: string }[]).map((task) => task.id);

describe('GET /api/tasks?label=', () => {
  it('reads every task of the project carrying the label, closed of any age, by id', async () => {
    const { status, body } = await get(target, path('label=handoff'));
    expect(status).toBe(200);
    expect(body).toMatchObject({
      project: project.key,
      prefix: project.prefix,
      repo: '',
      label: 'handoff',
      next: null,
    });
    expect(idsOf(body)).toEqual([ids.shipped, ids.waiting, ids.free].sort());
    const tasks = new Map((body.tasks as Record<string, unknown>[]).map((task) => [task.id, task]));
    expect(tasks.get(ids.shipped!)).toMatchObject({
      status: 'closed',
      closeReason: 'Live.',
      resolution: 'done',
      ready: false,
    });
    expect(tasks.get(ids.waiting!)).toMatchObject({ status: 'open', ready: false });
    expect(tasks.get(ids.free!)).toMatchObject({ status: 'open', ready: true, labels: ['copy', 'handoff'] });
    // The board's own closed window leaves the old close out.
    const board = await get(target, `/api/tasks?project=${project.id}`);
    expect(idsOf(board.body)).not.toContain(ids.shipped);
  });

  it('pages by id, naming where the next page starts', async () => {
    const all = [ids.shipped, ids.waiting, ids.free].sort();
    const first = await get(target, path('label=handoff&limit=2'));
    expect(idsOf(first.body)).toEqual(all.slice(0, 2));
    expect(first.body.next).toBe(all[1]);
    const second = await get(target, path(`label=handoff&limit=2&after=${first.body.next as string}`));
    expect(idsOf(second.body)).toEqual(all.slice(2));
    expect(second.body.next).toBeNull();
  });

  it('answers no tasks for a label nobody carries', async () => {
    expect((await get(target, path('label=absent'))).body).toMatchObject({ tasks: [], next: null });
  });

  it("refuses the board's windows, paging without a label, and malformed paging", async () => {
    const refused = async (query: string) => (await get(target, path(query))).body.detail;
    expect(await refused('label=handoff&status=open')).toBe(
      'a label read reads every status and every close: leave out status and closedDays',
    );
    expect(await refused('label=handoff&closedDays=30')).toBe(
      'a label read reads every status and every close: leave out status and closedDays',
    );
    expect(await refused('limit=5')).toBe('limit and after page a label read: label=');
    expect(await refused('label=handoff&after=not a task')).toBe(
      'after must be a task id: the next of the page before',
    );
    for (const limit of ['0', '201', 'many'])
      expect((await get(target, path(`label=handoff&limit=${limit}`))).status).toBe(400);
    expect((await get(target, path(`label=${'x'.repeat(129)}`))).status).toBe(400);
  });

  it('is answered only for a project the sender reaches', async () => {
    const outsider = api({ engine, now: time.now, principal: grantedOnly(near.id) });
    expect((await get(outsider, path('label=handoff'))).status).toBe(404);
    expect(idsOf((await get(outsider, `/api/tasks?project=${near.id}&label=handoff`)).body)).toEqual([ids.elsewhere]);
  });
});
