// The task store from a test: its stub, and its database with each statement
// run inside the object, so tests read and write the storage the Worker uses.
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { Database } from '../src/engine/database.ts';
import { STORE_NAME, type TaskStore } from '../src/store/index.ts';
import { sqliteDatabase, type Meter } from '../src/store/sqlite.ts';

export function store(): DurableObjectStub<TaskStore> {
  return env.TASK_STORE.getByName(STORE_NAME);
}

/** The store's database, counting into `meter` when given. Writes made
 * through it skip the store's read cache; a test that reads through the
 * object writes through the object's own engine instead (store.test.ts). */
export function storeDatabase(meter?: Meter): Database {
  return sqliteDatabase(
    (work) => runInDurableObject(store(), (_instance: TaskStore, state) => work(state.storage)),
    meter,
  );
}
