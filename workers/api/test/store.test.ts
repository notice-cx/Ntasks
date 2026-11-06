// The task store object: the Worker hands it signed-in requests, it applies
// its schema once, and it answers repeated reads from memory until a write or
// a deferred task's time changes them.
import type { TaskEngine } from '@ntasks/domain';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine/index.ts';
import { cachedReads } from '../src/store/cache.ts';
import type { TaskStore } from '../src/store/index.ts';
import { migrate, MIGRATIONS } from '../src/store/schema.ts';
import { newMeter } from '../src/store/sqlite.ts';
import { ORIGIN, READER, worker } from './api/helpers.ts';
import { AGENT, clock } from './engine/helpers.ts';
import { store, storeDatabase } from './store.ts';

async function newProject(tasks: TaskEngine) {
  const id = crypto.randomUUID();
  return tasks.createProject({
    id,
    key: `${id.slice(0, 8)}.example.com`,
    name: 'Store project',
    prefix: `s${id.slice(0, 8)}`,
  });
}

describe('the Worker and the store', () => {
  it('hands a signed-in request to the store, which answers it from its own tasks', async () => {
    const project = await runInDurableObject(store(), (instance: TaskStore) => newProject(instance.tasks));

    const response = await worker(READER).fetch(new Request(`${ORIGIN}/api/tasks/projects`), env);

    expect(response.status).toBe(200);
    const { projects } = (await response.json()) as { projects: { projectId: string }[] };
    expect(projects.map((entry) => entry.projectId)).toContain(project.id);
  });

  it('lists its projects to the rest of the Worker', async () => {
    const project = await runInDurableObject(store(), (instance: TaskStore) => newProject(instance.tasks));

    const projects = await store().projects();

    expect(projects.map((entry) => entry.id)).toContain(project.id);
  });

  it('applies each schema file once, in order', async () => {
    const applied = await runInDurableObject(store(), (_instance: TaskStore, state) => {
      migrate(state.storage);
      return state.storage.sql
        .exec<{ name: string }>('SELECT name FROM store_migrations ORDER BY name')
        .toArray()
        .map((row) => row.name);
    });

    expect(applied).toEqual(MIGRATIONS.map((migration) => migration.name));
  });
});

describe('reads from memory', () => {
  it('serves a repeated board from memory, and reads again after a write', async () => {
    await runInDurableObject(store(), async (instance: TaskStore) => {
      const project = await newProject(instance.tasks);
      await instance.tasks.createTask(project.id, { title: 'First' }, AGENT);
      const board = async () => {
        Object.assign(instance.meter, newMeter());
        const response = await instance.serve(new Request(`${ORIGIN}/api/tasks?project=${project.id}`), READER);
        const { tasks } = (await response.json()) as { tasks: { title: string }[] };
        return {
          titles: tasks.map((task) => task.title),
          rowsRead: instance.meter.rowsRead,
          statements: instance.meter.statements,
        };
      };

      const first = await board();
      const again = await board();
      await instance.tasks.createTask(project.id, { title: 'Second' }, AGENT);
      const afterWrite = await board();

      expect(first.titles).toEqual(['First']);
      expect(first.rowsRead).toBeGreaterThan(0);
      expect(again).toEqual({ titles: ['First'], rowsRead: 0, statements: 0 });
      expect(afterWrite.titles).toEqual(['First', 'Second']);
      expect(afterWrite.rowsRead).toBeGreaterThan(0);
    });
  });

  it("reads again once a deferred task's time comes", async () => {
    const time = clock();
    const meter = newMeter();
    const tasks = cachedReads(createEngine(storeDatabase(meter), { now: time.now }), time.now);
    const project = await newProject(tasks);
    const later = new Date(Date.parse(time.now()) + 60 * 60_000).toISOString();
    const { task } = await tasks.createTask(project.id, { title: 'Later', deferUntil: later }, AGENT);
    const readyNow = async () => {
      Object.assign(meter, newMeter());
      const [found] = await tasks.listBoard(project.id, { statuses: ['open'] });
      return { ready: found?.ready, rowsRead: meter.rowsRead };
    };

    expect((await readyNow()).ready).toBe(false);
    time.advance(30);
    expect(await readyNow()).toEqual({ ready: false, rowsRead: 0 });
    time.advance(31);
    const due = await readyNow();
    expect(due.ready).toBe(true);
    expect(due.rowsRead).toBeGreaterThan(0);
    expect(task.deferUntil).toBe(later);
  });

  it('forgets after a refused write too, and never serves a list another caller could reorder', async () => {
    const tasks = cachedReads(createEngine(storeDatabase()), () => new Date().toISOString());
    const project = await newProject(tasks);
    await tasks.createTask(project.id, { title: 'Only' }, AGENT);

    const listed = await tasks.listBoard(project.id, { statuses: ['open'] });
    expect(Object.isFrozen(listed)).toBe(true);
    await expect(
      tasks.writeTask(project.id, `${project.prefix}-none`, { expectedVersion: 1, set: { title: 'x' } }, AGENT),
    ).rejects.toThrow();
    expect(await tasks.listBoard(project.id, { statuses: ['open'] })).not.toBe(listed);
  });
});
