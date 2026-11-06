/**
 * The task store: one Durable Object that holds every task in its own SQLite
 * database and runs the engine beside it. The Worker signs each request in
 * and hands it here; the object answers it with no network trip per query,
 * and serves repeated reads from memory (cache.ts).
 */
import type { Project, StoreRows, StoreTable, TaskEngine } from '@ntasks/domain';
import { DurableObject } from 'cloudflare:workers';
import { serveApi } from '../api.ts';
import type { Principal } from '../auth.ts';
import { createEngine } from '../engine/index.ts';
import { cachedReads } from './cache.ts';
import { loadRows, readRows, type ImportResult } from './import.ts';
import { migrate } from './schema.ts';
import { newMeter, objectDatabase, type Meter } from './sqlite.ts';

/** The name of the one store an installation keeps. */
export const STORE_NAME = 'tasks';

export class TaskStore extends DurableObject<Env> {
  /** The rows the store's statements have read and written since it started. */
  readonly meter: Meter = newMeter();
  #tasks: TaskEngine;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Synchronous, so it finishes before the object takes any request.
    migrate(ctx.storage);
    this.#tasks = this.#newEngine();
  }

  /** The engine every request uses, with its reads cached. Every write must
   * go through it, or the cache would serve answers from before the write;
   * an import, which writes beside it, replaces it with a new one. */
  get tasks(): TaskEngine {
    return this.#tasks;
  }

  #newEngine(): TaskEngine {
    const now = () => new Date().toISOString();
    return cachedReads(createEngine(objectDatabase(this.ctx.storage, this.meter), { now }), now);
  }

  /** Loads an import from Beads into this store, which must hold no projects
   * or tasks (import.ts). Only the owner may run it. */
  async importRows(rows: StoreRows): Promise<ImportResult> {
    try {
      return loadRows(this.ctx.storage, rows, this.meter);
    } finally {
      // Whether it landed or was refused, no answer cached before it may be served.
      this.#tasks = this.#newEngine();
    }
  }

  /** One table's rows, for verifying an import against the export it came from. Only the owner may read them. */
  async tableRows(table: StoreTable): Promise<Record<string, SqlStorageValue>[]> {
    return readRows(this.ctx.storage, table);
  }

  /** Every project, for parts of the Worker outside the API that name
   * projects, such as sign-in's page where the owner grants an agent some. */
  async projects(): Promise<readonly Project[]> {
    return this.tasks.listProjects();
  }

  /** Answers one API request, sent by `principal`, whom the Worker signed in. */
  async serve(request: Request, principal: Principal): Promise<Response> {
    return serveApi(request, principal, {
      engine: this.tasks,
      workspace: { id: this.env.WORKSPACE_ID, name: this.env.WORKSPACE_NAME },
      now: () => new Date().toISOString(),
    });
  }
}
