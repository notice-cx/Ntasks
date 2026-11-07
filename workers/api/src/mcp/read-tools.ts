/**
 * The MCP tools that read tasks. Their names, arguments, descriptions and
 * result fields are the ones NoticeOS's task tools had, so agents written for
 * those read Ntasks unchanged.
 */
import {
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
import { childView, commentView, historyView, mcpSummary, mcpTask, proposalOf } from '../views.ts';
import { fieldFiltersOf, OPEN_STATUSES } from '../task-writes.ts';
import {
  booleanArg,
  instantArg,
  integerArg,
  only,
  projectArg,
  refuse,
  stringsArg,
  taskArg,
  textArg,
  type Args,
} from '../args.ts';

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

export const PROJECT = Object.freeze({ type: 'string', description: 'The projectId from list_projects.' });
export const TASK = Object.freeze({ type: 'string', description: 'The task id, such as abc-1x2.' });
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
    async run({ engine, principal }, args) {
      only(args, []);
      return {
        projects: reachable(principal, await engine.listProjects()).map((project) => ({
          projectId: project.id,
          key: project.key,
          name: project.name,
          prefix: project.prefix,
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
      project: { ...PROJECT, description: 'The projectId from list_projects; leave it out to list every project.' },
      query: {
        type: 'string',
        maxLength: 512,
        description:
          'Only tasks whose id, title, description, acceptance or labels hold every word of this, ignoring case.',
      },
      status: { type: 'array', items: { type: 'string', enum: TASK_STATUSES }, description: 'Only these statuses.' },
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
      only(args, [
        'project',
        'query',
        'status',
        'ready',
        'assignee',
        'parent',
        'labels',
        'type',
        'created_after',
        'created_before',
        'updated_after',
        'updated_before',
        'closed_days',
        'limit',
        'offset',
        'fields',
      ]);
      const closedDays = integerArg(args, 'closed_days', 1, CLOSED_HISTORY_DAYS, CLOSED_DAYS);
      const limit = integerArg(args, 'limit', 1, TASK_LIMITS.page, PAGE);
      const offset = integerArg(args, 'offset', 0, Number.MAX_SAFE_INTEGER, 0);
      const assignee = textArg(args, 'assignee', TASK_LIMITS.actor, false);
      if (assignee !== undefined && (/[\r\n\t]/u.test(assignee) || assignee.trim() !== assignee))
        refuse('invalid arguments: assignee (a name on one line, or "me")');
      const statuses = args.status === undefined ? TASK_STATUSES : args.status;
      if (
        !Array.isArray(statuses) ||
        statuses.length < 1 ||
        new Set(statuses).size !== statuses.length ||
        statuses.some((status) => !isTaskStatus(status))
      ) {
        refuse('invalid arguments: status');
      }
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
        tasks: page.map((task) => ({ id: task.id, ...where.get(task.projectId), ...summary(task) })),
        nextOffset: nextOf(page.length, found.tasks.length),
      };
    },
  },
  {
    name: 'get_task',
    description: 'Read one task with its comments.',
    inputSchema: schema({ project: PROJECT, task: TASK }, ['project', 'task']),
    annotations: READ,
    scope: 'tasks:read',
    async run(context, args) {
      const { engine, now } = context;
      only(args, ['project', 'task']);
      const project = await projectOf(context, projectArg(args));
      const taskId = taskArg(args);
      const [task, comments, links] = await Promise.all([
        taskOf(context, project, taskId),
        engine.listComments(project.id, taskId),
        linksSeenBy(context),
      ]);
      // An epic's open children, with who works on each, so its holder sees the work under it in one read.
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
        readAt: now(),
        task: mcpTask(links.task(task)),
        ...(children === null ? {} : { openChildren: children.map(childView) }),
        comments: comments.map(commentView),
        proposal: proposalOf(task),
      };
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
      ['project', 'task'],
    ),
    annotations: READ,
    scope: 'tasks:read',
    async run(context, args) {
      const { engine } = context;
      only(args, ['project', 'task', 'limit', 'snapshots']);
      const limit = integerArg(args, 'limit', 1, 200, 50);
      const snapshots = booleanArg(args, 'snapshots') ?? false;
      const project = await projectOf(context, projectArg(args));
      const taskId = taskArg(args);
      const [, events, links] = await Promise.all([
        taskOf(context, project, taskId),
        allEvents(engine, project.id, taskId),
        linksSeenBy(context),
      ]);
      return { changes: historyView(events.map(links.event), limit, snapshots) };
    },
  },
]);

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}
