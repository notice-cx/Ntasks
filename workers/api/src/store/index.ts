/**
 * The task store: one Durable Object for each workspace, which holds the
 * workspace's tasks in its own SQLite database and runs the engine beside it.
 * The Worker signs each request in, picks its workspace and hands it to that
 * workspace's store with the sender scoped to it; the object answers it with
 * no network trip per query, and serves repeated reads from memory (cache.ts).
 */
import type { BackupRows, BackupTable, HeldTask, Project, TaskEngine } from '@ntasks/domain';
import { DurableObject } from 'cloudflare:workers';
import { serveApi } from '../api.ts';
import type { Principal } from '../auth.ts';
import { createEngine } from '../engine/index.ts';
import { heldBy, runTaskTool, type ToolAnswer } from '../mcp/server.ts';
import { storeName, type Workspace } from '../workspaces.ts';
import { readBackupPage, type BackupAnswer } from './backup.ts';
import { cachedReads } from './cache.ts';
import { abortLoad, beginLoad, commitLoad, stageRows, type LoadAnswer } from './load.ts';
import { loadRows, readRows, type ImportResult } from './import.ts';
import { migrate } from './schema.ts';
import { newMeter, objectDatabase, type Meter } from './sqlite.ts';

/** The bindings a workspace's store is reached through. */
export interface StoreBinding {
  readonly TASK_STORE: DurableObjectNamespace<TaskStore>;
}

/** The task store of one workspace. Workspaces never share a store. */
export function workspaceStore(env: StoreBinding, workspaceId: string): DurableObjectStub<TaskStore> {
  return env.TASK_STORE.getByName(storeName(workspaceId));
}

export class TaskStore extends DurableObject<Env> {
  /** The rows the store's statements have read and written since it started. */
  readonly meter: Meter = newMeter();
  /** Names this run of the object, which a backup's pages must all come from (backup.ts). */
  readonly #run = crypto.randomUUID();
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

  /** Loads an import from Beads, or a backup, into this store, which must
   * hold no projects or tasks (import.ts). No route reaches it. */
  async importRows(rows: BackupRows): Promise<ImportResult> {
    try {
      return loadRows(this.ctx.storage, rows, this.meter);
    } finally {
      // Whether it landed or was refused, no answer cached before it may be served.
      this.#tasks = this.#newEngine();
    }
  }

  /** One table's rows, for verifying an import against the export it came from. No route reaches it. */
  async tableRows(table: BackupTable): Promise<Record<string, SqlStorageValue>[]> {
    return readRows(this.ctx.storage, table);
  }

  /** One page of a backup of the whole store (backup.ts): the first when
   * `token` is null. Only senders with the backup scope reach it. */
  async backupPage(token: string | null): Promise<BackupAnswer> {
    return readBackupPage(this.ctx.storage, this.#run, token, () => new Date().toISOString());
  }

  /** Begins a load into this store, which must be empty (load.ts). Only
   * senders with the restore scope reach it. */
  async loadBegin(migrations: unknown, by: string): Promise<LoadAnswer<{ readonly load: string }>> {
    return beginLoad(this.ctx.storage, migrations, by, () => new Date().toISOString());
  }

  /** Adds a page of rows to the waiting load. */
  async loadRows(load: unknown, table: unknown, rows: unknown): Promise<ReturnType<typeof stageRows>> {
    return stageRows(this.ctx.storage, load, table, rows);
  }

  /** Writes the waiting load's rows in one transaction. */
  async loadCommit(load: unknown, counts: unknown): Promise<ReturnType<typeof commitLoad>> {
    try {
      return commitLoad(this.ctx.storage, load, counts, this.meter);
    } finally {
      // Whether it landed or was refused, no answer cached before it may be served.
      this.#tasks = this.#newEngine();
    }
  }

  /** Drops the waiting load. */
  async loadAbort(load: unknown): Promise<ReturnType<typeof abortLoad>> {
    return abortLoad(this.ctx.storage, load);
  }

  /** Every project, for parts of the Worker outside the API that name
   * projects, such as sign-in's page where a person grants an agent some. */
  async projects(): Promise<readonly Project[]> {
    return this.tasks.listProjects();
  }

  /** Runs one MCP task tool for `principal`, whom the Worker signed in and
   * scoped to `workspace`, this store's. `args` no longer holds the workspace. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    principal: Principal,
    workspace: Workspace,
  ): Promise<ToolAnswer> {
    return runTaskTool({ engine: this.tasks, workspace, principal, now: () => new Date().toISOString() }, name, args);
  }

  /** The open tasks `principal` holds in the projects it reads here, which
   * the MCP endpoint lists when an agent connects. */
  async heldTasks(principal: Principal): Promise<readonly HeldTask[]> {
    return heldBy({ engine: this.tasks, principal });
  }

  /** Answers one HTTP API request, sent by `principal`, whom the Worker signed in and scoped to this store's workspace. */
  async serve(request: Request, principal: Principal): Promise<Response> {
    return serveApi(request, principal, {
      engine: this.tasks,
      now: () => new Date().toISOString(),
      backup: (token) => this.backupPage(token),
      load: {
        begin: (migrations, by) => this.loadBegin(migrations, by),
        rows: (load, table, rows) => this.loadRows(load, table, rows),
        commit: (load, counts) => this.loadCommit(load, counts),
        abort: (load) => this.loadAbort(load),
      },
    });
  }
}
