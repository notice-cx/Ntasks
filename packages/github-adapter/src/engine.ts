/**
 * The protocol's core level over GitHub issues. GitHub holds each task as an
 * issue: its title, description, labels, open or closed state and the
 * comments people read. The ledger holds what GitHub cannot: holders,
 * statuses beyond open and closed, versions, links, closes and their proof,
 * history with each change's actor and model, and retry keys. Every write
 * runs one at a time, checks its rules against the ledger, makes its GitHub
 * calls, then commits the ledger, so a write GitHub refuses leaves nothing
 * behind in the ledger.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Access, AdapterConfig, ProjectConfig, SenderKind } from './config.ts';
import { GitHub, labelName, type Issue } from './github.ts';
import type { HistoryRecord, Ledger, LedgerData, LinkRecord, LinkType, TaskRecord } from './ledger.ts';
import { invalid, refuse, Refused } from './refused.ts';

export interface Sender {
  readonly id: string;
  readonly kind: SenderKind;
  /** The name changes are recorded under (protocol.md 3.1). */
  readonly actor: string;
  readonly projects: ReadonlyMap<string, Access>;
}

export const STATUSES = ['open', 'in_progress', 'blocked', 'deferred', 'closed'] as const;
export const TYPES = ['task', 'bug', 'feature', 'chore', 'epic', 'decision', 'gate'] as const;
export const RESOLUTIONS = ['done', 'wont-do', 'duplicate', 'cant-reproduce', 'already-handled', 'no-longer-needed'];
export const LINK_TYPES: readonly LinkType[] = [
  'blocks',
  'related',
  'discovered-from',
  'duplicates',
  'supersedes',
  'merges-after',
];
/** The link types that may join tasks of two projects; the rest stay inside one. */
const ACROSS_PROJECTS: readonly LinkType[] = ['related', 'duplicates', 'supersedes', 'merges-after'];
const PROOF_TYPES = ['task', 'bug', 'feature', 'chore'];
/** The actor the adapter records the changes it makes on its own under, such as an epic it closes (protocol.md STATE-22). */
export const OWN_ACTOR = 'service:github-adapter';
/** The closes after which an epic whose tasks all closed so is no longer needed, rather than done. */
const NOTHING_NEEDED = ['wont-do', 'no-longer-needed'];
const closedLast = (child: string) => `Every task under this epic is closed; ${child} closed last.`;
const WORK = ['session', 'worktree', 'branch', 'pr', 'commit', 'next'] as const;
const HEX = /^[0-9a-f]{7,64}$/u;

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

/** A write's answer, and the version each task it changed has after it. */
interface Done {
  readonly answer: Record<string, unknown>;
  readonly tasks: Record<string, number>;
}

export class Engine {
  private readonly config: AdapterConfig;
  private readonly github: GitHub;
  private readonly ledger: Ledger;
  private readonly now: () => string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(config: AdapterConfig, github: GitHub, ledger: Ledger, now = () => new Date().toISOString()) {
    this.config = config;
    this.github = github;
    this.ledger = ledger;
    this.now = now;
  }

  // ─── Reach ────────────────────────────────────────────────────────────────

  projects(sender: Sender): ProjectConfig[] {
    return this.config.projects.filter((project) => sender.projects.has(project.projectId));
  }

  private project(sender: Sender, ref: unknown, need: Access): ProjectConfig {
    const reached = this.projects(sender);
    if (ref === undefined) {
      const writable = reached.filter((project) => sender.projects.get(project.projectId) === 'write');
      if (need === 'write' && writable.length === 1) return writable[0]!;
      return invalid(`project (required: name one of ${reached.map((project) => project.key).join(', ')})`);
    }
    const project = reached.find((each) => [each.projectId, each.key, each.prefix].includes(String(ref)));
    if (!project) return refuse(`project ${String(ref)} names no project you reach; list_projects lists yours.`);
    if (need === 'write' && sender.projects.get(project.projectId) !== 'write')
      return refuse(`project ${project.key} is granted to you for reading only.`);
    return project;
  }

  /** The project and record or issue a task id names, refused alike whether it does not exist or the sender cannot reach it. */
  private async locate(
    sender: Sender,
    id: string,
    need: Access,
    data: LedgerData = this.ledger.data,
  ): Promise<{ project: ProjectConfig; record: TaskRecord | null; issue: Issue | null }> {
    const missing = () => refuse(`${id} names no task you can reach; list_tasks lists the ones you can.`);
    const prefix = id.slice(0, id.indexOf('-'));
    const project = this.config.projects.find((each) => each.prefix === prefix);
    if (!project || !sender.projects.has(project.projectId)) return missing();
    const record = data.tasks[id] ?? null;
    let issue: Issue | null = null;
    if (record === null) {
      // Only the issue number as GitHub writes it, so `web-01` or `web-1e0` never names issue 1 a second time.
      const key = id.slice(id.indexOf('-') + 1);
      if (!/^[1-9][0-9]*$/u.test(key)) return missing();
      const number = Number(key);
      issue = await this.github.getIssue(project.repository, number);
      if (issue === null || (project.label !== undefined && !issue.labels.map(labelName).includes(project.label)))
        return missing();
    }
    if (need === 'write' && sender.projects.get(project.projectId) !== 'write')
      return refuse(`project ${project.key} is granted to you for reading only.`);
    return { project, record, issue };
  }

  private canReach(sender: Sender, id: string): boolean {
    const project = this.config.projects.find((each) => each.prefix === id.slice(0, id.indexOf('-')));
    return project !== undefined && sender.projects.has(project.projectId);
  }

  // ─── Views ────────────────────────────────────────────────────────────────

  private statusOf(data: LedgerData, id: string): string {
    return data.tasks[id]?.status ?? 'open';
  }

  private deferred(record: TaskRecord): boolean {
    return record.status === 'deferred' || (record.deferUntil !== null && record.deferUntil > this.now().slice(0, 10));
  }

  private waitsOnOpen(data: LedgerData, id: string): boolean {
    return data.links.some(
      (link) => link.from === id && link.type === 'blocks' && this.statusOf(data, link.to) !== 'closed',
    );
  }

  /** Whether the task can be started now (protocol.md STATE-3). */
  private ready(data: LedgerData, record: TaskRecord): boolean {
    if (record.status !== 'open' || record.type === 'gate' || this.deferred(record)) return false;
    if (this.waitsOnOpen(data, record.id)) return false;
    const seen = new Set<string>();
    for (let parent = record.parent; parent !== null && !seen.has(parent);) {
      seen.add(parent);
      const above = data.tasks[parent];
      if (!above) break;
      if (this.deferred(above) || (above.status !== 'closed' && this.waitsOnOpen(data, above.id))) return false;
      parent = above.parent;
    }
    return true;
  }

  private delivery(record: TaskRecord) {
    if (record.status !== 'closed' || (record.closeCommit === null && record.closePullRequest === null)) return null;
    return {
      stage: 'built',
      commit: record.closeCommit,
      pullRequest: record.closePullRequest,
      mergeCommit: null,
      builtAt: record.closedAt,
      mergedAt: null,
      liveAt: null,
    };
  }

  private view(sender: Sender, data: LedgerData, record: TaskRecord, commentCount: number) {
    const proofless =
      record.status === 'closed' &&
      record.resolution === 'done' &&
      PROOF_TYPES.includes(record.type) &&
      record.closeLink === null &&
      record.closeCommit === null &&
      record.closePullRequest === null;
    return {
      id: record.id,
      title: record.title,
      status: record.status,
      priority: record.priority,
      type: record.type,
      labels: record.labels,
      parent: record.parent,
      description: record.description,
      acceptance: record.acceptance,
      notes: record.notes,
      design: record.design,
      estimateMinutes: null,
      ready: this.ready(data, record),
      awaitingHuman: record.status !== 'closed' && record.labels.includes('human'),
      assignee: record.assignee,
      for: record.for,
      work: record.work,
      lastActivityAt: record.lastActivityAt,
      choices: null,
      choice: null,
      answer: null,
      deferUntil: record.deferUntil,
      dependencies: data.links
        .filter((link) => link.from === record.id && this.canReach(sender, link.to))
        .map((link) => ({
          id: link.to,
          type: link.type,
          title: data.tasks[link.to]?.title ?? '',
          status: this.statusOf(data, link.to),
        })),
      // The same links read from the other end, so both tasks show each one (protocol.md INV-11).
      dependents: data.links
        .filter((link) => link.to === record.id && this.canReach(sender, link.from))
        .map((link) => ({
          id: link.from,
          type: link.type,
          title: data.tasks[link.from]?.title ?? '',
          status: this.statusOf(data, link.from),
        })),
      externalLinks: [],
      fields: {},
      metadata: record.metadata,
      commentCount,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      startedAt: record.startedAt,
      closedAt: record.closedAt,
      closeReason: record.closeReason,
      closeLink: record.closeLink,
      resolution: record.resolution,
      duplicateOf: record.duplicateOf,
      delivery: this.delivery(record),
      proof: proofless ? 'none' : null,
      version: record.version,
    };
  }

  /** A record for an issue the ledger does not hold yet: what GitHub shows of it. */
  private fromIssue(project: ProjectConfig, issue: Issue): TaskRecord {
    const closed = issue.state === 'closed';
    return {
      id: `${project.prefix}-${issue.number}`,
      projectId: project.projectId,
      number: issue.number,
      version: 1,
      title: issue.title,
      description: issue.body ?? '',
      acceptance: '',
      notes: '',
      design: '',
      type: 'task',
      status: closed ? 'closed' : 'open',
      priority: 2,
      labels: issue.labels.map(labelName).filter((name) => name !== project.label),
      parent: null,
      deferUntil: null,
      assignee: null,
      assigneeModel: null,
      for: null,
      work: {},
      lastActivityAt: null,
      metadata: {},
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      startedAt: null,
      closedAt: closed ? issue.closed_at : null,
      closedBy: null,
      closeReason: closed ? 'Closed in GitHub' : null,
      closeLink: null,
      closeCommit: null,
      closePullRequest: null,
      resolution: closed ? (issue.state_reason === 'not_planned' ? 'wont-do' : 'done') : null,
      duplicateOf: null,
      filedBy: issue.user?.login ?? 'github',
    };
  }

  private proposalVersion(record: TaskRecord): string {
    const proposal = JSON.stringify([
      record.id,
      record.title,
      record.description,
      record.acceptance,
      record.type,
      null,
    ]);
    return createHash('sha256').update(proposal).digest('hex').slice(0, 32);
  }

  private async comments(project: ProjectConfig, number: number, data: LedgerData) {
    return (await this.github.listComments(project.repository, number)).map((comment) => {
      const ours = data.comments[String(comment.id)];
      return {
        id: String(comment.id),
        author: ours?.author ?? comment.user?.login ?? 'github',
        text: ours?.text ?? comment.body,
        createdAt: comment.created_at,
      };
    });
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  async read(sender: Sender, id: string) {
    const { project, record, issue } = await this.locate(sender, id, 'read');
    const data = this.ledger.data;
    const task = record ?? this.fromIssue(project, issue!);
    const comments = await this.comments(project, task.number, data);
    return {
      project: project.key,
      task: this.view(sender, data, task, comments.length),
      comments,
      proposal: JSON.stringify([task.id, task.title, task.description, task.acceptance, task.type, null]),
      proposalVersion: this.proposalVersion(task),
    };
  }

  async history(sender: Sender, id: string, limit: number) {
    await this.locate(sender, id, 'read');
    const changes = this.ledger.data.history
      .filter((event) => event.task === id)
      .reverse()
      .slice(0, limit)
      .map(({ task: _task, revision, ...event }) => ({ revision: String(revision), ...event }));
    return { changes };
  }

  async list(
    sender: Sender,
    options: {
      project?: unknown;
      ready?: boolean;
      status?: readonly string[];
      assignee?: string;
      closedDays: number;
      limit: number;
      offset: number;
    },
  ) {
    const projects =
      options.project === undefined ? this.projects(sender) : [this.project(sender, options.project, 'read')];
    const data = this.ledger.data;
    const since = new Date(Date.parse(this.now()) - options.closedDays * 24 * 3600 * 1000).toISOString();
    const tasks: { project: ProjectConfig; record: TaskRecord }[] = [];
    for (const project of projects) {
      const seen = new Set<string>();
      for (const issue of await this.github.listIssues(project.repository, project.label)) {
        const id = `${project.prefix}-${issue.number}`;
        seen.add(id);
        tasks.push({ project, record: data.tasks[id] ?? this.fromIssue(project, issue) });
      }
      for (const record of Object.values(data.tasks))
        if (record.projectId === project.projectId && !seen.has(record.id)) tasks.push({ project, record });
    }
    const assignee = options.assignee === 'me' ? sender.actor : options.assignee;
    const listed = tasks
      .filter(({ record }) => record.status !== 'closed' || (record.closedAt ?? '') >= since)
      .filter(({ record }) => options.status === undefined || options.status.includes(record.status))
      .filter(({ record }) => assignee === undefined || record.assignee === assignee)
      .filter(({ record }) => options.ready !== true || this.ready(data, record))
      .sort((a, b) => a.record.priority - b.record.priority || a.record.createdAt.localeCompare(b.record.createdAt));
    const page = listed.slice(options.offset, options.offset + options.limit);
    return {
      tasks: page.map(({ project, record }) => {
        const {
          description: _d,
          notes: _n,
          design: _g,
          acceptance: _a,
          ...summary
        } = this.view(sender, data, record, 0);
        return { ...summary, ...(options.project === undefined ? { project: project.key } : {}) };
      }),
      nextOffset: options.offset + page.length < listed.length ? options.offset + page.length : null,
    };
  }

  // ─── Writes ───────────────────────────────────────────────────────────────

  /**
   * Runs a write after every earlier one, answering a retry with its first
   * answer (protocol.md INV-3): by its idempotency key, or without one while
   * every task the first answer wrote is unchanged since (mcp-profile.md MCP-2).
   */
  async write(
    sender: Sender,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    run: (draft: LedgerData, model: string | null) => Promise<Done>,
  ): Promise<Record<string, unknown>> {
    const next = this.queue.then(async () => {
      const { idempotency_key: key, detail: _detail, ...rest } = args;
      const request = hash(sorted({ tool, ...rest }));
      const slot =
        key === undefined ? `${sender.id}|${tool}|args|${request}` : `${sender.id}|${tool}|key|${String(key)}`;
      const earlier = this.ledger.data.retries[slot];
      if (earlier !== undefined) {
        if (earlier.request !== request)
          throw new Refused(
            'conflict',
            `conflict: idempotency_key ${String(key)} was first used for a different ${tool} call.`,
          );
        const unchanged = Object.entries(earlier.tasks).every(
          ([id, version]) => this.ledger.data.tasks[id]?.version === version,
        );
        const fresh = tool !== 'create_task' || Date.parse(this.now()) - Date.parse(earlier.at) < 24 * 3600 * 1000;
        if (key !== undefined || (unchanged && fresh)) return { ...(earlier.answer as object), replayed: true };
      }
      return this.ledger.transaction(async (draft) => {
        const done = await run(draft, typeof args.model === 'string' ? args.model : null);
        const tasks = Object.fromEntries(Object.keys(done.tasks).map((id) => [id, draft.tasks[id]?.version ?? 0]));
        draft.retries[slot] = { request, answer: done.answer, tasks, at: this.now() };
        return { ...done.answer, replayed: false };
      });
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** The record a write changes: the ledger's, or one made from the GitHub issue when the ledger has none yet. */
  private async tracked(
    sender: Sender,
    draft: LedgerData,
    id: string,
  ): Promise<{ project: ProjectConfig; record: TaskRecord }> {
    const { project, record, issue } = await this.locate(sender, id, 'write', draft);
    if (record !== null) return { project, record };
    const made = this.fromIssue(project, issue!);
    draft.tasks[id] = made;
    this.event(draft, made, made.filedBy, null, ['created'], { title: { old: null, new: made.title } }, made.createdAt);
    return { project, record: made };
  }

  private event(
    draft: LedgerData,
    record: TaskRecord,
    actor: string,
    model: string | null,
    actions: readonly string[],
    fields: HistoryRecord['fields'],
    at = this.now(),
  ): void {
    draft.revision += 1;
    draft.history.push({ revision: draft.revision, task: record.id, at, actor, model, actions, fields });
  }

  /** Sets fields on the record; answers each one that changed, with its old and new value. */
  private apply(record: TaskRecord, set: Partial<TaskRecord>): Record<string, { old: unknown; new: unknown }> {
    const fields: Record<string, { old: unknown; new: unknown }> = {};
    for (const [name, value] of Object.entries(set)) {
      const old = (record as unknown as Record<string, unknown>)[name];
      if (isDeepStrictEqual(old, value)) continue;
      fields[name] = { old, new: value };
      (record as unknown as Record<string, unknown>)[name] = value;
    }
    return fields;
  }

  /** Records a change: one version, one history event, when anything changed. */
  private changed(
    draft: LedgerData,
    record: TaskRecord,
    sender: Sender,
    model: string | null,
    actions: readonly string[],
    fields: Record<string, { old: unknown; new: unknown }>,
  ): void {
    if (Object.keys(fields).length === 0) return;
    record.version += 1;
    record.updatedAt = this.now();
    if (record.assignee === sender.actor) record.lastActivityAt = record.updatedAt;
    this.event(draft, record, sender.actor, model, actions, fields);
  }

  /** Records a change the adapter makes on its own: one version and one history event under OWN_ACTOR. */
  private ownChange(
    draft: LedgerData,
    record: TaskRecord,
    actions: readonly string[],
    fields: Record<string, { old: unknown; new: unknown }>,
  ): void {
    record.version += 1;
    record.updatedAt = this.now();
    this.event(draft, record, OWN_ACTOR, null, actions, fields);
  }

  /**
   * After a write that closed, reopened, filed or moved a task, or took an
   * epic's keep-open label off: closes each epic `epics` names that it left
   * with at least one task directly under it and every one closed, unless it
   * is labelled keep-open, with that entry's reason, and reopens each the
   * adapter closed that it left with one open; then checks the epic above
   * each the same way (protocol.md STATE-22).
   */
  private async settleEpics(
    draft: LedgerData,
    epics: readonly { readonly id: string | null; readonly reason: string }[],
  ): Promise<void> {
    const queue = epics.flatMap(({ id, reason }) => (id === null ? [] : [{ id, reason }]));
    for (let step = 0; queue.length > 0 && step < 64; step += 1) {
      const { id, reason } = queue.shift()!;
      const epic = draft.tasks[id];
      if (epic === undefined || epic.type !== 'epic') continue;
      const project = this.config.projects.find((each) => each.projectId === epic.projectId);
      if (project === undefined) continue;
      const children = Object.values(draft.tasks).filter((task) => task.parent === id);
      const open = children.some((task) => task.status !== 'closed');
      if (epic.status === 'closed') {
        if (epic.closedBy !== OWN_ACTOR || !open) continue;
        await this.github.updateIssue(project.repository, epic.number, { state: 'open' });
        const fields = this.apply(epic, {
          status: 'open',
          closedAt: null,
          closedBy: null,
          closeReason: null,
          closeLink: null,
          closeCommit: null,
          closePullRequest: null,
          resolution: null,
          duplicateOf: null,
        });
        this.ownChange(draft, epic, ['reopened'], fields);
      } else {
        if (children.length === 0 || open || epic.labels.includes('keep-open')) continue;
        const resolution = children.every((task) => NOTHING_NEEDED.includes(task.resolution ?? ''))
          ? 'no-longer-needed'
          : 'done';
        await this.github.updateIssue(project.repository, epic.number, {
          state: 'closed',
          state_reason: resolution === 'done' ? 'completed' : 'not_planned',
        });
        const at = this.now();
        const fields = this.apply(epic, {
          status: 'closed',
          resolution,
          closeReason: reason,
          closeLink: null,
          closeCommit: null,
          closePullRequest: null,
          closedAt: at,
          closedBy: OWN_ACTOR,
          duplicateOf: null,
          for: null,
          work: {},
        });
        fields.close = {
          old: null,
          new: { at, reason, resolution, duplicateOf: null, by: OWN_ACTOR, model: null, link: null },
        };
        this.ownChange(draft, epic, ['closed'], fields);
      }
      if (epic.parent !== null) queue.push({ id: epic.parent, reason: closedLast(epic.id) });
    }
  }

  private githubLabels(project: ProjectConfig, labels: readonly string[]): string[] {
    return [...(project.label === undefined ? [] : [project.label]), ...labels];
  }

  private async ensureLabels(project: ProjectConfig, labels: readonly string[]): Promise<void> {
    for (const label of this.githubLabels(project, labels)) await this.github.ensureLabel(project.repository, label);
  }

  private linksBetween(draft: LedgerData, a: string, b: string): LinkRecord[] {
    return draft.links.filter((link) => (link.from === a && link.to === b) || (link.from === b && link.to === a));
  }

  private dependencies(draft: LedgerData, id: string) {
    return draft.links.filter((link) => link.from === id).map((link) => ({ id: link.to, type: link.type }));
  }

  /** Whether `from` already waits on `to`, through blocks links. */
  private waitsOn(draft: LedgerData, from: string, to: string, seen = new Set<string>()): boolean {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return draft.links.some(
      (link) => link.from === from && link.type === 'blocks' && this.waitsOn(draft, link.to, to, seen),
    );
  }

  /** Sets the one link between two tasks (protocol.md INV-11); answers the link it replaced. */
  private setLink(draft: LedgerData, from: string, to: string, type: LinkType): LinkRecord | null {
    if (type === 'blocks' && this.waitsOn(draft, to, from))
      refuse(`${from} waiting on ${to} would make them wait on each other in a loop.`);
    const [old = null] = this.linksBetween(draft, from, to);
    draft.links = draft.links.filter((link) => link !== old);
    draft.links.push({ from, to, type });
    return old;
  }

  async create(sender: Sender, args: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    return this.write(sender, 'create_task', args, async (draft, model) => {
      const project = this.project(sender, args.project, 'write');
      const labels = (args.labels as string[] | undefined) ?? [];
      const dependsOn = (args.depends_on as string[] | undefined) ?? [];
      const blocks = (args.blocks as string[] | undefined) ?? [];
      if (dependsOn.some((id) => blocks.includes(id)))
        invalid('depends_on and blocks name the same task, which would wait on each other');
      const others = [
        ...dependsOn,
        ...blocks,
        ...((args.related as string[] | undefined) ?? []),
        ...((args.discovered_from as string[] | undefined) ?? []),
      ];
      const parent = args.parent as string | undefined;
      const linked = new Map<string, TaskRecord>();
      for (const id of [...others, ...(parent === undefined ? [] : [parent])])
        linked.set(id, (await this.tracked(sender, draft, id)).record);
      if (parent !== undefined && linked.get(parent)!.projectId !== project.projectId)
        refuse(`${parent} is in another project.`);
      // Every rule is checked before the first GitHub write, so a refused task leaves no issue behind.
      const discovered = (args.discovered_from as string[] | undefined) ?? [];
      for (const id of [...dependsOn, ...blocks, ...discovered])
        if (linked.get(id)!.projectId !== project.projectId)
          refuse(`${id} is in another project; a link to it stays inside one.`);
      for (const after of dependsOn)
        for (const before of blocks)
          if (this.waitsOn(draft, after, before))
            refuse(
              `${before} waiting on the new task, which waits on ${after}, would make them wait on each other in a loop.`,
            );
      await this.ensureLabels(project, labels);
      const issue = await this.github.createIssue(project.repository, {
        title: args.title as string,
        body: (args.description as string | undefined) ?? '',
        labels: this.githubLabels(project, labels),
      });
      const at = this.now();
      const claim = args.claim === true;
      const record: TaskRecord = {
        id: `${project.prefix}-${issue.number}`,
        projectId: project.projectId,
        number: issue.number,
        version: 1,
        title: args.title as string,
        description: (args.description as string | undefined) ?? '',
        acceptance: (args.acceptance as string | undefined) ?? '',
        notes: (args.notes as string | undefined) ?? '',
        design: (args.design as string | undefined) ?? '',
        type: (args.type as string | undefined) ?? 'task',
        status: claim ? 'in_progress' : 'open',
        priority: (args.priority as number | undefined) ?? 2,
        labels,
        parent: parent ?? null,
        deferUntil: null,
        assignee: claim ? sender.actor : null,
        assigneeModel: claim ? model : null,
        for: null,
        work: {},
        lastActivityAt: claim ? at : null,
        metadata: (args.metadata as Record<string, unknown> | undefined) ?? {},
        createdAt: at,
        updatedAt: at,
        startedAt: claim ? at : null,
        closedAt: null,
        closedBy: null,
        closeReason: null,
        closeLink: null,
        closeCommit: null,
        closePullRequest: null,
        resolution: null,
        duplicateOf: null,
        filedBy: sender.actor,
      };
      draft.tasks[record.id] = record;
      for (const id of dependsOn) this.setLink(draft, record.id, id, 'blocks');
      for (const id of (args.related as string[] | undefined) ?? []) this.setLink(draft, record.id, id, 'related');
      for (const id of (args.discovered_from as string[] | undefined) ?? [])
        this.setLink(draft, record.id, id, 'discovered-from');
      for (const id of blocks) {
        this.setLink(draft, id, record.id, 'blocks');
        const other = draft.tasks[id]!;
        other.version += 1;
        this.event(draft, other, sender.actor, model, ['updated'], {
          dependencies: { old: null, new: this.dependencies(draft, id) },
        });
      }
      const { id: _id, projectId: _p, number: _n, version: _v, ...filed } = record;
      this.event(
        draft,
        record,
        sender.actor,
        model,
        claim ? ['created', 'claimed'] : ['created'],
        Object.fromEntries(
          Object.entries({ ...filed, dependencies: this.dependencies(draft, record.id) }).map(([name, value]) => [
            name,
            { old: null, new: value },
          ]),
        ),
      );
      await this.settleEpics(draft, [{ id: record.parent, reason: closedLast(record.id) }]);
      return {
        answer: {
          id: record.id,
          status: record.status,
          version: record.version,
          ...(claim ? { assignee: record.assignee } : {}),
        },
        tasks: Object.fromEntries([record.id, ...blocks].map((id) => [id, 0])),
      };
    });
  }

  async claim(sender: Sender, args: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    return this.write(sender, 'claim_task', args, async (draft, model) => {
      const { record } = await this.tracked(sender, draft, args.task as string);
      const held = record.assignee !== null && record.assignee !== sender.actor;
      if (held)
        refuse(
          `${record.id} is held by ${record.assignee}. Choose another task, or reach ${record.assignee} with comment_on_task.`,
        );
      if (record.status === 'closed') refuse(`${record.id} is closed; update_task with a status reopens it.`);
      if (record.assignee === null && record.status !== 'open')
        refuse(`${record.id} has status ${record.status}, and claim_task takes an open task.`);
      const work = { ...record.work };
      for (const name of WORK) if (typeof args[name] === 'string') work[name] = args[name] as string;
      const at = this.now();
      const fields = this.apply(record, {
        status: 'in_progress',
        assignee: sender.actor,
        assigneeModel: record.assignee === sender.actor ? record.assigneeModel : model,
        startedAt: record.startedAt ?? at,
        work,
        ...(typeof args.for === 'string' ? { for: args.for as string } : {}),
      });
      this.changed(draft, record, sender, model, fields.status ? ['claimed'] : ['updated'], fields);
      record.lastActivityAt = at;
      return {
        answer: {
          id: record.id,
          status: record.status,
          assignee: record.assignee,
          ...(Object.keys(record.work).length > 0 ? { work: record.work } : {}),
          ...(record.for !== null ? { for: record.for } : {}),
          version: record.version,
        },
        tasks: { [record.id]: 0 },
      };
    });
  }

  async update(sender: Sender, args: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    return this.write(sender, 'update_task', args, async (draft, model) => {
      const { project, record } = await this.tracked(sender, draft, args.task as string);
      const set: Partial<TaskRecord> = {};
      const actions: string[] = [];
      for (const name of ['title', 'description', 'acceptance', 'notes', 'design', 'priority'] as const)
        if (args[name] !== undefined) (set as Record<string, unknown>)[name] = args[name];
      if (args.defer !== undefined) set.deferUntil = args.defer === '' ? null : (args.defer as string);
      if (args.add_labels !== undefined || args.remove_labels !== undefined) {
        const removed = (args.remove_labels as string[] | undefined) ?? [];
        if (removed.includes('human') && record.labels.includes('human') && sender.kind !== 'person')
          refuse(`${record.id} waits on a person; only a person takes the human label off.`);
        set.labels = [
          ...new Set([
            ...record.labels.filter((label) => !removed.includes(label)),
            ...((args.add_labels as string[] | undefined) ?? []),
          ]),
        ];
      }
      if (args.parent !== undefined) {
        const parent = args.parent === '' ? null : (args.parent as string);
        if (parent !== null) {
          const above = (await this.tracked(sender, draft, parent)).record;
          if (above.projectId !== record.projectId) refuse(`${parent} is in another project.`);
          for (let at: string | null = parent; at !== null; at = draft.tasks[at]?.parent ?? null)
            if (at === record.id) refuse(`${parent} is under ${record.id}; a task cannot be its own ancestor.`);
        }
        set.parent = parent;
      }
      const closed = record.status === 'closed';
      if (args.status !== undefined) {
        const status = args.status as string;
        if (status === 'in_progress' && record.assignee === null && (closed || record.status !== 'in_progress'))
          refuse(`${record.id} has nobody holding it; claim_task takes it and sets it in progress.`);
        set.status = status;
        if (closed) {
          Object.assign(set, {
            closedAt: null,
            closedBy: null,
            closeReason: null,
            closeLink: null,
            closeCommit: null,
            closePullRequest: null,
            resolution: null,
            duplicateOf: null,
          });
          actions.push('reopened');
        } else if (status !== record.status) actions.push('status_changed');
      }
      if (args.assignee !== undefined) {
        const to = args.assignee === '' ? null : (args.assignee as string);
        if (record.assignee !== null && record.assignee !== sender.actor && to !== record.assignee)
          refuse(
            `${record.id} is held by ${record.assignee}, and only its holder gives it to someone else or releases it.`,
          );
        if (record.assignee === null && to !== null && to !== sender.actor)
          refuse(`${record.id} has nobody holding it; claim_task takes it, and its holder then hands it over.`);
        if (to !== record.assignee) {
          set.assignee = to;
          set.assigneeModel = to === sender.actor ? model : null;
          set.for = null;
          set.work = {};
          if (to === null && (set.status ?? record.status) === 'in_progress') set.status = 'open';
        }
      }
      const githubChange: { title?: string; body?: string; state?: 'open'; labels?: string[] } = {};
      if (set.title !== undefined && set.title !== record.title) githubChange.title = set.title;
      if (set.description !== undefined && set.description !== record.description) githubChange.body = set.description;
      if (set.labels !== undefined && !isDeepStrictEqual(set.labels, record.labels)) {
        await this.ensureLabels(project, set.labels);
        githubChange.labels = this.githubLabels(project, set.labels);
      }
      if (closed && set.status !== undefined) githubChange.state = 'open';
      if (Object.keys(githubChange).length > 0)
        await this.github.updateIssue(project.repository, record.number, githubChange);
      const before = record.parent;
      const fields = this.apply(record, set);
      this.changed(draft, record, sender, model, actions.length > 0 ? actions : ['updated'], fields);
      if (fields.parent !== undefined || fields.status?.old === 'closed')
        await this.settleEpics(draft, [
          ...(before !== record.parent
            ? [
                {
                  id: before,
                  reason: `Every task under this epic is closed now that ${record.id}, the last one open, moved out of it.`,
                },
              ]
            : []),
          {
            id: record.parent,
            reason:
              before !== record.parent && closed && record.status === 'closed'
                ? `Every task under this epic is closed now that ${record.id}, already closed, moved into it.`
                : closedLast(record.id),
          },
        ]);
      const unkept =
        (fields.labels?.old as string[] | undefined)?.includes('keep-open') && !record.labels.includes('keep-open');
      if (unkept)
        await this.settleEpics(draft, [
          { id: record.id, reason: 'Every task under this epic is closed, and its keep-open label came off.' },
        ]);
      const shown = Object.fromEntries(
        Object.keys(fields)
          .filter((name) => !['description', 'acceptance', 'notes', 'design'].includes(name))
          .map((name) => [name, (record as unknown as Record<string, unknown>)[name]]),
      );
      return { answer: { id: record.id, version: record.version, ...shown }, tasks: { [record.id]: 0 } };
    });
  }

  async comment(sender: Sender, args: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    return this.write(sender, 'comment_on_task', args, async (draft, model) => {
      const { project, record } = await this.tracked(sender, draft, args.task as string);
      const named = WORK.filter((name) => typeof args[name] === 'string');
      if (
        (named.length > 0 || args.for !== undefined) &&
        (record.assignee !== sender.actor || record.status === 'closed')
      )
        refuse(`only ${record.id}'s holder records its work details, and only while it is open.`);
      const text = args.text as string;
      const posted = await this.github.createComment(project.repository, record.number, `${text}\n\n— ${sender.actor}`);
      draft.comments[String(posted.id)] = {
        githubId: posted.id,
        task: record.id,
        author: sender.actor,
        text,
        createdAt: posted.created_at,
      };
      const work = { ...record.work };
      for (const name of named) work[name] = args[name] as string;
      const fields = this.apply(record, { work, ...(typeof args.for === 'string' ? { for: args.for as string } : {}) });
      this.changed(draft, record, sender, model, ['updated'], fields);
      this.event(draft, record, sender.actor, model, ['commented'], { comment: { old: null, new: text } });
      if (record.assignee === sender.actor) record.lastActivityAt = this.now();
      return { answer: { task: record.id, commentId: String(posted.id) }, tasks: { [record.id]: 0 } };
    });
  }

  async close(sender: Sender, args: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    return this.write(sender, 'close_task', args, async (draft, model) => {
      const { project, record } = await this.tracked(sender, draft, args.task as string);
      const resolution = (args.resolution as string | undefined) ?? 'done';
      const proof = {
        commit: args.commit as string | undefined,
        pr: args.pr as string | undefined,
        link: args.link as string | undefined,
      };
      if (resolution !== 'done' && Object.values(proof).some((value) => value !== undefined))
        invalid(`commit, pr and link (only a close as done names its proof; this one is ${resolution})`);
      // An epic the adapter closed on its own takes a sender's close in place of its own (protocol.md STATE-22).
      if (record.status === 'closed' && !(record.type === 'epic' && record.closedBy === OWN_ACTOR))
        refuse(`${record.id} is already closed; get_task shows its close.`);
      if (record.assignee !== null && record.assignee !== sender.actor)
        refuse(`${record.id} is held by ${record.assignee}; only its holder closes it.`);
      if (record.labels.includes('human') && sender.kind !== 'person')
        refuse(`${record.id} waits on a person's answer, and only a person closes it.`);
      const children = Object.values(draft.tasks).filter(
        (task) => task.parent === record.id && task.status !== 'closed',
      );
      if (children.length > 0)
        refuse(`${record.id} has open children: ${children.map((task) => task.id).join(', ')}. Close them first.`);
      const duplicateOf = args.duplicate_of as string | undefined;
      if (resolution === 'duplicate' && duplicateOf === undefined)
        invalid('duplicate_of (required with resolution duplicate)');
      if (duplicateOf !== undefined && resolution !== 'duplicate')
        invalid('duplicate_of (only with resolution duplicate)');
      if (duplicateOf !== undefined) {
        if (duplicateOf === record.id) invalid('duplicate_of (another task)');
        await this.tracked(sender, draft, duplicateOf);
      }
      const commit = proof.commit ?? (HEX.test(record.work.commit ?? '') ? record.work.commit! : undefined);
      const pr = proof.pr ?? record.work.pr;
      const reason = args.reason as string;
      await this.github.updateIssue(project.repository, record.number, {
        state: 'closed',
        state_reason: resolution === 'done' ? 'completed' : 'not_planned',
      });
      const note = [
        `Closed as ${resolution}: ${reason}`,
        ...[commit, pr, proof.link].filter((value) => value !== undefined),
      ];
      const posted = await this.github.createComment(
        project.repository,
        record.number,
        `${note.join('\n')}\n\n— ${sender.actor}`,
      );
      draft.comments[String(posted.id)] = {
        githubId: posted.id,
        task: record.id,
        author: sender.actor,
        text: note.join('\n'),
        createdAt: posted.created_at,
      };
      const at = this.now();
      const fields = this.apply(record, {
        status: 'closed',
        resolution,
        closeReason: reason,
        closeLink: proof.link ?? null,
        closeCommit: resolution === 'done' ? (commit ?? null) : null,
        closePullRequest: resolution === 'done' ? (pr ?? null) : null,
        closedAt: at,
        closedBy: sender.actor,
        duplicateOf: duplicateOf ?? null,
        for: null,
        work: {},
      });
      fields.close = {
        old: null,
        new: {
          at,
          reason,
          resolution,
          duplicateOf: duplicateOf ?? null,
          by: sender.actor,
          model,
          link: proof.link ?? null,
        },
      };
      if (duplicateOf !== undefined) {
        const before = this.dependencies(draft, record.id);
        this.setLink(draft, record.id, duplicateOf, 'related');
        fields.dependencies = { old: before, new: this.dependencies(draft, record.id) };
      }
      this.changed(draft, record, sender, model, ['closed'], fields);
      await this.settleEpics(draft, [{ id: record.parent, reason: closedLast(record.id) }]);
      return {
        answer: {
          id: record.id,
          status: record.status,
          resolution,
          ...(this.delivery(record) === null ? {} : { delivery: this.delivery(record) }),
          version: record.version,
          unblocked: [],
        },
        tasks: { [record.id]: 0 },
      };
    });
  }

  async link(sender: Sender, args: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    return this.write(sender, 'link_tasks', args, async (draft, model) => {
      const from = (await this.tracked(sender, draft, args.task as string)).record;
      // As in Ntasks, the other task need only be readable: the link is the first task's. A link
      // the other task holds is its own, so a sender who only reads its project cannot change it.
      const target = await this.locate(sender, args.to as string, 'read', draft);
      const writable = sender.projects.get(target.project.projectId) === 'write';
      const to = writable
        ? (await this.tracked(sender, draft, args.to as string)).record
        : (target.record ?? this.fromIssue(target.project, target.issue!));
      if (from.id === to.id) invalid('to (another task)');
      if (!writable && this.linksBetween(draft, from.id, to.id).some((link) => link.from === to.id))
        refuse(
          `${to.id} links to ${from.id}, and project ${target.project.key} is granted to you for reading only; ` +
            'only a sender who may change it can change that link.',
        );
      const crosses = from.projectId !== to.projectId;
      const before = { [from.id]: this.dependencies(draft, from.id), [to.id]: this.dependencies(draft, to.id) };
      let answer: Record<string, unknown>;
      if (args.remove === true) {
        draft.links = draft.links.filter((link) => !this.linksBetween(draft, from.id, to.id).includes(link));
        answer = { task: from.id, to: to.id, removed: true };
      } else {
        const type = args.type as LinkType;
        if (crosses && !ACROSS_PROJECTS.includes(type)) refuse(`a ${type} link stays inside one project.`);
        const replaced = this.setLink(draft, from.id, to.id, type);
        answer = {
          task: from.id,
          to: to.id,
          type,
          ...(replaced !== null && !isDeepStrictEqual(replaced, { from: from.id, to: to.id, type })
            ? { replaced }
            : {}),
        };
      }
      for (const record of [from, to]) {
        const after = this.dependencies(draft, record.id);
        if (!isDeepStrictEqual(after, before[record.id]))
          this.changed(draft, record, sender, model, ['updated'], {
            dependencies: { old: before[record.id], new: after },
          });
      }
      return { answer, tasks: { [from.id]: 0, [to.id]: 0 } };
    });
  }

  /** Releases a task whose holder stopped (protocol.md AUTH-9); the core level retires nothing else. */
  async reconcile(sender: Sender, args: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    return this.write(sender, 'reconcile_task', args, async (draft, model) => {
      if (args.action !== 'release')
        invalid('action (release: this server implements the core level, whose only reconcile action is release)');
      for (const name of ['holder', 'activity_check', 'progress'] as const)
        if (args[name] === undefined) invalid(`${name} (required for action release)`);
      if (args.inactive !== true)
        refuse(
          'a release needs inactive: true once you checked the holder stopped, with activity_check and progress; age alone is not that evidence.',
        );
      const { project, record } = await this.tracked(sender, draft, args.task as string);
      if (args.proposal_version !== this.proposalVersion(record))
        refuse(`proposal_version: ${record.id} changed after you read it; read it again with get_task.`);
      if (record.assignee === null || record.assignee !== args.holder)
        refuse(`${record.id} is held by ${record.assignee ?? 'nobody'}; check its current holder before releasing it.`);
      const text = `Released from ${record.assignee}. Checked: ${String(args.activity_check)}\nProgress: ${String(args.progress)}`;
      const posted = await this.github.createComment(project.repository, record.number, `${text}\n\n— ${sender.actor}`);
      draft.comments[String(posted.id)] = {
        githubId: posted.id,
        task: record.id,
        author: sender.actor,
        text,
        createdAt: posted.created_at,
      };
      const fields = this.apply(record, {
        assignee: null,
        assigneeModel: null,
        for: null,
        work: {},
        ...(record.status === 'in_progress' ? { status: 'open' } : {}),
      });
      this.changed(draft, record, sender, model, ['updated'], fields);
      this.event(draft, record, sender.actor, model, ['commented'], { comment: { old: null, new: text } });
      return {
        answer: { id: record.id, status: record.status, assignee: record.assignee, version: record.version },
        tasks: { [record.id]: 0 },
      };
    });
  }
}
