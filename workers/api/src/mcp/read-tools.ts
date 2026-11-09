/**
 * The MCP tools that read tasks. Their names, arguments and result fields are
 * the ones NoticeOS's task tools had, with fewer arguments required, so
 * agents written for those read Ntasks unchanged. Each tool's input schema
 * lists the arguments it takes: the server refuses any other before the tool
 * runs (server.ts).
 */
import {
  DELIVERY_STAGES,
  isTaskStatus,
  isTaskType,
  TASK_LIMITS,
  TASK_STATUSES,
  type Task,
  type TaskEngine,
  type TaskStatus,
  type TaskType,
} from '@ntasks/domain';
import { reachable, type Principal } from '../auth.ts';
import { linksSeenBy, projectOf, taskOf } from '../lookup.ts';
import { allEvents, board, CLOSED_DAYS, CLOSED_HISTORY_DAYS, withExternalLinks } from '../service.ts';
import type { Workspace } from '../workspaces.ts';
import {
  childView,
  commentView,
  historyView,
  mcpSummary,
  mcpTask,
  parentView,
  proposalOf,
  proposalVersionOf,
} from '../views.ts';
import { fieldFiltersOf, OPEN_STATUSES } from '../task-writes.ts';
import {
  booleanArg,
  choiceArg,
  instantArg,
  integerArg,
  projectArg,
  refuse,
  stringsArg,
  taskArg,
  textArg,
  type Args,
} from '../args.ts';
import { Refused } from '../refused.ts';
import { projectFor } from './project.ts';

export interface ToolContext {
  readonly engine: TaskEngine;
  readonly workspace: Workspace;
  readonly principal: Principal;
  readonly now: () => string;
}

export interface TaskTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: Readonly<Record<string, unknown>>;
  /** The scope a sender needs to call it. */
  readonly scope: string;
  run(context: ToolContext, args: Args): Promise<unknown>;
}

export const READ = Object.freeze({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });

export const PROJECT = Object.freeze({
  type: 'string',
  description:
    "The projectId, key or prefix from list_projects. A call that names a task may leave it out: the task id's prefix names its project.",
});
export const TASK = Object.freeze({ type: 'string', description: 'The task id, such as abc-1x2.' });
/** The answer for a task of a batched get_task whose read failed for a reason no refusal names. */
const UNREAD = 'unavailable: the task store did not answer this read; read the task again.';

/** The most tasks one get_task, comment_on_task or close_task call names in `tasks`. */
export const MANY = 50;
/** Several task ids in place of `task`, for a call that acts on each. */
export const TASKS = (verb: string) =>
  Object.freeze({
    type: 'array',
    minItems: 1,
    maxItems: MANY,
    items: { type: 'string' },
    description: `Up to ${MANY} task ids to ${verb}, in place of task. The answer has a result per task: one refused does not stop the rest.`,
  });
/** The most tasks one list_tasks call returns when it names no limit. */
const PAGE = 50;

export function schema(properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const READ_TOOLS: readonly TaskTool[] = Object.freeze([
  {
    name: 'list_projects',
    description: 'List the task projects in this workspace.',
    inputSchema: schema({}),
    annotations: READ,
    scope: 'tasks:read',
    async run({ engine, principal }) {
      return {
        projects: reachable(principal, await engine.listProjects()).map((project) => ({
          projectId: project.id,
          key: project.key,
          name: project.name,
          prefix: project.prefix,
          deploys: project.deploys,
        })),
      };
    },
  },
  {
    name: 'list_tasks',
    description:
      'List tasks, most urgent first: every open one and those closed in the last 7 days, in one project or, ' +
      'with no project, in every project of the workspace, each then naming its project. ' +
      'Each is a summary, leaving out fields with no value; get_task reads one in full. Filters narrow it live, so search here ' +
      'rather than keeping a copy. Answers a page at a time: pass nextOffset as offset for the next.',
    inputSchema: schema({
      project: {
        ...PROJECT,
        description: 'The projectId, key or prefix from list_projects; leave it out to list every project.',
      },
      query: {
        type: 'string',
        maxLength: 512,
        description:
          'Only tasks whose id, title, description, acceptance or labels hold every word of this, ignoring case.',
      },
      status: { type: 'array', items: { type: 'string', enum: TASK_STATUSES }, description: 'Only these statuses.' },
      stage: {
        type: 'string',
        enum: DELIVERY_STAGES,
        description:
          "Only closed tasks whose change is at this stage: built (not merged yet), merged or live. Reads every one, whenever it closed, unless closed_days is given. The answer's stages counts the tasks at each stage.",
      },
      ready: { type: 'boolean', description: 'Only tasks with nothing blocking them.' },
      assignee: {
        type: 'string',
        maxLength: TASK_LIMITS.actor,
        description: 'Only tasks assigned to this name; "me" for the tasks you hold.',
      },
      parent: { type: 'string', description: 'Only the direct children of this task.' },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only tasks carrying every one of these labels.',
      },
      type: { type: 'array', items: { type: 'string' }, description: 'Only these types, such as decision or gate.' },
      created_after: { type: 'string', description: 'Only tasks created at or after this: YYYY-MM-DD or an ISO time.' },
      created_before: { type: 'string', description: 'Only tasks created before this.' },
      updated_after: { type: 'string', description: 'Only tasks changed at or after this.' },
      updated_before: { type: 'string', description: 'Only tasks last changed before this.' },
      closed_days: {
        type: 'integer',
        minimum: 1,
        maximum: CLOSED_HISTORY_DAYS,
        description: `Read closed tasks from this many days (default ${CLOSED_DAYS}, at most ${CLOSED_HISTORY_DAYS}), for historical gate audits.`,
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: TASK_LIMITS.page,
        description: `At most this many (default ${PAGE}).`,
      },
      offset: { type: 'integer', minimum: 0, description: "Skip this many, from the previous answer's nextOffset." },
      fields: {
        type: 'object',
        maxProperties: TASK_LIMITS.fields,
        additionalProperties: { type: ['string', 'number', 'boolean'] },
        description:
          "Only tasks whose custom fields hold these values, by key, as list_fields lists the project's fields; " +
          'for a multiple-choice field, an option the task has. Needs project.',
      },
    }),
    annotations: READ,
    scope: 'tasks:read',
    async run(context, args) {
      const { engine, principal, now } = context;
      const stage = choiceArg(args, 'stage', DELIVERY_STAGES);
      // A stage reads every task at it, unless a close window is asked for.
      const closedDays =
        stage !== undefined && args.closed_days === undefined
          ? null
          : integerArg(args, 'closed_days', 1, CLOSED_HISTORY_DAYS, CLOSED_DAYS);
      const limit = integerArg(args, 'limit', 1, TASK_LIMITS.page, PAGE);
      const offset = integerArg(args, 'offset', 0, Number.MAX_SAFE_INTEGER, 0);
      const assignee = textArg(args, 'assignee', TASK_LIMITS.actor, false);
      if (assignee !== undefined && (/[\r\n\t]/u.test(assignee) || assignee.trim() !== assignee))
        refuse('invalid arguments: assignee (a name on one line, or "me")');
      const asked = args.status === undefined ? TASK_STATUSES : args.status;
      if (
        !Array.isArray(asked) ||
        asked.length < 1 ||
        new Set(asked).size !== asked.length ||
        asked.some((status) => !isTaskStatus(status))
      ) {
        refuse('invalid arguments: status');
      }
      if (stage !== undefined && !asked.includes('closed'))
        refuse("invalid arguments: status (a stage is a closed task's: include closed, or leave status out)");
      const statuses = stage === undefined ? asked : ['closed'];
      // Closed tasks are counted by stage when the call asks for them by status or by stage.
      const counted = stage !== undefined || (args.status !== undefined && asked.includes('closed'));
      const stageCounts = (tasks: readonly Task[]) =>
        counted
          ? {
              stages: Object.fromEntries(
                DELIVERY_STAGES.map((name) => [name, tasks.filter((task) => task.delivery?.stage === name).length]),
              ),
            }
          : {};
      const ready = booleanArg(args, 'ready');
      const query = textArg(args, 'query', 512, false, true);
      const filters = {
        ...(query === undefined ? {} : { words: query.toLowerCase().split(/\s+/u).filter(Boolean) }),
        ...(ready === true ? { ready: true } : {}),
        ...(args.parent === undefined ? {} : { parentId: taskArg(args, 'parent') }),
        ...(assignee === undefined ? {} : { assignee: assignee === 'me' ? principal.name : assignee }),
        ...(args.labels === undefined ? {} : { labels: stringsArg(args, 'labels') }),
        ...(args.type === undefined ? {} : { types: stringsArg(args, 'type') as TaskType[] }),
        ...optional('createdAfter', instantArg(args, 'created_after')),
        ...optional('createdBefore', instantArg(args, 'created_before')),
        ...optional('updatedAfter', instantArg(args, 'updated_after')),
        ...optional('updatedBefore', instantArg(args, 'updated_before')),
        ...(stage === undefined ? {} : { stages: [stage] }),
        // A page reads its own tasks' links after the board, not every matching task's.
        withoutExternalLinks: true as const,
      };
      if (filters.types?.some((type) => !isTaskType(type))) refuse('invalid arguments: type');
      const nextOf = (shown: number, total: number) => (offset + shown < total ? offset + shown : null);
      const links = await linksSeenBy(context);
      const summary = (task: Task) => mcpSummary(links.task(task));
      if (args.project !== undefined) {
        const project = await projectOf(context, projectArg(args));
        const fields =
          args.fields === undefined ? undefined : await fieldFiltersOf(context, project, args.fields, 'fields.');
        const found = await board(
          engine,
          project.id,
          statuses as TaskStatus[],
          closedDays,
          fields === undefined ? filters : { ...filters, fields },
          now,
        );
        const page = await withExternalLinks(engine, found.tasks.slice(offset, offset + limit));
        return {
          project: project.key,
          readAt: found.readAt,
          closedSince: found.closedSince,
          total: found.tasks.length,
          ...stageCounts(found.tasks),
          tasks: page.map(summary),
          nextOffset: nextOf(page.length, found.tasks.length),
        };
      }
      if (args.fields !== undefined)
        refuse('invalid arguments: fields (name a project: each project defines its own fields)');
      // Every project in one read, each task then naming its project.
      const [projects, everything] = await Promise.all([
        engine.listProjects(),
        board(engine, null, statuses as TaskStatus[], closedDays, filters, now),
      ]);
      const reached = new Set(reachable(principal, projects).map((project) => project.id));
      const found = { ...everything, tasks: everything.tasks.filter((task) => reached.has(task.projectId)) };
      const where = new Map(
        projects.map((project) => [
          project.id,
          { project: project.key, projectId: project.id, projectName: project.name },
        ]),
      );
      const page = await withExternalLinks(engine, found.tasks.slice(offset, offset + limit));
      return {
        readAt: found.readAt,
        closedSince: found.closedSince,
        total: found.tasks.length,
        ...stageCounts(found.tasks),
        tasks: page.map((task) => ({ id: task.id, ...where.get(task.projectId), ...summary(task) })),
        nextOffset: nextOf(page.length, found.tasks.length),
      };
    },
  },
  {
    name: 'get_task',
    description:
      `Read one task with its comments, or up to ${MANY} with tasks. ` +
      "One task in an epic also shows parent: the epic's pinned comments, facts its other tasks left for this one, " +
      'and its most recently closed tasks, each with its close reason and proof.',
    inputSchema: schema({ project: PROJECT, task: TASK, tasks: TASKS('read') }),
    annotations: READ,
    scope: 'tasks:read',
    async run(context, args) {
      if (args.task !== undefined && args.tasks !== undefined)
        refuse('invalid arguments: task and tasks (name one task with task, or several with tasks)');
      if (args.tasks === undefined)
        return { ...(await oneTask(context, args, taskArg(args), true)), readAt: context.now() };
      const value = args.tasks;
      if (!Array.isArray(value) || value.length < 1 || value.length > MANY)
        refuse(`invalid arguments: tasks (1–${MANY} task ids)`);
      const ids = [
        ...new Set(value.map((id: unknown, index) => taskArg({ [`tasks[${index}]`]: id }, `tasks[${index}]`))),
      ];
      // Each task is answered on its own: a read that fails leaves the others' answers.
      const tasks = await Promise.all(
        ids.map(async (id) => {
          try {
            return await oneTask(context, args, id, false);
          } catch (error) {
            if (error instanceof Refused) return { id, error: error.message };
            // A fault's message can carry storage internals: only the tool's name is logged.
            console.error('get_task read failed');
            return { id, error: UNREAD };
          }
        }),
      );
      return { readAt: context.now(), tasks };
    },
  },
  {
    name: 'get_task_history',
    description:
      'Read changed fields, old/new values, recorded actors and actions, newest first. Unmatched audit events have no revision; unknown models remain null. Set snapshots for full task versions.',
    inputSchema: schema(
      {
        project: PROJECT,
        task: TASK,
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'At most this many changes (default 50).' },
        snapshots: {
          type: 'boolean',
          description: 'Include full task snapshots instead of compact field changes (default false).',
        },
      },
      ['task'],
    ),
    annotations: READ,
    scope: 'tasks:read',
    async run(context, args) {
      const { engine } = context;
      const limit = integerArg(args, 'limit', 1, 200, 50);
      const snapshots = booleanArg(args, 'snapshots') ?? false;
      const taskId = taskArg(args);
      const project = await projectOf(context, await projectFor(context, args, taskId));
      const [, events, links] = await Promise.all([
        taskOf(context, project, taskId),
        allEvents(engine, project.id, taskId),
        linksSeenBy(context),
      ]);
      return { changes: historyView(events.map(links.event), limit, snapshots) };
    },
  },
]);

/** One task as get_task reads it: in full, with its comments, the proposal an
 * answer is checked against and, for an epic, its open children with who
 * works on each. Read alone, a task with a parent also shows what the parent
 * holds for it; a read of many leaves that out, so siblings read together do
 * not repeat their parent's. */
async function oneTask(context: ToolContext, args: Args, taskId: string, alone: boolean) {
  const { engine } = context;
  const project = await projectOf(context, await projectFor(context, args, taskId));
  const [task, comments, links, parent] = await Promise.all([
    taskOf(context, project, taskId),
    engine.listComments(project.id, taskId),
    linksSeenBy(context),
    alone ? engine.parentContext(project.id, taskId) : null,
  ]);
  const children =
    task.type === 'epic'
      ? await engine.listBoard(project.id, {
          statuses: OPEN_STATUSES,
          parentId: task.id,
          withoutExternalLinks: true,
        })
      : null;
  return {
    project: project.key,
    task: mcpTask(links.task(task)),
    ...(parent === null ? {} : { parent: parentView(parent) }),
    ...(children === null ? {} : { openChildren: children.map(childView) }),
    comments: comments.map(commentView),
    proposal: proposalOf(task),
    proposalVersion: await proposalVersionOf(task),
  };
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}
