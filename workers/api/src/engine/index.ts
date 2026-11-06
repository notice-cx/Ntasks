// The task engine: TaskEngine (packages/domain/src/engine.ts) on D1.
import { missingSections, type TaskEngine } from '@ntasks/domain';
import { Reads } from './reads.ts';
import { randomKey, Writes } from './writes.ts';

export interface EngineOptions {
  /** The current time as UTC ISO 8601 text. Tests set it; the Worker leaves it out. */
  readonly now?: () => string;
  /** A new random task key. Tests set it to force an id collision. */
  readonly newKey?: () => string;
}

export function createEngine(db: D1Database, options: EngineOptions = {}): TaskEngine {
  const now = options.now ?? (() => new Date().toISOString());
  const reads = new Reads(db, now);
  const writes = new Writes(db, reads, { now, newKey: options.newKey ?? (() => randomKey()) });
  return {
    listProjects: () => reads.listProjects(),
    createProject: (input) => writes.createProject(input),
    getTask: (projectId, taskId) => reads.getTask(projectId, taskId),
    findTasks: (projectId, taskIds) => reads.findTasks(projectId, taskIds),
    listTasks: (projectId, query) => reads.listTasks(projectId, query),
    listEpics: (projectId) => reads.listEpics(projectId),
    listComments: (projectId, taskId) => reads.listComments(projectId, taskId),
    listHistory: (projectId, taskId, options) => reads.listHistory(projectId, taskId, options.limit, options.beforeSeq),
    listChanges: (query) => reads.listChanges(query.after, query.limit, query.projectId),
    async lint(projectId, taskIds) {
      const tasks = await reads.hydrate(await reads.taskRows(projectId, taskIds));
      const missing = new Map<string, readonly string[]>();
      for (const task of tasks) {
        const sections = missingSections(task);
        if (sections.length > 0) missing.set(task.id, sections);
      }
      return missing;
    },
    createTask: (projectId, input, actor, retry) => writes.createTask(projectId, input, actor, retry),
    writeTask: (projectId, taskId, write, actor, retry) => writes.writeTask(projectId, taskId, write, actor, retry),
    addComment: (projectId, taskId, text, actor, retry) => writes.addComment(projectId, taskId, text, actor, retry),
  };
}
