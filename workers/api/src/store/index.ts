/**
 * The task store: one Durable Object for each workspace, which holds the
 * workspace's tasks in its own SQLite database and runs the engine beside it.
 * The Worker signs each request in, picks its workspace and hands it to that
 * workspace's store with the sender scoped to it; the object answers it with
 * no network trip per query, and serves repeated reads from memory (cache.ts).
 */
import type {
  BackupRows,
  BackupTable,
  DeliveryMove,
  DeliveryOptions,
  DeliverySignal,
  HeldTask,
  Project,
  Task,
  TaskEngine,
} from '@ntasks/domain';
import { DurableObject } from 'cloudflare:workers';
import { serveApi } from '../api.ts';
import type { Principal } from '../auth.ts';
import { reportDelivery } from '../delivery.ts';
import { createEngine } from '../engine/index.ts';
import { checkGitHubWork } from '../github-check.ts';
import { heldBy, runTaskTool, type ToolAnswer } from '../mcp/server.ts';
import { Refused } from '../refused.ts';
import { closeMerged, type MergeCloses } from '../task-writes.ts';
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

/** How long after a close with a pull request, or a delivery that moved a task, the store asks GitHub about waiting work: a few in a row share one check. */
const CHECK_DELAY_MS = 5_000;

/** Whether a task waits for a merge of a pull request, which GitHub may already have made. */
function waitsOnPullRequest(task: Task): boolean {
  return task.delivery?.stage === 'built' && task.delivery.pullRequest !== null;
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
    const engine = cachedReads(createEngine(objectDatabase(this.ctx.storage, this.meter), { now }), now);
    // A close as done with a pull request: GitHub may have merged it before the close.
    const checked = async <R extends { readonly task: Task }>(result: R): Promise<R> => {
      if (waitsOnPullRequest(result.task)) await this.#checkGitHubIn(CHECK_DELAY_MS);
      return result;
    };
    return Object.freeze({
      ...engine,
      createTask: async (...args: Parameters<TaskEngine['createTask']>) => checked(await engine.createTask(...args)),
      writeTask: async (...args: Parameters<TaskEngine['writeTask']>) => checked(await engine.writeTask(...args)),
    } satisfies TaskEngine);
  }

  /** Sets the alarm that asks GitHub about waiting work `delay` milliseconds from now, unless one is set sooner. */
  async #checkGitHubIn(delay: number): Promise<void> {
    const at = Date.now() + delay;
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > at) await this.ctx.storage.setAlarm(at);
  }

  /** Asks GitHub about the workspace's waiting work now, as when an owner installs the workspace's GitHub App (github.ts). */
  async checkGitHub(): Promise<void> {
    await this.#checkGitHubIn(0);
  }

  /** The alarm: asks GitHub whether the pull requests of work waiting for a merge merged, and whether merged work deployed (github-check.ts). */
  override async alarm(): Promise<void> {
    const name = this.ctx.id.name;
    if (name === undefined || !name.startsWith('workspace:')) return;
    await checkGitHubWork(this.env, name.slice('workspace:'.length), this.tasks);
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

  /** Answers a signal GitHub sent, for `principal`, the workspace's GitHub
   * webhook once the Worker checked a delivery's signature (github.ts): a
   * merge first closes the tasks in progress whose work names its pull
   * request (closeMerged), which only GitHub's own word does; then the
   * closed tasks it names move. A move has the store ask GitHub a few
   * seconds later about merged work a deploy shipped that no delivery named.
   * Names the projects `options` turned on as deploying. A refusal comes
   * back as its sentence, since an error's class does not survive the call
   * from the Worker. */
  async deliver(
    signal: DeliverySignal,
    principal: Principal,
    options?: DeliveryOptions,
  ): Promise<
    | ({ readonly moved: readonly DeliveryMove[]; readonly turnedOn: readonly string[] } & MergeCloses)
    | { readonly refused: string }
  > {
    try {
      const deployed = async () =>
        new Set((await this.tasks.listProjects()).filter((project) => project.deploys).map((project) => project.id));
      const before = options?.turnOnDeploys === undefined ? null : await deployed();
      const context = { engine: this.tasks, principal, now: () => new Date().toISOString() };
      const closes = await closeMerged(context, signal);
      const moved = await reportDelivery(context, signal, undefined, options);
      // A merge may have deployed before its event came, and a deploy may ship earlier merges than the one it names.
      if (moved.length > 0) await this.#checkGitHubIn(CHECK_DELAY_MS);
      const after = before === null ? null : await deployed();
      return { moved, turnedOn: after === null ? [] : [...after].filter((id) => !before?.has(id)), ...closes };
    } catch (error) {
      if (error instanceof Refused) return { refused: error.detail };
      throw error;
    }
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
