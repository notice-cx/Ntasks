/**
 * The task store: one Durable Object that holds every task in its own SQLite
 * database and runs the engine beside it. The Worker signs each request in
 * and hands it here; the object answers it with no network trip per query,
 * and serves repeated reads from memory (cache.ts).
 */
import type { Project, TaskEngine } from '@ntasks/domain';
import { DurableObject } from 'cloudflare:workers';
import { serveApi } from '../api.ts';
import type { Principal } from '../auth.ts';
import { createEngine } from '../engine/index.ts';
import { cachedReads } from './cache.ts';
import { migrate } from './schema.ts';
import { newMeter, objectDatabase, type Meter } from './sqlite.ts';

/** The name of the one store an installation keeps. */
export const STORE_NAME = 'tasks';

export class TaskStore extends DurableObject<Env> {
  /** The rows the store's statements have read and written since it started. */
  readonly meter: Meter = newMeter();
  /** The engine every request uses, with its reads cached. Every write must
   * go through it, or the cache would serve answers from before the write. */
  readonly tasks: TaskEngine;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Synchronous, so it finishes before the object takes any request.
    migrate(ctx.storage);
    const now = () => new Date().toISOString();
    this.tasks = cachedReads(createEngine(objectDatabase(ctx.storage, this.meter), { now }), now);
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
