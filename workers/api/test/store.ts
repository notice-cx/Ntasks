// The task store from a test: its stub, and its database with each statement
// run inside the object, so tests read and write the storage the Worker uses.
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { Database } from '../src/engine/database.ts';
import { workspaceStore, type TaskStore } from '../src/store/index.ts';
import { sqliteDatabase, type Meter } from '../src/store/sqlite.ts';
import type { Workspace } from '../src/workspaces.ts';

/** The workspace most tests work in. A person who signs in through
 * test/access/client.ts becomes its owner. */
export const TEST_WORKSPACE: Workspace = Object.freeze({
  id: '7c1e5a90-3b2d-4f6e-9a18-2d4c6b8e0f13',
  name: 'Test workspace',
});

/** The task store of `workspaceId`, the test workspace's by default. */
export function store(workspaceId = TEST_WORKSPACE.id): DurableObjectStub<TaskStore> {
  return workspaceStore(env, workspaceId);
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
