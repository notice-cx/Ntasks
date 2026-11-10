// The task engine: TaskEngine (packages/domain/src/engine.ts) over any
// Database (database.ts); the task store runs it on its own SQLite storage.
import { missingSections, type TaskEngine } from '@ntasks/domain';
import type { Database } from './database.ts';
import { Reads } from './reads.ts';
import { toTask } from './rows.ts';
import { randomKey, Writes } from './writes.ts';

export interface EngineOptions {
  /** The current time as UTC ISO 8601 text. Tests set it; the Worker leaves it out. */
  readonly now?: () => string;
  /** A new random task key. Tests set it to force an id collision. */
  readonly newKey?: () => string;
}

export function createEngine(db: Database, options: EngineOptions = {}): TaskEngine {
  const now = options.now ?? (() => new Date().toISOString());
  const reads = new Reads(db, now);
  const writes = new Writes(db, reads, { now, newKey: options.newKey ?? (() => randomKey()) });
  return {
    listProjects: () => reads.listProjects(),
    createProject: (input) => writes.createProject(input),
    setProjectDeploys: (projectId, deploys) => writes.setProjectDeploys(projectId, deploys),
    getTask: (projectId, taskId) => reads.getTask(projectId, taskId),
    getTasks: (projectId, taskIds) => reads.getTasks(projectId, taskIds),
    listWork: (projectIds, closedSince) => reads.listWork(projectIds, closedSince),
    listWins: (projectIds, from, to, closedSince) => reads.listWins(projectIds, from, to, closedSince),
    listHeld: (assignee) => reads.listHeld(assignee),
    findTasks: (projectId, taskIds) => reads.findTasks(projectId, taskIds),
    listTasks: (projectId, query) => reads.listTasks(projectId, query),
    listBoard: (projectId, query) => reads.listBoard(projectId, query),
    listLabelled: (projectId, query) => reads.listLabelled(projectId, query),
    listExternalLinks: (taskIds) => reads.listExternalLinks(taskIds),
    listFields: (projectId) => reads.listFields(projectId),
    defineField: (projectId, input, actor, retry) => writes.defineField(projectId, input, actor, retry),
    retireField: (projectId, key, actor, retry) => writes.retireField(projectId, key, actor, retry),
    listEpics: (projectId) => reads.listEpics(projectId),
    nextDeferralAfter: (time) => reads.nextDeferralAfter(time),
    listComments: (projectId, taskId) => reads.listComments(projectId, taskId),
    listHistory: (projectId, taskId, options) => reads.listHistory(projectId, taskId, options.limit, options.beforeSeq),
    latestChange: () => reads.latestChange(),
    listChanges: (query) => reads.listChanges(query.after, query.limit, query.projectId),
    async lint(projectId, taskIds) {
      const tasks = (await reads.taskRows(projectId, taskIds)).map(toTask);
      const missing = new Map<string, readonly string[]>();
      for (const task of tasks) {
        const sections = missingSections(task);
        if (sections.length > 0) missing.set(task.id, sections);
      }
      return missing;
    },
    recordedWrite: (projectId, retry) => writes.recordedWrite(projectId, retry),
    recordUnchanged: (projectId, taskId, expectedVersion, retry) =>
      writes.recordUnchanged(projectId, taskId, expectedVersion, retry),
    createTask: (projectId, input, actor, retry) => writes.createTask(projectId, input, actor, retry),
    writeTask: (projectId, taskId, write, actor, retry) => writes.writeTask(projectId, taskId, write, actor, retry),
    addComment: (projectId, taskId, text, actor, retry) => writes.addComment(projectId, taskId, text, actor, retry),
    reportDelivery: (projectIds, signal, actor, options) => writes.reportDelivery(projectIds, signal, actor, options),
  };
}
