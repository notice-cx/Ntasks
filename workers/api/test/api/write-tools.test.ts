// The MCP tools that change tasks, as an agent calls them: their schemas,
// what each one changes and answers, the sentences each refusal returns, and
// retries. Names and arguments are NoticeOS's task tools'.
import { TaskRefused, type Project, type Task, type TaskEngine } from '@ntasks/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { WORK_ARGS } from '../../src/args.ts';
import {
  descriptionAdvice,
  descriptionHolds,
  namesPlaceToAct,
  placeAdvice,
  repeatAdvice,
  repeatsTitle,
  titleAdvice,
  titleHolds,
} from '../../src/mcp/writing.ts';
import { CHOICES_ADVICE } from '../../src/noticeos-fields.ts';
import { AGENT, clock, newProject, OWNER } from '../engine/helpers.ts';
import {
  api,
  callTool,
  granted,
  ORIGIN,
  read,
  READER,
  refusal,
  refusalOf,
  write,
  WORKSPACE,
  WRITER,
  type TestApi,
} from './helpers.ts';
// NoticeOS's own tools/list for these tools. Produced from NoticeOS at commit
// ced74393 by importing its compiled scripts/hosted-mcp.mjs in Node, building
// its standalone endpoint (createHostedMcp) and asking it for tools/list, so
// the names, descriptions, input schemas and annotations are exactly the ones
// agents written for NoticeOS were given. get_agent_stats is copied from its
// definition in scripts/hosted-task-mcp.mts at commit 09563bcc, with the
// workspace argument its endpoint adds to every tool. reconcile_task is not
// here: it records an answer as the option chosen on a proposal version, so
// its arguments are Ntasks's own. add_dependency and remove_dependency are not
// here either: link_tasks replaced them, setting or removing the one link
// between two tasks.
import NOTICEOS_TOOLS from '../fixtures/noticeos-task-tools.json';

const time = clock('2026-11-06T12:00:00.000Z');
let target: TestApi;
let engine: TaskEngine;

beforeAll(() => {
  target = api({ principal: WRITER, now: time.now });
  engine = target.engine;
});

/** A fresh key for one call. */
const key = () => `key-${crypto.randomUUID()}`;

async function task(project: Project, input: Parameters<TaskEngine['createTask']>[1] = { title: 'A task' }) {
  return (await engine.createTask(project.id, input, OWNER)).task;
}

async function current(project: Project, id: string): Promise<Task> {
  return (await engine.getTask(project.id, id))!;
}

const missingProject = (id: string) =>
  `refused: project ${id} names no project in this workspace; list_projects lists each one's projectId, key and prefix.`;

type Schema = { readonly [key: string]: unknown };
const isSchema = (value: unknown): value is Schema =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A schema without its descriptions and required lists, at any depth. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (!isSchema(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'description' && key !== 'required')
      .map(([key, entry]) => [
        key,
        key === 'properties' && isSchema(entry)
          ? Object.fromEntries(Object.entries(entry).map(([name, property]) => [name, shape(property)]))
          : shape(entry),
      ]),
  );
}

/**
 * `ours` without the properties `theirs` lacks, at any depth, such as an entry
 * of create_tasks, and without descriptions and required lists. Each property
 * left out is named in `added` by its path, and each argument `ours` requires
 * that `theirs` did not is named in `required`.
 */
function withoutAdded(
  ours: unknown,
  theirs: unknown,
  at: string,
  found: { added: string[]; required: string[] },
): unknown {
  if (Array.isArray(ours))
    return ours.map((entry: unknown, index): unknown =>
      withoutAdded(entry, (theirs as unknown[] | undefined)?.[index], at, found),
    );
  if (!isSchema(ours) || !isSchema(theirs)) return shape(ours);
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ours)) {
    if (key === 'description') continue;
    if (key === 'required') {
      const before = Array.isArray(theirs.required) ? (theirs.required as unknown[]) : [];
      if (Array.isArray(value))
        found.required.push(...value.filter((name) => !before.includes(name)).map((name) => `${at}.${String(name)}`));
      continue;
    }
    if (key !== 'properties' || !isSchema(value) || !isSchema(theirs.properties)) {
      kept[key] = withoutAdded(value, theirs[key], at, found);
      continue;
    }
    const properties: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(value)) {
      if (name in theirs.properties) {
        properties[name] = withoutAdded(property, theirs.properties[name], `${at}.${name}`, found);
        continue;
      }
      found.added.push(`${at}.${name}`);
    }
    kept[key] = properties;
  }
  return kept;
}

describe('tools/list', () => {
  it("offers NoticeOS's task tools with every argument they took, requiring none they did not", async () => {
    const response = await target.fetch(
      new Request(`${ORIGIN}/api/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    const { result } = (await response.json()) as { result: { tools: { name: string }[] } };
    const names = NOTICEOS_TOOLS.map((tool) => tool.name);
    const offered = result.tools.filter((tool) => names.includes(tool.name));
    expect(offered.map((tool) => tool.name)).toEqual(names);
    const found = { added: [] as string[], required: [] as string[] };
    const unchanged = offered.map((tool, index) => withoutAdded(tool, NOTICEOS_TOOLS[index], tool.name, found));
    expect(unchanged).toEqual(shape(NOTICEOS_TOOLS));
    expect(found.required).toEqual([]);
    expect(found.added).toEqual([
      'list_tasks.stage',
      'list_tasks.stalled',
      'list_tasks.activity',
      'list_tasks.changed_by',
      'list_tasks.changed_for',
      'list_tasks.changed_in',
      'list_tasks.sort',
      'list_tasks.direction',
      'list_tasks.fields',
      'get_task.tasks',
      'create_task.notes',
      'create_task.design',
      'create_task.estimate_minutes',
      'create_task.duplicates',
      'create_task.supersedes',
      'create_task.external_links',
      'create_task.fields',
      'create_task.claim',
      'create_task.done',
      'create_task.detail',
      'create_tasks.tasks.notes',
      'create_tasks.tasks.design',
      'create_tasks.tasks.estimate_minutes',
      'create_tasks.tasks.duplicates',
      'create_tasks.tasks.supersedes',
      'create_tasks.tasks.external_links',
      'create_tasks.tasks.fields',
      'create_tasks.tasks.claim',
      'create_tasks.tasks.done',
      ...WORK_ARGS.map((name) => `claim_task.${name}`),
      'claim_task.detail',
      'update_task.notes',
      'update_task.design',
      'update_task.estimate_minutes',
      'update_task.duplicates',
      'update_task.supersedes',
      'update_task.add_external_links',
      'update_task.fields',
      'update_task.remove_external_links',
      'update_task.model',
      'update_task.detail',
      'comment_on_task.tasks',
      'comment_on_task.pin',
      'comment_on_task.unpin',
      'comment_on_task.test',
      'comment_on_task.model',
      ...WORK_ARGS.map((name) => `comment_on_task.${name}`),
      'comment_on_task.detail',
      'request_human_approval.title',
      'request_human_approval.description',
      'request_human_approval.model',
      'close_task.tasks',
      'close_task.commit',
      'close_task.pr',
      'close_task.link',
      'close_task.with_children',
      'close_task.test',
      'close_task.detail',
    ]);
  });
});

describe('who may write', () => {
  const calls: readonly [string, (project: string, task: string) => Record<string, unknown>][] = [
    ['create_task', (project) => ({ project, title: 'New', idempotency_key: key() })],
    ['create_tasks', (project) => ({ project, tasks: [{ title: 'New' }], idempotency_key: key() })],
    ['claim_task', (project, id) => ({ project, task: id, idempotency_key: key() })],
    ['update_task', (project, id) => ({ project, task: id, priority: 1, idempotency_key: key() })],
    ['comment_on_task', (project, id) => ({ project, task: id, text: 'Hi.', idempotency_key: key() })],
    ['link_tasks', (project, id) => ({ project, task: id, to: `${id}x`, type: 'related' })],
    ['request_human_approval', (project, id) => ({ project, task: id, reason: 'Approve it.' })],
    ['close_task', (project, id) => ({ project, task: id, reason: 'Done.', idempotency_key: key() })],
  ];

  it('refuses a sender without the write scope, naming what it holds', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const reader = api({ principal: READER, engine });
    for (const [name, args] of calls) {
      expect(await refusal(reader, name, { workspace: WORKSPACE.id, ...args(project.id, id) }), name).toBe(
        `refused: this call needs tasks:write in workspace ${WORKSPACE.id} (${WORKSPACE.name}), where you have tasks:read; list_workspaces shows what you may do in each.`,
      );
    }
  });

  it('refuses a project the sender may only read, and one it cannot reach as if it did not exist', async () => {
    const project = await newProject(engine);
    const other = await newProject(engine);
    const { id } = await task(project);
    const before = await current(project, id);
    const sender = api({ principal: granted({ [project.id]: 'read' }), engine });
    const forbidden = `refused: this call needs tasks:write in projectId ${project.id} (${project.name}), where you have tasks:read.`;
    for (const [name, args] of calls) {
      expect(await refusal(sender, name, { workspace: WORKSPACE.id, ...args(project.id, id) }), name).toBe(forbidden);
      expect(await refusal(sender, name, { workspace: WORKSPACE.id, ...args(other.id, id) }), name).toBe(
        missingProject(other.id),
      );
    }
    expect(await current(project, id)).toEqual(before);
  });

  it('lets a sender change a project it was granted for writing', async () => {
    const project = await newProject(engine);
    const sender = api({ principal: granted({ [project.id]: 'write' }), engine });
    const created = await write<{ id: string }>(sender, 'create_task', {
      project: project.id,
      title: 'Granted',
      idempotency_key: key(),
    });
    expect((await current(project, created.id)).filedBy).toBe('agent-g');
  });
});

describe('a write that names only what it needs', () => {
  it('claims, comments on and closes a task named by its id alone', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    expect(await write(target, 'claim_task', { task: id })).toEqual({
      id,
      status: 'in_progress',
      assignee: WRITER.name,
      version: 2,
      replayed: false,
    });
    expect(await write(target, 'comment_on_task', { task: id, text: 'Halfway.' })).toEqual({
      task: id,
      commentId: (await engine.listComments(project.id, id))[0]!.id,
      replayed: false,
    });
    const closed = await write(target, 'close_task', { task: id, reason: 'Shipped.', commit: 'abc1234' });
    expect(closed).toEqual({
      id,
      status: 'closed',
      resolution: 'done',
      delivery: expect.objectContaining({ stage: 'built', commit: 'abc1234' }),
      version: (await current(project, id)).version,
      replayed: false,
      unblocked: [],
    });
  });

  it("files a task in the project its prefix or key names, its parent's, or the sender's only writable one", async () => {
    const project = await newProject(engine);
    const other = await newProject(engine);
    const epic = await task(project, { title: 'Epic', type: 'epic' });
    const inProject = (id: string) => expect(id.startsWith(`${project.prefix}-`), id).toBe(true);
    for (const named of [{ project: project.prefix }, { project: project.key }, { parent: epic.id }])
      inProject((await write<{ id: string }>(target, 'create_task', { title: 'Filed', ...named })).id);
    const writesOne = api({ principal: granted({ [project.id]: 'write', [other.id]: 'read' }), engine });
    inProject((await write<{ id: string }>(writesOne, 'create_task', { title: 'Alone' })).id);
    const writesTwo = api({ principal: granted({ [project.id]: 'write', [other.id]: 'write' }), engine });
    const unnamed = await refusal(writesTwo, 'create_task', { workspace: WORKSPACE.id, title: 'Where?' });
    expect(unnamed).toMatch(/^invalid arguments: project /u);
    for (const prefix of [project.prefix, other.prefix]) expect(unnamed).toContain(`prefix ${prefix}`);
  });

  it('answers the same new task sent again without a key with its first result, while it is unchanged and for a day', async () => {
    const project = await newProject(engine);
    const args = { project: project.id, title: 'Once' };
    const filed = async () => (await engine.listTasks(project.id, { limit: 10 })).tasks.length;
    const first = await write<{ id: string }>(target, 'create_task', args);
    expect(await write(target, 'create_task', args)).toEqual({ ...first, replayed: true });
    expect(await filed()).toBe(1);
    // A key of the caller's own makes the same change again on purpose, and another sender's call is its own.
    await write(target, 'create_task', { ...args, idempotency_key: key() });
    await write(api({ principal: granted({ [project.id]: 'write' }, 'agent-o'), engine }), 'create_task', args);
    expect(await filed()).toBe(3);
    // Once the task it filed has changed, the same call files another, which then answers it.
    await write(target, 'update_task', { task: first.id, priority: 0 });
    const second = await write<{ id: string }>(target, 'create_task', args);
    expect(second).toMatchObject({ replayed: false });
    expect(second.id).not.toBe(first.id);
    expect(await write(target, 'create_task', args)).toEqual({ ...second, replayed: true });
    expect(await filed()).toBe(4);
    time.advance(24 * 60 + 1);
    try {
      expect(await write(target, 'create_task', args)).toMatchObject({ replayed: false });
      expect(await filed()).toBe(5);
    } finally {
      time.advance(-(24 * 60 + 1));
    }
  });

  it('files a keyless batch again whole once a task it filed has changed', async () => {
    const project = await newProject(engine);
    const args = {
      project: project.id,
      tasks: [
        { title: 'Epic', type: 'epic' },
        { title: 'Child', parent: '#0' },
      ],
    };
    type Batch = { results: { id: string; replayed: boolean }[] };
    const filing = (batch: Batch) => batch.results.map(({ id, replayed }) => [id, replayed]);
    const first = await write<Batch>(target, 'create_tasks', args);
    const [epic, child] = first.results.map((entry) => entry.id);
    expect(filing(await write<Batch>(target, 'create_tasks', args))).toEqual([
      [epic, true],
      [child, true],
    ]);
    await write(target, 'update_task', { task: child, priority: 0 });
    const again = await write<Batch>(target, 'create_tasks', args);
    const [newEpic, newChild] = again.results.map((entry) => entry.id);
    expect(again.results.map((entry) => entry.replayed)).toEqual([false, false]);
    // The whole batch is filed again, its #0 naming the new epic.
    expect([newEpic, newChild]).not.toContain(epic);
    expect(newChild).toBe(`${newEpic}.1`);
    expect(filing(await write<Batch>(target, 'create_tasks', args))).toEqual([
      [newEpic, true],
      [newChild, true],
    ]);
    expect((await engine.listTasks(project.id, { limit: 10 })).tasks).toHaveLength(4);
  });

  it('runs the same write sent again without a key once the task has changed since its answer', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const claim = { task: id };
    expect(await write(target, 'claim_task', claim)).toMatchObject({ replayed: false, version: 2 });
    // Right after, nothing has changed: the same call answers with the first claim and writes nothing.
    expect(await write(target, 'claim_task', claim)).toMatchObject({ replayed: true, version: 2 });
    await write(target, 'update_task', { task: id, assignee: '', status: 'open' });
    expect(await write(target, 'claim_task', claim)).toMatchObject({
      replayed: false,
      assignee: WRITER.name,
      version: 4,
    });

    const close = { task: id, reason: 'Done in abc1234.' };
    expect(await write(target, 'close_task', close)).toMatchObject({ status: 'closed', replayed: false });
    await write(target, 'update_task', { task: id, status: 'open' });
    expect(await write(target, 'close_task', close)).toMatchObject({ status: 'closed', replayed: false });

    const renamed = await task(project, { title: 'X' });
    for (const title of ['Y', 'X', 'Y']) await write(target, 'update_task', { task: renamed.id, title });
    expect(await current(project, renamed.id)).toMatchObject({ title: 'Y', version: 4 });

    // A comment leaves the task unchanged: the same one again is the first, until the task changes.
    const say = { task: renamed.id, text: 'Same words.' };
    const said = await write(target, 'comment_on_task', say);
    expect(await write(target, 'comment_on_task', say)).toEqual({ ...said, replayed: true });
    await write(target, 'update_task', { task: renamed.id, priority: 0 });
    expect(await write(target, 'comment_on_task', say)).toMatchObject({ replayed: false });
    expect(await engine.listComments(project.id, renamed.id)).toHaveLength(2);
  });

  it('names the task and the argument a refused write breaks, and says nothing was written', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const kin = await task(project, { title: 'Kin' });
    expect(
      await refusalOf(target, 'update_task', { workspace: WORKSPACE.id, task: id, related: [kin.id, 'Not An Id'] }),
    ).toMatchObject({ sentence: 'invalid arguments: related[1] (a task id such as abc-1x2)', task: id, retry: 'safe' });
    expect((await current(project, id)).version).toBe(1);
  });
});

describe('create_task', () => {
  it('files a task with its fields, links, card and change class, crediting the filer and model', async () => {
    const project = await newProject(engine);
    const elsewhere = await newProject(engine);
    const epic = await task(project, { title: 'Epic', type: 'epic' });
    const before = await task(project, { title: 'Before' });
    const after = await task(project, { title: 'After' });
    const kin = await task(elsewhere, { title: 'Kin elsewhere' });
    const found = await task(project, { title: 'Found here' });
    const card = {
      valuePerMonth: 120,
      likelihood: 0.4,
      reviewMinutes: 10,
      daysToSignal: 30,
      measurability: 'cohort',
      kill: { state: 'No lift', date: '2027-01-31' },
      by: 'someone else',
      at: '2020-01-01T00:00:00Z',
    };
    const metadata = {
      noticeos_source: 'noticeos-handoff',
      noticeos_asset: 'example.com',
      noticeos_kind: 'finding',
      noticeos_rule: 'rule-1',
      noticeos_key: 'key-1',
    };
    const reply = await write<{ id: string }>(target, 'create_task', {
      project: project.id,
      title: 'Write the pricing page',
      description: 'WHAT: the page.',
      type: 'feature',
      priority: 1,
      labels: ['copy', 'web'],
      parent: epic.id,
      acceptance: 'The page is live.',
      depends_on: [before.id],
      blocks: [after.id],
      related: [kin.id],
      discovered_from: [found.id],
      card,
      change_class: 'copy',
      metadata,
      model: 'model-x',
      idempotency_key: key(),
    });

    // The answer names the task, its status and version, and leaves its text out.
    expect(reply).toEqual({ id: `${epic.id}.1`, status: 'open', version: 1, replayed: false });
    const filed = await current(project, reply.id);
    expect(filed).toMatchObject({
      title: 'Write the pricing page',
      type: 'feature',
      priority: 1,
      labels: ['copy', 'web'],
      parentId: epic.id,
      filedBy: WRITER.name,
      filedModel: 'model-x',
      dueAt: '2027-01-31T00:00:00.000Z',
      ready: false,
    });
    expect(filed.dependencies.map((link) => [link.taskId, link.type])).toEqual(
      [
        [before.id, 'blocks'],
        [kin.id, 'related'],
        [found.id, 'discovered-from'],
      ].sort(([a], [b]) => (a! < b! ? -1 : 1)),
    );
    expect((await current(project, after.id)).dependencies.map((link) => link.taskId)).toEqual([reply.id]);
    expect(filed.metadata).toEqual({
      ...metadata,
      noticeos_card: {
        valuePerMonth: 120,
        likelihood: 0.4,
        reviewMinutes: 10,
        daysToSignal: 30,
        measurability: 'cohort',
        kill: { state: 'No lift', date: '2027-01-31' },
        by: WRITER.name,
        at: time.now(),
      },
      noticeos_change_class: 'copy',
    });
    const read = await write<{ task: Record<string, unknown> }>(target, 'get_task', {
      project: project.id,
      task: reply.id,
    });
    expect(read.task).toMatchObject({ changeClass: 'copy', card: filed.metadata.noticeos_card });
  });

  it('opens the approval it names with the task, in the same write', async () => {
    const project = await newProject(engine);
    const reply = await write<Record<string, unknown> & { id: string; approval: { id: string } }>(
      target,
      'create_task',
      {
        project: project.id,
        title: 'Deploy the Worker',
        approval: 'Deploy to the production account.',
        idempotency_key: key(),
      },
    );
    expect(reply).toMatchObject({
      approval: { status: 'open', reason: 'Deploy to the production account.' },
      held: true,
      note: `${reply.id} waits for the owner’s scoped approval of ${reply.approval.id}. Record an existing answer with reconcile_task; never ask for the same approval again.`,
    });
    const filed = await current(project, reply.id);
    expect(filed.ready).toBe(false);
    expect(filed.dependencies).toEqual([
      { taskId: reply.approval.id, type: 'blocks', title: 'Deploy to the production account.', status: 'open' },
    ]);
    expect(await current(project, reply.approval.id)).toMatchObject({ type: 'gate', awaitType: 'human' });
  });

  it('names the sections lint finds missing, and advises choices for lettered options', async () => {
    const project = await newProject(engine);
    const reply = await write<{ lint: unknown }>(target, 'create_task', {
      project: project.id,
      title: 'Pick a host',
      type: 'bug',
      labels: ['human'],
      description: 'Which host?\n(a) One\n(b) Two',
      idempotency_key: key(),
    });
    expect(reply.lint).toEqual({
      missing: ['## Steps to Reproduce', '## Acceptance Criteria'],
      advice: [CHOICES_ADVICE],
    });
  });

  it('advises on a title over 70 characters, or one holding a command, a file path or a commit hash', async () => {
    const project = await newProject(engine);
    const long = `Make ${'every page '.repeat(9)}load in a second`;
    expect(long).toHaveLength(120);
    const titles: readonly [string, readonly string[]][] = [
      [long, []],
      ['Deploy with wrangler deploy --env production', ['command']],
      ['Run pnpm os:update on the host', ['command']],
      ['Fix the lint in workers/api/src/mcp/guide.ts', ['file path']],
      ['Run ./update.sh on the demo host', ['file path']],
      ['Revert ba05bed67f1 on main', ['commit hash']],
      ['Ship `git push` and ba05bed67f1', ['command', 'commit hash']],
    ];
    for (const [title, holds] of titles) {
      expect(titleHolds(title)).toEqual(holds);
      const reply = await write<{ lint: { advice: readonly string[] } }>(target, 'create_task', {
        project: project.id,
        title,
        type: 'chore',
        idempotency_key: key(),
      });
      expect(reply.lint.advice).toEqual(titleAdvice(title));
      expect(reply.lint.advice).toHaveLength(title.length > 70 ? holds.length + 1 : 1);
    }
    // Plain titles, domains, owner/repo#123 and words joined by one slash hold none of them.
    for (const title of [
      'Approve updating demo.notice.cx so the demo runs its own Ntasks',
      'Merge notice-cx/Ntasks#83 once review is done',
      'Give agents read/write access to the docs project',
      'Upgrade pnpm to 12 and Node.js to 24',
      'Count 1234567 rows and the facade cache',
    ]) {
      expect(titleHolds(title)).toEqual([]);
      const reply = await write<Record<string, unknown>>(target, 'create_task', {
        project: project.id,
        title,
        type: 'chore',
        idempotency_key: key(),
      });
      expect(reply).not.toHaveProperty('lint');
    }
  });

  it('advises on a command written inline in a description, a block with no language tag, and a $ prompt', async () => {
    const project = await newProject(engine);
    const fenced = (info: string, line: string) =>
      ['Ship the release to production.', '', '```' + info, line, '```'].join('\n');
    const descriptions: readonly [string, readonly string[]][] = [
      ['Deploy the API: run `pnpm run deploy` from the root.', ['inline command']],
      ['Check the rows with `SELECT count(*) FROM tasks` first.', ['inline command']],
      ['Run `./update.sh --commit 1a2b3c4` on the host.', ['inline command']],
      [fenced('', 'pnpm run deploy'), ['untagged block']],
      [fenced('bash', '$ pnpm run deploy'), ['prompt']],
      [`Run \`git push\` first.\n\n${fenced('', '$ pnpm run deploy')}`, ['inline command', 'untagged block', 'prompt']],
    ];
    for (const [description, holds] of descriptions) {
      expect(descriptionHolds(description)).toEqual(holds);
      const reply = await write<{ lint: { advice: readonly string[] } }>(target, 'create_task', {
        project: project.id,
        title: 'Deploy the API',
        type: 'chore',
        description,
        idempotency_key: key(),
      });
      expect(reply.lint.advice).toEqual(descriptionAdvice(description));
      expect(reply.lint.advice).toHaveLength(holds.length);
    }
    // A command in a tagged block, an indented one in a list, and names that are not run hold none.
    for (const description of [
      fenced('bash', 'pnpm run deploy'),
      ['1. On the host:', '', '   ```bash', '   ./update.sh --commit 1a2b3c4', '   ```'].join('\n'),
      'Change `workers/api/src/mcp/guide.ts` and set `AUTH_SECRET`; `pnpm` and `get_task_guide` are names.',
      'A refused change answers `403`; `GET /api/tasks` lists them.',
    ]) {
      expect(descriptionHolds(description)).toEqual([]);
      const reply = await write<Record<string, unknown>>(target, 'create_task', {
        project: project.id,
        title: 'Deploy the API',
        type: 'chore',
        description,
        idempotency_key: key(),
      });
      expect(reply).not.toHaveProperty('lint');
    }
  });

  it('advises on a description whose first line repeats the title', async () => {
    const project = await newProject(engine);
    const title = 'Approve merging the API pull request';
    for (const description of [title, `## ${title.toLowerCase()}.\n\nIt adds a column.`, `\n**${title}**`]) {
      expect(repeatsTitle(title, description)).toBe(true);
      const reply = await write<{ lint: { advice: readonly string[] } }>(target, 'create_task', {
        project: project.id,
        title,
        type: 'chore',
        description,
        idempotency_key: key(),
      });
      expect(reply.lint.advice).toEqual(repeatAdvice(title, description));
      expect(reply.lint.advice).toHaveLength(1);
    }
    const added = 'Approve merging the API pull request, so agents can file Do checklists.';
    expect(repeatsTitle(title, added)).toBe(false);
    const reply = await write<Record<string, unknown>>(target, 'create_task', {
      project: project.id,
      title,
      type: 'chore',
      description: added,
      idempotency_key: key(),
    });
    expect(reply).not.toHaveProperty('lint');
  });

  it("advises on a person's ask that names no place to act, unless its choices are buttons", async () => {
    const project = await newProject(engine);
    const ask = (description: string, extra: Record<string, unknown> = {}) =>
      write<Record<string, unknown> & { id: string; lint?: { advice: readonly string[] } }>(target, 'create_task', {
        project: project.id,
        title: 'Choose the domain for the docs',
        type: 'chore',
        labels: ['human'],
        description,
        idempotency_key: key(),
        ...extra,
      });
    const vague = 'You: decide which domain the docs move to, since only you hold the registrar account.';
    expect(namesPlaceToAct(vague)).toBe(false);
    // Words for the decision, and data to read, name no place to act either.
    for (const description of [
      'You: choose or pick which domain the docs move to, then reply.',
      `${vague}\n\n\`\`\`json\n{ "domain": "docs.example.com" }\n\`\`\``,
    ]) {
      expect(namesPlaceToAct(description)).toBe(false);
      expect((await ask(description)).lint!.advice).toHaveLength(1);
    }
    const reply = await ask(vague);
    expect(reply.lint!.advice).toEqual(placeAdvice(await current(project, reply.id)));
    expect(reply.lint!.advice).toHaveLength(1);
    // A link, a button, a command or this task's page is a place to act; so are choices.
    for (const description of [
      `${vague} Reply in https://github.com/example/web/pull/4.`,
      `${vague} Press Answer and name it.`,
      `${vague} Then run:\n\n\`\`\`bash\npnpm run docs:move\n\`\`\``,
      `${vague} Then check:\n\n\`\`\`sql\nSELECT domain FROM sites\n\`\`\``,
      `${vague} Answer on this task.`,
    ]) {
      expect(namesPlaceToAct(description)).toBe(true);
      expect(await ask(description)).not.toHaveProperty('lint');
    }
    const chosen = await ask(vague, {
      choices: {
        question: 'Which domain?',
        options: [
          { key: 'a', label: 'docs.example.com', recommended: true },
          { key: 'b', label: 'example.com/docs' },
        ],
      },
    });
    expect(chosen).not.toHaveProperty('lint');
    // Work no person is asked to do needs no place to act.
    const work = await write<Record<string, unknown>>(target, 'create_task', {
      project: project.id,
      title: 'Move the docs to the new domain',
      type: 'chore',
      description: vague,
      idempotency_key: key(),
    });
    expect(work).not.toHaveProperty('lint');
  });

  it('answers a retry with the task it filed, and refuses the key for a different task', async () => {
    const project = await newProject(engine);
    const args = { project: project.id, title: 'Once only', approval: 'Approve it.', idempotency_key: key() };
    const first = await write<{ id: string; approval: { id: string } }>(target, 'create_task', args);
    const again = await write<{ id: string; replayed: boolean; approval: { id: string } }>(target, 'create_task', args);
    expect(again).toMatchObject({ id: first.id, replayed: true, approval: { id: first.approval.id } });
    expect((await engine.listTasks(project.id, { limit: 10 })).tasks).toHaveLength(2);
    expect(await refusal(target, 'create_task', { workspace: WORKSPACE.id, ...args, title: 'Something else' })).toBe(
      'conflict: this idempotency_key was first used for a different change. Resend that call unchanged to read its result, or choose a new key for this one.',
    );
  });

  it('refuses arguments that break their rules, in the words NoticeOS used', async () => {
    const project = await newProject(engine);
    const other = await newProject(engine);
    const elsewhere = await task(other);
    const refused = (args: Record<string, unknown>) =>
      refusal(target, 'create_task', {
        workspace: WORKSPACE.id,
        project: project.id,
        title: 'T',
        idempotency_key: key(),
        ...args,
      });
    expect(await refused({ title: undefined })).toBe('invalid arguments: title (required)');
    expect(await refused({ type: 'gate' })).toBe(
      'invalid arguments: type (a gate holds another task until a person approves it: pass approval with that task, or call request_human_approval)',
    );
    expect(await refused({ type: 'story' })).toBe(
      'invalid arguments: type (one of task, bug, feature, epic, chore, decision)',
    );
    expect(await refused({ priority: 5 })).toBe('invalid arguments: priority (0–4)');
    expect(await refused({ labels: ['a,b'] })).toBe(
      'invalid arguments: labels (at most 32 labels, each at most 128 characters on one line, without commas or surrounding spaces, none twice)',
    );
    expect(await refused({ parent: `${project.prefix}-a1`, related: [`${project.prefix}-a1`] })).toBe(
      `invalid arguments: related[0] (${project.prefix}-a1 is the parent already; leave it out of the other links)`,
    );
    expect(await refused({ depends_on: ['p-a1'], blocks: ['p-b2', 'p-a1'] })).toBe(
      'invalid arguments: depends_on[0] and blocks[1] (this task cannot both wait on p-a1 and block it)',
    );
    expect(await refused({ blocks: 'p-a1' })).toBe('invalid arguments: blocks (a list of at most 32 task ids)');
    expect(await refused({ card: { valuePerMonth: 1 } })).toBe('invalid arguments: card.likelihood (a number)');
    expect(
      await refused({
        choices: {
          question: 'Which?',
          options: [
            { key: 'a', label: 'One', recommended: true },
            { key: 'b', label: 'Two', recommended: true },
          ],
        },
      }),
    ).toBe('invalid arguments: choices.options (exactly one option with recommended: true; these have 2)');
    expect(await refused({ metadata: { noticeos_source: 'noticeos-handoff' } })).toBe(
      'invalid arguments: metadata (the five bounded handoff source fields only; keep the complete identity unchanged)',
    );
    expect(await refused({ change_class: 'big' })).toBe(
      'invalid arguments: change_class (one of content-data, copy, template, feature, infra)',
    );
    expect(await refused({ model: ' model' })).toBe('invalid arguments: model (one line, no surrounding spaces)');
    expect(await refused({ idempotency_key: 'short' })).toBe(
      'invalid arguments: idempotency_key (8–128 of A–Z a–z 0–9 . _ : -; reuse it when retrying this call)',
    );
    expect(await refused({ colour: 'red' })).toBe('invalid arguments: unknown argument colour');
    expect(await refused({ parent: `${project.prefix}-none` })).toBe(
      `refused: ${project.prefix}-none is not a task in projectId ${project.id} (${project.name}); list_tasks lists its tasks.`,
    );
    expect(await refused({ depends_on: [elsewhere.id] })).toBe(
      `refused: ${elsewhere.id} is not in projectId ${project.id} (${project.name}), whose tasks start ${project.prefix}-; tasks with prefix ${other.prefix} are in projectId ${other.id} (${other.name}).`,
    );
    expect(await refused({ project: 'missing' })).toBe(missingProject('missing'));
    expect((await engine.listTasks(project.id, { limit: 10 })).tasks).toEqual([]);
  });

  it('reads an object argument sent as text, saying the client is out of date', async () => {
    const project = await newProject(engine);
    const reply = await write<{ id: string; staleClient: string }>(target, 'create_task', {
      project: project.id,
      title: 'Old client',
      change_class: 'infra',
      card: JSON.stringify({
        valuePerMonth: 1,
        likelihood: 0.5,
        reviewMinutes: 1,
        daysToSignal: 1,
        measurability: 'holdout',
      }),
      idempotency_key: key(),
    });
    expect(reply.staleClient).toMatch(
      /^card arrived as text: your client's copy of the task tools predates this server \(guide version [0-9a-f]{12}\); reconnect this server to get the current tools$/u,
    );
    expect((await current(project, reply.id)).metadata.noticeos_card).toMatchObject({ measurability: 'holdout' });
  });

  it('reads object text in an entry of create_tasks and a null in update_task, and refuses text that is no object', async () => {
    const project = await newProject(engine);
    const guide = (await callTool<{ version: string }>(target, 'get_task_guide')).value!.version;
    const stale = (names: string) =>
      `${names} arrived as text: your client's copy of the task tools predates this server (guide version ${guide}); reconnect this server to get the current tools`;
    const card = { valuePerMonth: 1, likelihood: 0.5, reviewMinutes: 1, daysToSignal: 1, measurability: 'cohort' };
    const batch = await write<{ staleClient: string; results: { id: string }[] }>(target, 'create_tasks', {
      project: project.id,
      tasks: [{ title: 'Plain' }, { title: 'Carded', card: JSON.stringify(card) }],
      idempotency_key: key(),
    });
    expect(batch.staleClient).toBe(stale('tasks[1].card'));
    expect((await current(project, batch.results[1]!.id)).metadata.noticeos_card).toMatchObject(card);

    const chosen = await task(project, {
      title: 'Choices',
      choices: {
        question: 'Which?',
        options: [
          { key: 'a', label: 'One', recommended: true },
          { key: 'b', label: 'Two' },
        ],
      },
    });
    const cleared = await write<{ staleClient: string }>(target, 'update_task', {
      project: project.id,
      task: chosen.id,
      choices: 'null',
      idempotency_key: key(),
    });
    expect(cleared.staleClient).toBe(stale('choices'));
    expect((await current(project, chosen.id)).choices).toBeNull();

    const refused = await refusal(target, 'create_task', {
      workspace: WORKSPACE.id,
      project: project.id,
      title: 'Bad card',
      card: 'not an object',
      idempotency_key: key(),
    });
    // Text that is no object stays text, for the card's own check to refuse.
    expect(refused).toBe(
      `${stale('card')}. invalid arguments: card (an object with valuePerMonth, likelihood, reviewMinutes, daysToSignal and measurability)`,
    );
  });
});

describe('a create whose blocked task keeps changing', () => {
  it('answers that the change did not land, for create_task and for an entry of create_tasks', async () => {
    const project = await newProject(engine);
    const other = await task(project, { title: 'Busy' });
    const busy = api({
      principal: WRITER,
      engine,
      wrap: (inner) => ({
        ...inner,
        // What the engine answers once its own retries are spent.
        createTask: async () => {
          throw new TaskRefused('version_conflict', 'A task this new one blocks kept changing; try again.');
        },
      }),
    });
    const unavailable =
      "unavailable: the task store did not complete this call, and nothing in the task's state explains it. Retry the same call; with the same idempotency_key a change lands at most once.";
    expect(
      await refusal(busy, 'create_task', {
        workspace: WORKSPACE.id,
        project: project.id,
        title: 'Blocks it',
        blocks: [other.id],
        idempotency_key: key(),
      }),
    ).toBe(unavailable);
    expect(
      await write(busy, 'create_tasks', {
        project: project.id,
        tasks: [{ title: 'Blocks it', blocks: [other.id] }],
        idempotency_key: key(),
      }),
    ).toEqual({ results: [{ index: 0, error: unavailable }], retry: expect.any(String) });
  });
});

describe('create_tasks', () => {
  it('files several tasks in order, an entry naming an earlier one by its place', async () => {
    const project = await newProject(engine);
    const args = {
      project: project.id,
      tasks: [
        { title: 'Epic', type: 'epic' },
        { title: 'Child', parent: '#0', acceptance: 'Done when done.' },
        { title: 'Gated', depends_on: ['#1'], approval: 'Approve it.' },
      ],
      model: 'model-x',
      idempotency_key: key(),
    };
    const reply = await write<{ results: { id: string; replayed: boolean }[]; note?: string }>(
      target,
      'create_tasks',
      args,
    );
    const [epic, child, gated] = reply.results.map((entry) => entry.id);
    expect(reply).toMatchObject({
      results: [
        { index: 0, id: epic, status: 'open', replayed: false, lint: { missing: ['## Success Criteria'] } },
        { index: 1, id: `${epic}.1`, status: 'open', replayed: false },
        { index: 2, id: gated, replayed: false, approval: { status: 'open', reason: 'Approve it.' }, held: true },
      ],
      note: 'A task with an approval waits for the owner’s scoped approval. Record an existing answer with reconcile_task.',
    });
    expect((await current(project, gated!)).dependencies.map((link) => link.taskId)).toContain(child);

    const again = await write<{ results: { id: string; replayed: boolean }[] }>(target, 'create_tasks', args);
    expect(again.results.map((entry) => [entry.id, entry.replayed])).toEqual(
      reply.results.map((entry) => [entry.id, true]),
    );
    expect((await engine.listTasks(project.id, { limit: 10 })).tasks).toHaveLength(4);
  });

  it('files every task it can, refusing one alone, and lets #n name a later task of the call', async () => {
    const project = await newProject(engine);
    const missing = `${project.prefix}-none`;
    const args = {
      project: project.id,
      tasks: [
        { title: 'Child', parent: '#2' },
        { title: 'Under a missing parent', parent: missing },
        { title: 'Epic', type: 'epic' },
        { title: 'Waits on the refused one', depends_on: ['#1'] },
        { title: '' },
        { title: 'Names no task of the call', blocks: ['#7'] },
      ],
    };
    type Result = { index: number; id?: string; error?: string };
    const reply = await write<{ results: Result[]; retry?: string }>(target, 'create_tasks', args);
    const [child, orphan, epic, waits, empty, outside] = reply.results;
    expect(epic).toMatchObject({ index: 2, status: 'open', replayed: false });
    expect(child).toMatchObject({ index: 0, id: `${epic!.id}.1`, status: 'open' });
    expect(orphan).toEqual({
      index: 1,
      error: `refused: ${missing} is not a task in projectId ${project.id} (${project.name}); list_tasks lists its tasks.`,
    });
    expect(waits).toEqual({ index: 3, error: expect.stringContaining('#1') });
    expect(empty).toEqual({ index: 4, error: 'invalid arguments: tasks[4].title (empty)' });
    expect(outside).toEqual({
      index: 5,
      error: expect.stringMatching(/^invalid arguments: tasks\[5\]\.blocks\[0\] /u),
    });
    expect(reply.retry).toEqual(expect.any(String));
    expect((await engine.listTasks(project.id, { limit: 10 })).tasks.map((row) => row.id).sort()).toEqual(
      [epic!.id, child!.id].sort(),
    );
    // Sent again, the tasks filed answer as they were, and the refused ones are tried again.
    const again = await write<{ results: Result[] }>(target, 'create_tasks', args);
    expect(again.results.map((result) => result.id ?? null)).toEqual([child!.id, null, epic!.id, null, null, null]);
  });

  it('refuses the tasks that name each other in a loop, naming the loop, and files the rest', async () => {
    const project = await newProject(engine);
    const reply = await write<{ results: { index: number; id?: string; error?: string }[] }>(target, 'create_tasks', {
      project: project.id,
      tasks: [{ title: 'A', depends_on: ['#1'] }, { title: 'B', parent: '#0' }, { title: 'C' }],
    });
    const [first, second, third] = reply.results;
    for (const looped of [first, second]) {
      expect(looped?.error).toMatch(/^refused: /u);
      expect(looped?.error).toContain('#0');
      expect(looped?.error).toContain('#1');
    }
    expect(third).toMatchObject({ index: 2, status: 'open' });
    expect((await engine.listTasks(project.id, { limit: 10 })).tasks.map((row) => row.id)).toEqual([third!.id]);
  });

  it('refuses a call it cannot file any of, filing nothing', async () => {
    const project = await newProject(engine);
    const refused = (args: Record<string, unknown>) =>
      refusal(target, 'create_tasks', {
        workspace: WORKSPACE.id,
        project: project.id,
        idempotency_key: key(),
        ...args,
      });
    expect(await refused({ tasks: [] })).toBe('invalid arguments: tasks (1–25)');
    expect(await refused({ tasks: [{ title: 'A', model: 'x' }] })).toBe(
      'invalid arguments: unknown argument tasks[0].model',
    );
    expect(await refused({ project: 'missing', tasks: [{ title: 'A' }] })).toBe(missingProject('missing'));
    expect((await engine.listTasks(project.id, { limit: 10 })).tasks).toEqual([]);
  });
});

describe('claim_task', () => {
  it('assigns an open task to the sender, starts it and records the model', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const reply = await write(target, 'claim_task', {
      project: project.id,
      task: id,
      model: 'model-x',
      idempotency_key: key(),
    });
    expect(reply).toEqual({ id, status: 'in_progress', assignee: WRITER.name, version: 2, replayed: false });
    expect(await current(project, id)).toMatchObject({ assigneeModel: 'model-x', startedAt: time.now() });
  });

  it("answers a claim on a task in an epic with the epic's pinned comments and its closed tasks' closes", async () => {
    const project = await newProject(engine);
    const epic = await task(project, { title: 'Rebuild the pages', type: 'epic' });
    const done = await task(project, { title: 'Rebuild the home page', parentId: epic.id });
    await engine.writeTask(
      project.id,
      done.id,
      {
        expectedVersion: 1,
        close: { reason: 'Merged; the header is shared now.', resolution: 'done', commit: 'a1b2c3d4' },
      },
      OWNER,
    );
    const fact = (
      await engine.addComment(project.id, epic.id, 'Every page uses the shared header.', AGENT, undefined, {
        pin: true,
      })
    ).comment;
    const { id } = await task(project, { title: 'Rebuild the pricing page', parentId: epic.id });
    const reply = await write<{ parent: Record<string, unknown> }>(target, 'claim_task', { task: id });
    expect(reply).toMatchObject({ id, status: 'in_progress', assignee: WRITER.name });
    expect(reply.parent).toEqual({
      id: epic.id,
      title: 'Rebuild the pages',
      type: 'epic',
      status: 'open',
      pinned: [{ id: fact.id, author: AGENT.name, text: fact.text, createdAt: fact.createdAt }],
      pinnedTotal: 1,
      closedSiblings: [
        {
          id: done.id,
          title: 'Rebuild the home page',
          resolution: 'done',
          closedAt: expect.any(String),
          closedBy: OWNER.name,
          closeReason: 'Merged; the header is shared now.',
          commit: 'a1b2c3d4',
          pullRequest: null,
          closeLink: null,
        },
      ],
      closedSiblingsTotal: 1,
    });
    // A task with no parent answers as before.
    const alone = await task(project);
    expect(await write(target, 'claim_task', { task: alone.id })).not.toHaveProperty('parent');
  });

  it('lists the other work in progress that touches the same files, never refusing the claim', async () => {
    const project = await newProject(engine);
    const elsewhere = await newProject(engine);
    const holding = async (where: Project, title: string, touches: string[], status: 'in_progress' | 'blocked') => {
      const held = await task(where, { title });
      await engine.writeTask(
        where.id,
        held.id,
        {
          expectedVersion: 1,
          set: { assignee: AGENT.name, status, work: { pr: 'https://example.com/pull/7', touches } },
        },
        AGENT,
      );
      return held;
    };
    const baseline = await holding(project, 'Shrink the bundle', ['scripts/bundle-baseline.json'], 'in_progress');
    const migrations = await holding(project, 'Add a column', ['workers/api/src/store/migrations'], 'blocked');
    await holding(project, 'Rename the header', ['src/header.tsx'], 'in_progress');
    await holding(elsewhere, 'Same file in another repository', ['scripts/bundle-baseline.json'], 'in_progress');
    const { id } = await task(project, { title: 'Split the sign-in page' });
    const touches = ['./scripts/bundle-baseline.json', 'workers/api/src/store/migrations/0007_sign_in.sql'];

    const claimed = await write<{ overlaps: { id: string }[] }>(target, 'claim_task', { task: id, touches });
    expect(claimed).toMatchObject({ id, status: 'in_progress', assignee: WRITER.name });
    // Both were filed at the same moment, so either may come first; the check reads them in a fixed order.
    expect(claimed.overlaps.toSorted((a, b) => (a.id === baseline.id ? -1 : b.id === baseline.id ? 1 : 0))).toEqual([
      {
        id: baseline.id,
        title: 'Shrink the bundle',
        assignee: AGENT.name,
        status: 'in_progress',
        pr: 'https://example.com/pull/7',
        touches: ['scripts/bundle-baseline.json'],
        mergeOrder: null,
      },
      {
        id: migrations.id,
        title: 'Add a column',
        assignee: AGENT.name,
        status: 'blocked',
        pr: 'https://example.com/pull/7',
        touches: ['workers/api/src/store/migrations'],
        mergeOrder: null,
      },
    ]);
    expect((await current(project, id)).work.touches).toEqual(touches);

    // Once the order is recorded, the answer says which way it goes.
    await write(target, 'link_tasks', { task: id, to: baseline.id, type: 'merges-after' });
    const noted = await write<{ overlaps: { id: string; mergeOrder: string | null }[] }>(target, 'comment_on_task', {
      task: id,
      text: 'The baseline changes after the bundle work lands.',
      touches: ['scripts/bundle-baseline.json'],
    });
    expect(noted.overlaps.map(({ id: other, mergeOrder }) => [other, mergeOrder])).toEqual([[baseline.id, 'after']]);
    expect((await current(project, id)).work.touches).toEqual(['scripts/bundle-baseline.json']);

    // A claim with nothing in common, or with no touches, answers no overlaps; [] takes the list off.
    const plain = await task(project, { title: 'Write the release notes' });
    expect(await write(target, 'claim_task', { task: plain.id, touches: ['docs/releases.md'] })).not.toHaveProperty(
      'overlaps',
    );
    expect(await write(target, 'comment_on_task', { task: id, text: 'Moved on.', touches: [] })).not.toHaveProperty(
      'overlaps',
    );
    expect((await current(project, id)).work).not.toHaveProperty('touches');
    expect(await refusal(target, 'claim_task', { workspace: WORKSPACE.id, task: plain.id, touches: ['a\nb'] })).toBe(
      'invalid arguments: touches[0] (one line of 1 to 200 characters)',
    );
  });

  it('answers a retry with the same claim, and refuses the key for a different claim', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const args = { project: project.id, task: id, model: 'model-x', idempotency_key: key() };
    await write(target, 'claim_task', args);
    const again = await write<{ replayed: boolean }>(target, 'claim_task', args);
    expect(again.replayed).toBe(true);
    expect((await current(project, id)).version).toBe(2);
    expect(await refusal(target, 'claim_task', { workspace: WORKSPACE.id, ...args, model: 'model-y' })).toMatch(
      /^conflict: this idempotency_key was first used for a different change/u,
    );
  });

  it('refuses a task someone else holds, a closed one and one that is not open', async () => {
    const project = await newProject(engine);
    const held = await task(project);
    await engine.writeTask(
      project.id,
      held.id,
      { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress' } },
      AGENT,
    );
    const closed = await task(project);
    await engine.writeTask(
      project.id,
      closed.id,
      { expectedVersion: 1, close: { reason: 'Done.', resolution: 'done' } },
      OWNER,
    );
    const blocker = await task(project);
    const blocked = await task(project, {
      title: 'Blocked',
      links: [{ direction: 'depends-on', taskId: blocker.id, type: 'blocks' }],
    });
    await engine.writeTask(project.id, blocked.id, { expectedVersion: 1, set: { status: 'blocked' } }, OWNER);
    const claim = (id: string) =>
      refusal(target, 'claim_task', { workspace: WORKSPACE.id, project: project.id, task: id, idempotency_key: key() });

    expect(await claim(held.id)).toBe(
      `refused: ${held.id} is held by ${AGENT.name}. Choose another task, or reach ${AGENT.name} with comment_on_task.`,
    );
    expect(await claim(closed.id)).toBe(
      `refused: ${closed.id} is closed, so it cannot be claimed. File work that remains with create_task.`,
    );
    expect(await claim(blocked.id)).toBe(
      `refused: ${blocked.id} has status blocked, and claim_task takes an open task. It depends on ${blocker.id}, still open. To work on it now, set its status to open with update_task, then claim it.`,
    );
  });

  it('lets exactly one of two agents claiming at once take the task (rule 1)', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const first = api({ principal: granted({ [project.id]: 'write' }, 'agent-1'), engine });
    const second = api({ principal: granted({ [project.id]: 'write' }, 'agent-2'), engine });
    const answers = await Promise.all(
      [first, second].map((sender) =>
        callTool(sender, 'claim_task', {
          workspace: WORKSPACE.id,
          project: project.id,
          task: id,
          idempotency_key: key(),
        }),
      ),
    );
    expect(answers.filter((answer) => answer.refused === null)).toHaveLength(1);
    const holder = (await current(project, id)).assignee;
    expect(answers.find((answer) => answer.refused !== null)?.refused).toBe(
      `refused: ${id} is held by ${holder}. Choose another task, or reach ${holder} with comment_on_task.`,
    );
  });
});

describe('the work a task shows', () => {
  type Shown = Record<string, unknown>;
  const getTask = async (project: Project, id: string) =>
    (await read<{ task: Shown }>(target, 'get_task', { project: project.id, task: id })).task;

  it('shows the helper and work details a claim names, and the holder’s last activity, in get_task and list_tasks', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const claimedAt = time.now();
    const claimed = await write(target, 'claim_task', {
      project: project.id,
      task: id,
      for: 'page-rebuild-2',
      branch: 'agent/page-rebuild',
      worktree: '/work/page-rebuild',
      pr: 'https://example.com/pulls/7',
      idempotency_key: key(),
    });
    const work = { worktree: '/work/page-rebuild', branch: 'agent/page-rebuild', pr: 'https://example.com/pulls/7' };
    // The claim's answer shows the helper and work details it recorded.
    expect(claimed).toMatchObject({ id, status: 'in_progress', for: 'page-rebuild-2', work });
    expect(await getTask(project, id)).toMatchObject({
      assignee: WRITER.name,
      for: 'page-rebuild-2',
      work,
      lastActivityAt: claimedAt,
    });
    const { tasks } = await read<{ tasks: Shown[] }>(target, 'list_tasks', { project: project.id });
    expect(tasks.find((row) => row.id === id)).toMatchObject({
      assignee: WRITER.name,
      for: 'page-rebuild-2',
      lastActivityAt: claimedAt,
    });

    // One holder: another agent naming its own helper is still refused, and the work stays the holder's.
    time.advance(5);
    const rival = api({ principal: granted({ [project.id]: 'write' }, 'agent-r'), engine, now: time.now });
    await refusal(rival, 'claim_task', {
      workspace: WORKSPACE.id,
      project: project.id,
      task: id,
      for: 'other-helper',
      idempotency_key: key(),
    });
    expect(await getTask(project, id)).toMatchObject({
      assignee: WRITER.name,
      for: 'page-rebuild-2',
      work,
      lastActivityAt: claimedAt,
    });
  });

  it('updates the work from its holder’s comments, which move its last activity, and from nobody else’s', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    await write(target, 'claim_task', {
      project: project.id,
      task: id,
      branch: 'agent/fix',
      next: 'Write the test',
      idempotency_key: key(),
    });
    time.advance(12);
    const update = {
      project: project.id,
      task: id,
      text: 'Pushed; CI runs.',
      next: 'Wait for CI',
      commit: 'abc1234',
      idempotency_key: key(),
    };
    const first = await write(target, 'comment_on_task', update);
    const commentedAt = time.now();
    const after = await getTask(project, id);
    expect(after).toMatchObject({
      work: { branch: 'agent/fix', commit: 'abc1234', next: 'Wait for CI' },
      lastActivityAt: commentedAt,
    });
    // A retry adds nothing.
    expect(await write(target, 'comment_on_task', update)).toEqual({ ...first, replayed: true });
    expect(await engine.listComments(project.id, id)).toHaveLength(1);

    const other = api({ principal: granted({ [project.id]: 'write' }, 'agent-o'), engine, now: time.now });
    time.advance(5);
    await refusal(other, 'comment_on_task', {
      workspace: WORKSPACE.id,
      project: project.id,
      task: id,
      text: 'Taking over.',
      next: 'Something else',
      idempotency_key: key(),
    });
    await write(other, 'comment_on_task', {
      project: project.id,
      task: id,
      text: 'Looks good.',
      idempotency_key: key(),
    });
    expect(await getTask(project, id)).toMatchObject({ work: after.work, lastActivityAt: commentedAt });

    // The holder's plain comment, or one repeating its details, is activity that leaves the version.
    const version = (await current(project, id)).version;
    time.advance(5);
    await write(target, 'comment_on_task', {
      project: project.id,
      task: id,
      text: 'Still waiting.',
      next: 'Wait for CI',
      idempotency_key: key(),
    });
    expect(await current(project, id)).toMatchObject({ version, lastActivityAt: time.now() });
  });

  it('clears the helper and work details when the task closes or is released, and its history keeps them', async () => {
    const project = await newProject(engine);
    const closing = await task(project);
    const releasing = await task(project);
    for (const { id } of [closing, releasing]) {
      await write(target, 'claim_task', {
        project: project.id,
        task: id,
        for: 'helper-1',
        branch: 'agent/work',
        idempotency_key: key(),
      });
    }
    await write(target, 'close_task', {
      project: project.id,
      task: closing.id,
      reason: 'Done in abc1234.',
      idempotency_key: key(),
    });
    await write(target, 'update_task', {
      project: project.id,
      task: releasing.id,
      assignee: '',
      idempotency_key: key(),
    });
    expect(await getTask(project, closing.id)).toMatchObject({ status: 'closed', for: null, work: {} });
    expect(await getTask(project, releasing.id)).toMatchObject({
      assignee: null,
      for: null,
      work: {},
      lastActivityAt: null,
    });
    const { changes } = await read<{ changes: { fields: Record<string, { old: unknown; new: unknown }> }[] }>(
      target,
      'get_task_history',
      { project: project.id, task: closing.id },
    );
    const [closed, claimed] = changes;
    expect(closed!.fields).toMatchObject({
      assigneeFor: { old: 'helper-1', new: null },
      work: { old: { branch: 'agent/work' }, new: {} },
    });
    expect(claimed!.fields).toMatchObject({
      assigneeFor: { old: null, new: 'helper-1' },
      work: { old: {}, new: { branch: 'agent/work' } },
    });
  });
});

describe('update_task', () => {
  it('changes the fields it names, with lint for what the task still lacks', async () => {
    const project = await newProject(engine);
    const elsewhere = await newProject(engine);
    const epic = await task(project, { title: 'Epic', type: 'epic' });
    const kin = await task(elsewhere, { title: 'Kin' });
    const { id } = await task(project, { title: 'Old', parentId: epic.id, labels: ['old'] });
    const reply = await write(target, 'update_task', {
      project: project.id,
      task: id,
      title: 'New',
      priority: 0,
      status: 'blocked',
      description: 'WHAT: it.',
      parent: '',
      defer: '2027-01-02',
      add_labels: ['new'],
      remove_labels: ['old'],
      related: [kin.id],
      card: {
        valuePerMonth: 10,
        likelihood: 0.5,
        reviewMinutes: 5,
        daysToSignal: 7,
        measurability: 'unmeasured',
        kill: { state: 'Nothing', date: '2027-02-01' },
      },
      change_class: 'feature',
      choices: {
        question: 'Which?',
        options: [
          { key: 'a', label: 'One', recommended: true },
          { key: 'b', label: 'Two' },
        ],
      },
      idempotency_key: key(),
    });
    // The answer shows each field the call changed, but not the long text it sent.
    expect(reply).toMatchObject({
      id,
      title: 'New',
      priority: 0,
      status: 'blocked',
      parent: null,
      deferUntil: '2027-01-02T00:00:00.000Z',
      labels: ['new'],
      dependencies: [{ id: kin.id, type: 'related' }],
      changeClass: 'feature',
      version: 2,
      replayed: false,
      lint: { missing: ['## Acceptance Criteria'] },
    });
    expect(reply).not.toHaveProperty('description');
    expect(await current(project, id)).toMatchObject({
      deferUntil: '2027-01-02T00:00:00.000Z',
      dueAt: '2027-02-01T00:00:00.000Z',
      dependencies: [{ taskId: kin.id, type: 'related', title: 'Kin', status: 'open' }],
      choices: {
        question: 'Which?',
        options: [
          { key: 'a', label: 'One', recommended: true },
          { key: 'b', label: 'Two' },
        ],
      },
    });

    await write(target, 'update_task', {
      project: project.id,
      task: id,
      card: null,
      change_class: null,
      choices: null,
      idempotency_key: key(),
    });
    const cleared = await current(project, id);
    expect([cleared.metadata, cleared.choices, cleared.dueAt]).toEqual([{}, null, '2027-02-01T00:00:00.000Z']);
  });

  it('advises on a title over 70 characters, or one holding a command, when it changes the title', async () => {
    const project = await newProject(engine);
    const { id } = await task(project, { title: 'Tidy the docs', type: 'chore' });
    for (const title of [`Tidy ${'the docs and '.repeat(9)}the guide`, 'Tidy the docs with pnpm run format']) {
      const reply = await write<{ lint: { advice: readonly string[] } }>(target, 'update_task', {
        project: project.id,
        task: id,
        title,
        idempotency_key: key(),
      });
      expect(reply.lint.advice).toEqual(titleAdvice(title));
      expect(reply.lint.advice).toHaveLength(1);
    }
    const fixed = await write<Record<string, unknown>>(target, 'update_task', {
      project: project.id,
      task: id,
      title: 'Tidy the docs',
      idempotency_key: key(),
    });
    expect(fixed).not.toHaveProperty('lint');
  });

  it('gives a task to the name it is sent, and releases it with ""', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const assign = (assignee: string) =>
      write<{ assignee: string | null }>(target, 'update_task', {
        project: project.id,
        task: id,
        assignee,
        idempotency_key: key(),
      });
    expect((await assign('agent-c')).assignee).toBe('agent-c');
    expect((await assign('')).assignee).toBeNull();
  });

  it('records the key of a change that changed nothing, so a retry replays it and the key stays its own', async () => {
    const project = await newProject(engine);
    const { id } = await task(project, { title: 'Same', priority: 2 });
    const args = { project: project.id, task: id, title: 'Same', idempotency_key: key() };
    expect(await write(target, 'update_task', args)).toMatchObject({ replayed: false, title: 'Same' });
    await engine.writeTask(project.id, id, { expectedVersion: 1, set: { title: 'Renamed since' } }, OWNER);

    // The retry answers what the first call did; it does not write "Same" over the newer title.
    expect(await write(target, 'update_task', args)).toMatchObject({ replayed: true, title: 'Renamed since' });
    expect(await current(project, id)).toMatchObject({ title: 'Renamed since', version: 2 });
    expect(await refusal(target, 'update_task', { workspace: WORKSPACE.id, ...args, priority: 0 })).toMatch(
      /^conflict: this idempotency_key was first used for a different change/u,
    );
  });

  it('plans a change that changed nothing again when another write lands before its key is recorded', async () => {
    const project = await newProject(engine);
    const { id } = await task(project, { title: 'Same' });
    let raced = false;
    const racing = api({
      principal: WRITER,
      engine,
      wrap: (inner) => ({
        ...inner,
        async recordUnchanged(...args) {
          if (!raced) {
            raced = true;
            await inner.writeTask(args[0], args[1], { expectedVersion: args[2], set: { title: 'Renamed' } }, OWNER);
          }
          return inner.recordUnchanged(...args);
        },
      }),
    });
    const reply = await write(racing, 'update_task', {
      project: project.id,
      task: id,
      title: 'Same',
      idempotency_key: key(),
    });
    expect(reply).toMatchObject({ title: 'Same', replayed: false });
    expect((await current(project, id)).version).toBe(3);
  });

  it('opens a closed task again when given a status', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    await engine.writeTask(
      project.id,
      id,
      { expectedVersion: 1, close: { reason: 'Done.', resolution: 'done' } },
      OWNER,
    );
    const reply = await write<{ task: Record<string, unknown> }>(target, 'update_task', {
      project: project.id,
      task: id,
      status: 'open',
      idempotency_key: key(),
      detail: 'full',
    });
    expect(reply.task).toMatchObject({ status: 'open', closedAt: null });
  });

  it('writes nothing for a change the task already has', async () => {
    const project = await newProject(engine);
    const { id } = await task(project, { title: 'Same', priority: 2 });
    const reply = await write<{ replayed: boolean }>(target, 'update_task', {
      project: project.id,
      task: id,
      title: 'Same',
      priority: 2,
      idempotency_key: key(),
    });
    expect(reply.replayed).toBe(false);
    expect((await current(project, id)).version).toBe(1);
  });

  it('refuses what the task state forbids: a new choice set, a shipped card, a human label, a held hand-over', async () => {
    const project = await newProject(engine);
    const chosen = await task(project, {
      title: 'Chosen',
      choices: {
        question: 'Which?',
        options: [
          { key: 'a', label: 'One', recommended: true },
          { key: 'b', label: 'Two' },
        ],
      },
    });
    await engine.writeTask(
      project.id,
      chosen.id,
      { expectedVersion: 1, set: { choice: { option: 'b', label: 'Two', by: 'owner', at: time.now() } } },
      OWNER,
    );
    const shipped = await task(project, { title: 'Shipped' });
    await write(target, 'update_task', {
      project: project.id,
      task: shipped.id,
      card: { valuePerMonth: 1, likelihood: 0.5, reviewMinutes: 1, daysToSignal: 1, measurability: 'cohort' },
      idempotency_key: key(),
    });
    await write(target, 'close_task', {
      project: project.id,
      task: shipped.id,
      reason: 'Shipped in abc1234.',
      idempotency_key: key(),
    });
    const human = await task(project, { title: 'Human', labels: ['human'] });
    const held = await task(project);
    await engine.writeTask(
      project.id,
      held.id,
      { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress' } },
      AGENT,
    );
    const update = (id: string, args: Record<string, unknown>) =>
      refusal(target, 'update_task', {
        workspace: WORKSPACE.id,
        project: project.id,
        task: id,
        idempotency_key: key(),
        ...args,
      });

    expect(await update(chosen.id, { choices: null })).toBe(
      `refused: ${chosen.id} already carries a person's choice, (b) Two, and its choices stay as they were when it was made. get_task shows the choice; file work that remains with create_task.`,
    );
    expect(await update(shipped.id, { card: null })).toBe(
      `refused: ${shipped.id} shipped on 2026-11-06, and its card stays as it shipped: get_task shows it as cardShipped. File work that remains, with its own card, with create_task.`,
    );
    expect(await update(human.id, { remove_labels: ['human'] })).toBe(
      `refused: ${human.id} is a human request. Use reconcile_task with an existing owner answer or concrete maintenance evidence. For a leftover human label after its gate closed, use reconcile_task action routine with the closed gate as evidence, then retry close_task. An unresolved action-specific approval stays blocked; do not invent an answer or treat retirement as permission.`,
    );
    expect(await update(held.id, { assignee: 'agent-c' })).toBe(
      `refused: ${held.id} is held by ${AGENT.name}, and only its holder or a person in the web app gives it to someone else.`,
    );
  });

  it('refuses arguments that break their rules, in the words NoticeOS used', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const update = (args: Record<string, unknown>) =>
      refusal(target, 'update_task', {
        workspace: WORKSPACE.id,
        project: project.id,
        task: id,
        idempotency_key: key(),
        ...args,
      });
    expect(await update({})).toBe('invalid arguments: name at least one field to change');
    for (const assignee of [' agent-c', 'agent-c ', 'agent\tc', '  ']) {
      expect(await update({ assignee }), JSON.stringify(assignee)).toBe(
        'invalid arguments: assignee (a name on one line, or "" to release the task)',
      );
    }
    expect((await current(project, id)).assignee).toBeNull();
    expect(await update({ status: 'closed' })).toBe(
      'invalid arguments: status (one of open, in_progress, blocked, deferred)',
    );
    expect(await update({ defer: 'tomorrow' })).toBe('invalid arguments: defer (YYYY-MM-DD, or "" to clear it)');
    expect(await update({ add_labels: [] })).toBe(
      'invalid arguments: add_labels (1 to 32 labels, each at most 128 characters on one line, without commas or surrounding spaces, none twice)',
    );
    expect(await update({ related: [] })).toBe('invalid arguments: related (1–32 task ids)');
    expect(await update({ card: null, change_class: 'copy' })).toBe(
      'invalid arguments: card and change_class (a call either sets these or takes them off with null, not both; take them off in a call of their own)',
    );
    expect(await update({ parent: `${project.prefix}-none` })).toBe(
      `refused: ${project.prefix}-none is not a task in projectId ${project.id} (${project.name}); list_tasks lists its tasks.`,
    );
    expect(
      await refusal(target, 'update_task', {
        workspace: WORKSPACE.id,
        project: project.id,
        task: `${project.prefix}-none`,
        title: 'X',
        idempotency_key: key(),
      }),
    ).toBe(
      `refused: ${project.prefix}-none is not a task in projectId ${project.id} (${project.name}); list_tasks lists its tasks.`,
    );
  });

  it('reads the task again when another write changed it first (rule 2), and gives up after a few tries', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    let conflicts = 1;
    const racing = api({
      principal: WRITER,
      engine,
      wrap: (inner) => ({
        ...inner,
        async writeTask(...args) {
          if (conflicts > 0) {
            conflicts -= 1;
            // Another writer lands first, so this write's version is stale.
            await inner.writeTask(
              args[0],
              args[1],
              { expectedVersion: args[2].expectedVersion, set: { description: 'Raced.' } },
              OWNER,
            );
          }
          return inner.writeTask(...args);
        },
      }),
    });
    const reply = await write<{ task: Record<string, unknown> }>(racing, 'update_task', {
      project: project.id,
      task: id,
      title: 'After the race',
      idempotency_key: key(),
      detail: 'full',
    });
    expect(reply.task).toMatchObject({ title: 'After the race', description: 'Raced.' });

    conflicts = 10;
    const unavailable = await refusalOf(racing, 'update_task', {
      workspace: WORKSPACE.id,
      task: id,
      title: 'Never',
    });
    // Only a write that did not complete tells the agent to read the task before retrying.
    expect(unavailable).toMatchObject({ task: id, retry: 'unsure' });
    expect(unavailable.sentence).toBe(
      "unavailable: the task store did not complete this call, and nothing in the task's state explains it. Retry the same call; with the same idempotency_key a change lands at most once.",
    );
    expect((await current(project, id)).title).toBe('After the race');
  });
});

describe("a task's notes, design and estimate", () => {
  interface Snapshot {
    task: { notes: string; design: string; estimateMinutes: number | null };
  }

  it('are filed, changed and taken off, and each version is in the history', async () => {
    const project = await newProject(engine);
    const filed = await write<{ id: string }>(target, 'create_task', {
      project: project.id,
      title: 'Plan the import',
      notes: 'The old pages redirect.',
      design: '## Steps\n1. Export.',
      estimate_minutes: 90,
      idempotency_key: key(),
    });
    const batch = await write<{ results: { id: string }[] }>(target, 'create_tasks', {
      project: project.id,
      tasks: [{ title: 'Second', notes: 'Batch note.', estimate_minutes: 0 }],
      idempotency_key: key(),
    });
    expect(await current(project, batch.results[0]!.id)).toMatchObject({
      notes: 'Batch note.',
      design: '',
      estimateMinutes: 0,
    });
    const read = await write<{ task: Record<string, unknown> }>(target, 'get_task', {
      project: project.id,
      task: filed.id,
    });
    expect(read.task).toMatchObject({
      notes: 'The old pages redirect.',
      design: '## Steps\n1. Export.',
      estimateMinutes: 90,
    });

    const changed = await write<{ task: Record<string, unknown> }>(target, 'update_task', {
      project: project.id,
      task: filed.id,
      notes: 'Export done.',
      design: '',
      estimate_minutes: 120,
      idempotency_key: key(),
      detail: 'full',
    });
    expect(changed.task).toMatchObject({ notes: 'Export done.', design: '', estimateMinutes: 120 });
    await write(target, 'update_task', {
      project: project.id,
      task: filed.id,
      estimate_minutes: null,
      idempotency_key: key(),
    });
    expect((await current(project, filed.id)).estimateMinutes).toBeNull();
    const listed = await write<{ tasks: Record<string, unknown>[] }>(target, 'list_tasks', { project: project.id });
    expect(listed.tasks.find((row) => row.id === batch.results[0]!.id)).toMatchObject({ estimateMinutes: 0 });
    expect(listed.tasks.find((row) => row.id === filed.id)).not.toHaveProperty('notes');

    const { changes } = await write<{ changes: (Snapshot & { revision: string })[] }>(target, 'get_task_history', {
      project: project.id,
      task: filed.id,
      snapshots: true,
    });
    expect(
      changes
        .map((change) => change.task)
        .map(({ notes, design, estimateMinutes }) => [notes, design, estimateMinutes]),
    ).toEqual([
      ['Export done.', '', null],
      ['Export done.', '', 120],
      ['The old pages redirect.', '## Steps\n1. Export.', 90],
    ]);
    const fields = await write<{ changes: { fields: Record<string, { old: unknown; new: unknown }> }[] }>(
      target,
      'get_task_history',
      { project: project.id, task: filed.id },
    );
    expect(fields.changes[1]!.fields).toEqual({
      notes: { old: 'The old pages redirect.', new: 'Export done.' },
      design: { old: '## Steps\n1. Export.', new: '' },
      estimateMinutes: { old: 90, new: 120 },
    });
  });

  it('refuse an estimate that is not whole minutes, and a key reused with other notes', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const base = { workspace: WORKSPACE.id, project: project.id, idempotency_key: key() };
    for (const estimate of [-1, 1.5, 525_601, '30']) {
      expect(await refusal(target, 'create_task', { ...base, title: 'T', estimate_minutes: estimate })).toBe(
        'invalid arguments: estimate_minutes (whole minutes, 0–525600)',
      );
      expect(await refusal(target, 'update_task', { ...base, task: id, estimate_minutes: estimate })).toBe(
        'invalid arguments: estimate_minutes (whole minutes, 0–525600, or null to take it off)',
      );
    }
    expect(await refusal(target, 'create_task', { ...base, title: 'T', estimate_minutes: null })).toBe(
      'invalid arguments: estimate_minutes (whole minutes, 0–525600)',
    );
    expect(await refusal(target, 'update_task', { ...base, task: id, notes: 'x'.repeat(8193) })).toBe(
      'invalid arguments: notes (at most 8192 characters; this one has 8193)',
    );
    const once = { ...base, task: id, notes: 'First.' };
    await write(target, 'update_task', once);
    expect(await refusal(target, 'update_task', { ...once, notes: 'Second.' })).toMatch(/^conflict: /u);
    expect((await current(project, id)).notes).toBe('First.');
  });
});

describe('duplicates and supersedes links', () => {
  it('are filed and added, in this project or another, and hold nothing out of ready work', async () => {
    const project = await newProject(engine);
    const other = await newProject(engine);
    const first = await task(project, { title: 'First filing' });
    const old = await task(project, { title: 'Old plan' });
    const elsewhere = await task(other, { title: 'Filed elsewhere' });
    const filed = await write<{ id: string }>(target, 'create_task', {
      project: project.id,
      title: 'Second filing',
      duplicates: [first.id],
      supersedes: [old.id],
      idempotency_key: key(),
    });
    const later = await task(project, { title: 'Later plan' });
    await write(target, 'update_task', {
      project: project.id,
      task: later.id,
      duplicates: [elsewhere.id],
      supersedes: [filed.id],
      idempotency_key: key(),
    });

    const read = await write<{ task: { dependencies: unknown[]; ready: boolean } }>(target, 'get_task', {
      project: project.id,
      task: filed.id,
    });
    expect(read.task.ready).toBe(true);
    expect(read.task.dependencies).toEqual(
      [
        { id: first.id, type: 'duplicates', title: 'First filing', status: 'open' },
        { id: old.id, type: 'supersedes', title: 'Old plan', status: 'open' },
      ].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
    expect((await current(project, later.id)).dependencies.map((link) => [link.taskId, link.type]).sort()).toEqual(
      [
        [elsewhere.id, 'duplicates'],
        [filed.id, 'supersedes'],
      ].sort(),
    );
    const ready = await write<{ tasks: { id: string }[] }>(target, 'list_tasks', { project: project.id, ready: true });
    expect(ready.tasks.map((row) => row.id).sort()).toEqual([first.id, old.id, filed.id, later.id].sort());

    expect(await write(target, 'link_tasks', { task: later.id, to: elsewhere.id, remove: true })).toMatchObject({
      removed: true,
    });
    expect((await current(project, later.id)).dependencies.map((link) => link.taskId)).toEqual([filed.id]);
  });

  it('link a task named in two kinds once, as the more specific kind, with a warning', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const kin = await task(project, { title: 'Kin' });
    const blocker = await task(project, { title: 'Blocker' });
    const changed = await write<{ dependencies: unknown[]; warnings: string[] }>(target, 'update_task', {
      task: id,
      related: [kin.id],
      duplicates: [kin.id],
    });
    expect(changed.dependencies).toEqual([{ id: kin.id, type: 'duplicates', title: 'Kin', status: 'open' }]);
    expect(changed.warnings).toHaveLength(1);
    const filed = await write<{ id: string; warnings: string[] }>(target, 'create_task', {
      project: project.id,
      title: 'T',
      related: [kin.id, blocker.id],
      duplicates: [kin.id],
      supersedes: [kin.id],
      depends_on: [blocker.id],
    });
    expect(filed.warnings).toHaveLength(3);
    expect((await current(project, filed.id)).dependencies.map((link) => [link.taskId, link.type]).sort()).toEqual(
      [
        [kin.id, 'supersedes'],
        [blocker.id, 'blocks'],
      ].sort(),
    );
  });

  it('refuse a link to the task itself', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const base = { workspace: WORKSPACE.id, project: project.id, task: id, idempotency_key: key() };
    expect(await refusal(target, 'update_task', { ...base, supersedes: [id] })).toBe(
      'invalid arguments: supersedes (another task than this one)',
    );
    expect((await current(project, id)).dependencies).toEqual([]);
  });
});

describe('external links', () => {
  const pr = {
    url: 'https://example.com/acme/web/pull/12',
    title: 'Add the pricing page',
    kind: 'pull-request' as const,
  };
  const doc = { url: 'https://docs.example.com/pricing', title: 'Pricing notes' };

  it('are filed, added, retitled and taken off, each change in the history', async () => {
    const project = await newProject(engine);
    const filed = await write<{ id: string }>(target, 'create_task', {
      project: project.id,
      title: 'Ship the pricing page',
      external_links: [pr],
      idempotency_key: key(),
    });
    const id = filed.id;
    const added = await write<{ externalLinks: unknown[] }>(target, 'update_task', {
      project: project.id,
      task: id,
      add_external_links: [doc, { ...pr, title: 'Add the pricing page (merged)' }],
      idempotency_key: key(),
    });
    expect(added.externalLinks).toEqual([
      { url: doc.url, title: doc.title, kind: null },
      { ...pr, title: 'Add the pricing page (merged)' },
    ]);
    const listed = await write<{ tasks: Record<string, unknown>[] }>(target, 'list_tasks', { project: project.id });
    expect(listed.tasks.find((row) => row.id === id)).toMatchObject({ externalLinks: added.externalLinks });
    // A later page and a read of every project carry each task's links too.
    const other = await task(project, { title: 'Also linked', priority: 4, externalLinks: [doc] });
    const second = await write<{ tasks: Record<string, unknown>[] }>(target, 'list_tasks', {
      project: project.id,
      limit: 1,
      offset: 1,
    });
    expect(second.tasks).toMatchObject([{ id: other.id, externalLinks: [{ ...doc, kind: null }] }]);
    const everywhere = await write<{ tasks: Record<string, unknown>[] }>(target, 'list_tasks', {
      query: 'pricing page',
    });
    expect(everywhere.tasks.find((row) => row.id === id)).toMatchObject({ externalLinks: added.externalLinks });
    // The same page is one URL, however it is written.
    const removed = await write<{ externalLinks: unknown[] }>(target, 'update_task', {
      project: project.id,
      task: id,
      remove_external_links: ['HTTPS://DOCS.example.com/pricing'],
      idempotency_key: key(),
    });
    expect(removed.externalLinks).toEqual([{ ...pr, title: 'Add the pricing page (merged)' }]);

    const { changes } = await write<{ changes: { task: { externalLinks: unknown[] } }[] }>(target, 'get_task_history', {
      project: project.id,
      task: id,
      snapshots: true,
    });
    expect(changes.map((change) => change.task.externalLinks)).toEqual([
      removed.externalLinks,
      added.externalLinks,
      [pr],
    ]);
  });

  it('change nothing for a link the task has, and keep the retry rules', async () => {
    const project = await newProject(engine);
    const { id } = await task(project, { title: 'Linked', externalLinks: [pr] });
    const again = await write<{ replayed: boolean }>(target, 'update_task', {
      project: project.id,
      task: id,
      add_external_links: [pr],
      idempotency_key: key(),
    });
    expect(again.replayed).toBe(false);
    expect((await current(project, id)).version).toBe(1);

    const once = { project: project.id, task: id, add_external_links: [doc], idempotency_key: key() };
    await write(target, 'update_task', once);
    expect(await write<{ replayed: boolean }>(target, 'update_task', once)).toMatchObject({ replayed: true });
    expect((await current(project, id)).version).toBe(2);
    expect(
      await refusal(target, 'update_task', {
        workspace: WORKSPACE.id,
        ...once,
        add_external_links: [{ ...doc, url: 'https://docs.example.com/other' }],
      }),
    ).toMatch(/^conflict: /u);
  });

  it('refuse a URL that is not http or https, or too long, a link named twice, and more than a task holds', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const base = { workspace: WORKSPACE.id, project: project.id, task: id, idempotency_key: key() };
    const url = (value: string) =>
      refusal(target, 'update_task', { ...base, add_external_links: [{ url: value, title: 'T' }] });
    const rule = 'invalid arguments: add_external_links[0].url (an http or https URL of at most 2048 characters)';
    expect(await url('ftp://example.com/file')).toBe(rule);
    expect(await url('javascript:alert(1)')).toBe(rule);
    expect(await url('example.com/page')).toBe(rule);
    expect(await url('https://example.com/a page')).toBe(rule);
    expect(await url(`https://example.com/${'a'.repeat(2030)}`)).toBe(rule);
    expect(await refusal(target, 'update_task', { ...base, add_external_links: [{ ...doc, kind: 'issue' }] })).toBe(
      'invalid arguments: add_external_links[0].kind (one of pull-request, document, other)',
    );
    expect(
      await refusal(target, 'update_task', { ...base, add_external_links: [{ ...doc, title: 'Two\nlines' }] }),
    ).toBe('invalid arguments: add_external_links[0].title (one line, no surrounding spaces)');
    expect(
      await refusal(target, 'update_task', { ...base, add_external_links: [doc, { ...doc, title: 'Again' }] }),
    ).toBe('invalid arguments: add_external_links (a URL named twice; a task links to a URL once)');
    expect(
      await refusal(target, 'update_task', { ...base, add_external_links: [doc], remove_external_links: [doc.url] }),
    ).toBe(
      'invalid arguments: add_external_links and remove_external_links (a URL both added and taken off; send one)',
    );
    const many = Array.from({ length: 32 }, (_, index) => ({
      url: `https://example.com/${index}`,
      title: `Page ${index}`,
    }));
    await write(target, 'update_task', { ...base, add_external_links: many });
    expect(await refusal(target, 'update_task', { ...base, idempotency_key: key(), add_external_links: [doc] })).toBe(
      'invalid arguments: a task links to at most 32 pages outside Ntasks',
    );
    expect((await current(project, id)).externalLinks).toHaveLength(32);
  });
});

describe('comment_on_task', () => {
  it('adds a comment once, however often the call is retried', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const args = { project: project.id, task: id, text: 'Halfway.', idempotency_key: key(), detail: 'full' };
    const first = await write<{ comment: Record<string, unknown>; replayed: boolean }>(target, 'comment_on_task', args);
    expect(first).toEqual({
      comment: {
        id: expect.any(String),
        author: WRITER.name,
        text: 'Halfway.',
        createdAt: time.now(),
        pinned: false,
        test: null,
      },
      replayed: false,
    });
    const again = await write<{ comment: Record<string, unknown>; replayed: boolean }>(target, 'comment_on_task', args);
    expect(again).toEqual({ comment: first.comment, replayed: true });
    expect(await engine.listComments(project.id, id)).toHaveLength(1);
    expect(await refusal(target, 'comment_on_task', { workspace: WORKSPACE.id, ...args, text: 'Other.' })).toMatch(
      /^conflict: /u,
    );
    expect(
      await refusal(target, 'comment_on_task', { workspace: WORKSPACE.id, ...args, text: '', idempotency_key: key() }),
    ).toBe('invalid arguments: text (empty)');
  });

  it('pins a comment, and unpins earlier pinned comments of the same task, leaving its version', async () => {
    const project = await newProject(engine);
    const epic = await task(project, { title: 'Rebuild the pages', type: 'epic' });
    const first = await write<{ commentId: string; pinned?: boolean }>(target, 'comment_on_task', {
      task: epic.id,
      text: 'The header lives in one file.',
      pin: true,
    });
    expect(first).toEqual({ task: epic.id, commentId: expect.any(String), pinned: true, replayed: false });
    const plain = await write<{ commentId: string }>(target, 'comment_on_task', { task: epic.id, text: 'Noted.' });
    expect(plain).not.toHaveProperty('pinned');
    const second = await write<{ commentId: string }>(target, 'comment_on_task', {
      task: epic.id,
      text: 'The header lives in two files now.',
      pin: true,
      unpin: [first.commentId],
    });
    const comments = await engine.listComments(project.id, epic.id);
    expect(Object.fromEntries(comments.map(({ id, pinned }) => [id, pinned]))).toEqual({
      [first.commentId]: false,
      [plain.commentId]: false,
      [second.commentId]: true,
    });
    expect((await current(project, epic.id)).version).toBe(1);
    // The history records who pinned and unpinned what.
    const events = await engine.listHistory(project.id, epic.id, { limit: 10 });
    expect(events[0]).toMatchObject({
      kind: 'commented',
      actor: WRITER.name,
      version: 1,
      changes: { commentId: second.commentId, pinned: true, unpinned: [first.commentId] },
    });
    const { changes } = await read<{ changes: { actor: string; fields: Record<string, unknown> }[] }>(
      target,
      'get_task_history',
      { task: epic.id },
    );
    expect(changes[0]).toMatchObject({
      actor: WRITER.name,
      fields: {
        comment: { old: null, new: 'The header lives in two files now.' },
        pinned: { old: false, new: true },
        unpinned: { old: null, new: [first.commentId] },
      },
    });

    const refused = (args: Record<string, unknown>) =>
      refusal(target, 'comment_on_task', { workspace: WORKSPACE.id, task: epic.id, text: 'Again.', ...args });
    expect(await refused({ unpin: [first.commentId] })).toBe(
      `invalid arguments: ${first.commentId} is not a pinned comment of ${epic.id}`,
    );
    expect(await refused({ unpin: [plain.commentId, 'no-such-comment'] })).toBe(
      `invalid arguments: ${plain.commentId}, no-such-comment is not a pinned comment of ${epic.id}`,
    );
    expect(await refused({ pin: 'yes' })).toBe('invalid arguments: pin (true or false)');
    expect(await refused({ task: undefined, tasks: [epic.id], unpin: [second.commentId] })).toBe(
      'invalid arguments: unpin (a comment id names a comment of one task: name it with task)',
    );
    // A refused unpin leaves the comment pinned and adds no comment.
    expect(await engine.listComments(project.id, epic.id)).toHaveLength(3);
  });

  it('pins a comment that also records work details, which the holder sends', async () => {
    const project = await newProject(engine);
    const epic = await task(project, { title: 'Rebuild the pages', type: 'epic' });
    const { id } = await task(project, { title: 'Rebuild the home page', parentId: epic.id });
    await write(target, 'claim_task', { task: id });
    const said = await write<{ commentId: string; pinned?: boolean }>(target, 'comment_on_task', {
      task: id,
      text: 'The home page is done; the pricing page reuses it.',
      next: 'Open the pull request.',
      pin: true,
    });
    expect(said).toMatchObject({ pinned: true });
    expect((await engine.listComments(project.id, id)).find((comment) => comment.id === said.commentId)).toMatchObject({
      pinned: true,
    });
  });
});

describe('link_tasks', () => {
  type Linked = Record<string, unknown>;
  const links = async (project: Project, id: string) =>
    (await current(project, id)).dependencies.map((link) => [link.taskId, link.type]);

  it('records which pull request merges first, on both tasks, holding neither out of ready work', async () => {
    const project = await newProject(engine);
    const first = await task(project, { title: 'Add the shared header' });
    const later = await task(project, { title: 'Use the shared header on the pricing page' });
    expect(await write<Linked>(target, 'link_tasks', { task: later.id, to: first.id, type: 'merges-after' })).toEqual({
      task: later.id,
      to: first.id,
      type: 'merges-after',
    });
    const shown = async (id: string) =>
      (await read<{ task: Record<string, unknown> }>(target, 'get_task', { task: id })).task;
    const linked = { type: 'merges-after', status: 'open' };
    expect(await shown(later.id)).toMatchObject({
      ready: true,
      dependencies: [{ id: first.id, title: first.title, ...linked }],
      dependents: [],
    });
    expect(await shown(first.id)).toMatchObject({
      ready: true,
      dependencies: [],
      dependents: [{ id: later.id, title: later.title, ...linked }],
    });
  });

  it('sets the one link between two tasks, changing blocks to related in one call, and removes it', async () => {
    const project = await newProject(engine);
    const blocker = await task(project, { title: 'Blocker' });
    const { id } = await task(project, { title: 'Waits' });
    const pair = { task: id, to: blocker.id };
    expect(await write<Linked>(target, 'link_tasks', { ...pair, type: 'blocks' })).toEqual({ ...pair, type: 'blocks' });
    expect(await current(project, id)).toMatchObject({ ready: false, version: 2 });
    // Asking again changes nothing.
    await write(target, 'link_tasks', { ...pair, type: 'blocks' });
    expect((await current(project, id)).version).toBe(2);

    expect(await write<Linked>(target, 'link_tasks', { ...pair, type: 'related' })).toEqual({
      ...pair,
      type: 'related',
      replaced: { ...pair, type: 'blocks' },
    });
    expect(await current(project, id)).toMatchObject({ ready: true, version: 3 });
    expect(await links(project, id)).toEqual([[blocker.id, 'related']]);

    // Set from the other task, the pair still holds one link, now that one's.
    expect(await write<Linked>(target, 'link_tasks', { task: blocker.id, to: id, type: 'blocks' })).toMatchObject({
      replaced: { ...pair, type: 'related' },
    });
    expect(await links(project, id)).toEqual([]);
    expect(await links(project, blocker.id)).toEqual([[id, 'blocks']]);

    expect(await write<Linked>(target, 'link_tasks', { ...pair, remove: true })).toEqual({ ...pair, removed: true });
    expect(await links(project, blocker.id)).toEqual([]);
    expect(await write<Linked>(target, 'link_tasks', { ...pair, remove: true })).toEqual({ ...pair, removed: true });
  });

  it('refuses a loop of tasks waiting on each other, and a blocking link to another project', async () => {
    const project = await newProject(engine);
    const other = await newProject(engine);
    const [a, b, c] = [await task(project, { title: 'A' }), await task(project, { title: 'B' }), await task(project)];
    await write(target, 'link_tasks', { task: a.id, to: b.id, type: 'blocks' });
    await write(target, 'link_tasks', { task: b.id, to: c.id, type: 'blocks' });
    expect(await refusal(target, 'link_tasks', { workspace: WORKSPACE.id, task: c.id, to: a.id, type: 'blocks' })).toBe(
      `refused: ${a.id} already waits on ${c.id}, so ${c.id} cannot wait on it: the two would wait on each other in a loop.`,
    );
    expect(await links(project, c.id)).toEqual([]);

    const kin = await task(other);
    await write(target, 'link_tasks', { task: a.id, to: kin.id, type: 'related' });
    expect(await links(project, a.id)).toEqual(
      [
        [b.id, 'blocks'],
        [kin.id, 'related'],
      ].sort(),
    );
    expect(
      await refusal(target, 'link_tasks', { workspace: WORKSPACE.id, task: c.id, to: kin.id, type: 'blocks' }),
    ).toBe(
      `refused: ${kin.id} is not in projectId ${project.id} (${project.name}), whose tasks start ${project.prefix}-; tasks with prefix ${other.prefix} are in projectId ${other.id} (${other.name}).`,
    );
  });

  it("leaves a link to a person's decision for the person, and refuses what names no link", async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const other = await task(project);
    const { created } = await engine.writeTask(
      project.id,
      id,
      { expectedVersion: 1, requestApproval: { reason: 'Approve it.' } },
      OWNER,
    );
    const gate = created[0]!.id;
    const refused = (args: Record<string, unknown>) =>
      refusal(target, 'link_tasks', { workspace: WORKSPACE.id, ...args });
    expect(await refused({ task: id, to: gate, remove: true })).toMatch(
      new RegExp(`^refused: ${gate} is a human request\\.`, 'u'),
    );
    expect(await refused({ task: id, to: gate, type: 'related' })).toMatch(/^refused: .* is a human request\./u);
    expect(await links(project, id)).toEqual([[gate, 'blocks']]);
    // A new link to a decision is added.
    await write(target, 'link_tasks', { task: other.id, to: gate, type: 'related' });
    expect(await links(project, other.id)).toEqual([[gate, 'related']]);

    expect(await refused({ task: id, to: id, type: 'related' })).toBe(
      'invalid arguments: to (another task than this one)',
    );
    expect(await refused({ task: id, to: other.id })).toMatch(/^invalid arguments: type /u);
    expect(await refused({ task: id, to: other.id, type: 'related', remove: true })).toMatch(
      /^invalid arguments: type /u,
    );
    expect(await refused({ task: id, to: other.id, type: 'depends' })).toBe(
      'invalid arguments: type (one of blocks, related, discovered-from, duplicates, supersedes, merges-after)',
    );
  });
});

describe('request_human_approval', () => {
  it('opens an approval once, returning the open one when asked the same again', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const args = { project: project.id, task: id, reason: 'Spend 20 USD on the domain.' };
    const first = await write<{ approval: { id: string }; created: boolean }>(target, 'request_human_approval', args);
    expect(first).toMatchObject({
      task: id,
      approval: { status: 'open', reason: 'Spend 20 USD on the domain.' },
      held: true,
      created: true,
    });
    const again = await write<{ approval: { id: string }; created: boolean }>(target, 'request_human_approval', args);
    expect(again).toMatchObject({ approval: { id: first.approval.id }, created: false });
    expect((await current(project, id)).dependencies).toHaveLength(1);
  });

  it('opens an approval with the title and Markdown description it is given', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const description = [
      'Approve deploying the API to production, so the new rules reach every agent.',
      '',
      '## What the agent will do',
      '',
      '```bash',
      'pnpm run deploy',
      '```',
      '',
      '## What it changes',
      '',
      '- **Downtime:** none for people using the API.',
      '- **Undo:** deploy the previous release.',
    ].join('\n');
    const args = { project: project.id, task: id, title: 'Approve deploying the API to production', description };
    const first = await write<{ approval: { id: string }; created: boolean }>(target, 'request_human_approval', args);
    expect(first).toMatchObject({
      task: id,
      approval: { status: 'open', title: 'Approve deploying the API to production' },
      held: true,
      created: true,
    });
    expect(first).not.toHaveProperty('lint');
    expect(await current(project, first.approval.id)).toMatchObject({
      type: 'gate',
      awaitType: 'human',
      title: 'Approve deploying the API to production',
      description,
    });
    // Asked again, it is the open one; under another title it is another request.
    const again = await write<{ approval: { id: string }; created: boolean }>(target, 'request_human_approval', args);
    expect(again).toMatchObject({ approval: { id: first.approval.id }, created: false });
    const retitled = await write<{ approval: { id: string }; created: boolean }>(target, 'request_human_approval', {
      ...args,
      title: 'Approve the API deployment',
    });
    expect(retitled.created).toBe(true);
    expect((await current(project, id)).dependencies).toHaveLength(2);
  });

  it('advises an approval that names no place to answer, and not one that does', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const title = 'Approve merging Ntasks PR #88: Do checklists, one new database column';
    const vague = await write<{ approval: { id: string }; lint: { advice: readonly string[] } }>(
      target,
      'request_human_approval',
      { project: project.id, task: id, title, description: 'The merge adds one empty column to the task database.' },
    );
    expect(vague.lint.advice).toEqual(placeAdvice(await current(project, vague.approval.id)));
    expect(vague.lint.advice).toHaveLength(1);
    const clear = await write<Record<string, unknown>>(target, 'request_human_approval', {
      project: project.id,
      task: id,
      title,
      description: [
        'You: press Approve on this task to let the agent merge https://github.com/example/web/pull/88.',
        '',
        '## Why this needs you',
        '',
        'A change to the live task database comes to you first.',
      ].join('\n'),
    });
    expect(clear).toMatchObject({ created: true });
    expect(clear).not.toHaveProperty('lint');
  });

  it('advises title and description when a reason makes a title that breaks the rule', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const line = 'Approve running ./update.sh --commit ba05bed67f1 on the demo host, which restarts it';
    const reason = `${line}\nIt takes 2 minutes.`;
    const reply = await write<{ approval: { id: string }; lint: { advice: readonly string[] } }>(
      target,
      'request_human_approval',
      { project: project.id, task: id, reason },
    );
    const gate = await current(project, reply.approval.id);
    expect(gate.title).toBe(line);
    // Its title is its reason's first line, so it repeats it, and it names nowhere to answer.
    expect(repeatsTitle(gate.title, gate.description)).toBe(true);
    expect(reply.lint.advice).toEqual([
      ...titleAdvice(line),
      ...repeatAdvice(gate.title, gate.description),
      ...placeAdvice(gate),
      expect.any(String),
    ]);
    expect(titleAdvice(line)).toHaveLength(2);
  });

  it('refuses a title without a description, a title on two lines, a reason beside a title, and a "Reason:" line', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const ask = (args: Record<string, unknown>) =>
      refusal(target, 'request_human_approval', { workspace: WORKSPACE.id, project: project.id, task: id, ...args });
    expect(await ask({ title: 'Approve the deploy' })).toBe(
      'invalid arguments: description (required: pass title and description, or reason alone)',
    );
    expect(await ask({ description: 'Deploys the API.' })).toBe(
      'invalid arguments: title (required: pass title and description, or reason alone)',
    );
    expect(await ask({})).toBe('invalid arguments: title (required: pass title and description, or reason alone)');
    for (const title of ['Approve\nthe deploy', 'Approve\tthe deploy'])
      expect(await ask({ title, description: 'Deploys the API.' })).toBe(
        'invalid arguments: title (one line, with no tab or line break)',
      );
    expect(await ask({ title: 'Approve the deploy', description: 'Deploys the API.', reason: 'Deploy.' })).toBe(
      'invalid arguments: reason (pass title and description, or reason alone)',
    );
    expect(await ask({ title: 'x'.repeat(71), description: 'Deploys the API.' })).toBe(
      'invalid arguments: title (at most 70 characters; this one has 71)',
    );
    // Read as an imported approval, the request would be only the text after "Reason:".
    expect(await ask({ title: 'Approve the deploy', description: 'Deploys the API.\nReason: the key expires.' })).toBe(
      'invalid arguments: description (a line that starts "Reason:" makes an approval ask only what follows it, as one imported from Beads does; reword that line)',
    );
    expect(
      await write<{ created: boolean }>(target, 'request_human_approval', {
        project: project.id,
        task: id,
        title: 'Approve the deploy',
        description: 'Deploys the API.\n\n## Why\n\nThe reason: the key expires.',
      }),
    ).toMatchObject({ created: true });
    expect((await current(project, id)).dependencies).toHaveLength(1);
  });

  it('opens a new approval when only the start of an open one asks the same', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const start = `Delete the old backups ${'x'.repeat(377)}`;
    expect(start).toHaveLength(400);
    const { created } = await engine.writeTask(
      project.id,
      id,
      { expectedVersion: 1, requestApproval: { reason: `${start}\nAnd the logs older than a year.` } },
      OWNER,
    );
    const ask = (reason: string) =>
      write<{ approval: { id: string }; created: boolean }>(target, 'request_human_approval', {
        project: project.id,
        task: id,
        reason,
      });
    const asked = await ask(start);
    expect(asked).toMatchObject({ created: true, approval: { reason: start } });
    expect(asked.approval.id).not.toBe(created[0]!.id);
    // A request sent again with Windows line ends asks the same.
    const first = await ask('Rotate the key.\r\nThen sign everyone out.');
    expect(await ask('Rotate the key.\nThen sign everyone out.')).toMatchObject({
      created: false,
      approval: { id: first.approval.id },
    });
    expect((await current(project, id)).dependencies).toHaveLength(3);
  });

  it('compares requests whole, and reads a Beads gate by its "Reason:" line', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const ask = (reason: string) =>
      write<{ approval: { id: string }; created: boolean }>(target, 'request_human_approval', {
        project: project.id,
        task: id,
        reason,
      });
    // An approval whose "Reason:" line is blank asks its whole text.
    const release = await ask('Approve the release.\nReason:\n');
    expect((await ask('Approve the deletion.\nReason:\n')).created).toBe(true);
    expect(await ask('Approve the release.\nReason:')).toMatchObject({
      created: false,
      approval: { id: release.approval.id },
    });
    // A gate kept from Beads is asked again by its reason alone, and a request
    // that only shares its "Reason:" line opens another.
    const { created } = await engine.writeTask(
      project.id,
      id,
      {
        expectedVersion: (await current(project, id)).version,
        requestApproval: { reason: 'Imported.\nReason: Rotate the key.' },
      },
      OWNER,
    );
    expect(await ask('Rotate the key.')).toMatchObject({ created: false, approval: { id: created[0]!.id } });
    expect((await ask('Approve the rotation.\nReason: Rotate the key.')).created).toBe(true);
    // Only the first "Reason:" line counts, and only when text follows it on
    // that line; the text it starts runs to the end.
    await engine.writeTask(
      project.id,
      id,
      {
        expectedVersion: (await current(project, id)).version,
        requestApproval: { reason: 'Approve the purge.\nReason:\nReason: Purge the cache.' },
      },
      OWNER,
    );
    expect((await ask('Reason: Purge the cache.')).created).toBe(true);
    const { created: lines } = await engine.writeTask(
      project.id,
      id,
      {
        expectedVersion: (await current(project, id)).version,
        requestApproval: { reason: 'Imported.\nReason: Move the database.\nThen check the backups.' },
      },
      OWNER,
    );
    expect(await ask('Move the database.\nThen check the backups.')).toMatchObject({
      created: false,
      approval: { id: lines[0]!.id },
    });
    expect((await current(project, id)).dependencies).toHaveLength(7);
  });

  it('returns the approval another request opened first for the same reason', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    let other: string | undefined;
    const racing = api({
      principal: WRITER,
      engine,
      wrap: (inner) => ({
        ...inner,
        async writeTask(...args) {
          if (other === undefined && args[2].requestApproval !== undefined) {
            const { created } = await inner.writeTask(args[0], args[1], { ...args[2] }, OWNER);
            other = created[0]!.id;
          }
          return inner.writeTask(...args);
        },
      }),
    });
    const reply = await write<{ approval: { id: string }; created: boolean }>(racing, 'request_human_approval', {
      project: project.id,
      task: id,
      reason: 'Rotate the key.',
    });
    expect(reply).toMatchObject({ created: false, approval: { id: other } });
    expect((await current(project, id)).dependencies).toHaveLength(1);
  });

  it('refuses a closed task', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    await engine.writeTask(
      project.id,
      id,
      { expectedVersion: 1, close: { reason: 'Done.', resolution: 'done' } },
      OWNER,
    );
    expect(
      await refusal(target, 'request_human_approval', {
        workspace: WORKSPACE.id,
        project: project.id,
        task: id,
        reason: 'Go?',
      }),
    ).toBe(`refused: ${id} is already closed; get_task shows its close reason.`);
  });
});

describe('request_human_action', () => {
  const STEPS = [
    { text: 'On the demo host, update to the merged commit.', command: './update.sh --commit a1b2c3d4' },
    { text: 'Open the demo and sign in.' },
  ];
  type Asked = { request: { id: string; status: string; title: string; steps: number }; created: boolean };
  const ask = (project: string, id: string, extra: Record<string, unknown> = {}) =>
    write<Asked>(target, 'request_human_action', {
      project,
      task: id,
      title: 'Update the demo',
      context: 'The demo still runs the old release.',
      steps: STEPS,
      ...extra,
    });

  it('advises a context that repeats the title, and counts its steps as the place to act', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    // The context names no link, control or command: the ticks on its steps are where the person acts.
    const plain = (await ask(project.id, id)) as Asked & { lint?: unknown };
    expect(plain).not.toHaveProperty('lint');
    // Another task, since the same title and steps would return the open request.
    const other = await task(project);
    const repeated = (await ask(project.id, other.id, {
      context: 'Update the demo.\n\nIt still runs the old release.',
    })) as Asked & {
      lint: { advice: readonly string[] };
    };
    const gate = await current(project, repeated.request.id);
    expect(placeAdvice(gate)).toEqual([]);
    expect(repeated.lint.advice).toEqual(repeatAdvice(gate.title, gate.description));
    expect(repeated.lint.advice).toHaveLength(1);
  });

  it('opens a request the task waits on, with each step and its command stored apart, once', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const first = await ask(project.id, id);
    expect(first).toMatchObject({
      task: id,
      request: { status: 'open', title: 'Update the demo', steps: 2 },
      held: true,
      created: true,
    });
    const gate = await current(project, first.request.id);
    expect(gate).toMatchObject({
      type: 'gate',
      awaitType: 'human',
      description: 'The demo still runs the old release.',
    });
    expect(gate.steps).toEqual([
      { text: STEPS[0]!.text, command: STEPS[0]!.command, done: null, note: null, stuck: null },
      { text: STEPS[1]!.text, command: null, done: null, note: null, stuck: null },
    ]);
    expect((await current(project, id)).ready).toBe(false);
    const shown = await read<{ task: { steps: unknown[]; awaitingHuman: boolean } }>(target, 'get_task', {
      project: project.id,
      task: gate.id,
    });
    expect(shown.task).toMatchObject({ awaitingHuman: true, steps: gate.steps });

    expect(await ask(project.id, id)).toMatchObject({ request: { id: first.request.id }, created: false });
    const other = await ask(project.id, id, { steps: [STEPS[1]] });
    expect(other).toMatchObject({ created: true });
    expect((await current(project, id)).dependencies).toHaveLength(2);
  });

  it('leaves the request to the person: an agent cannot close it or answer it as an approval', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const { request } = await ask(project.id, id);
    expect(await refusal(target, 'close_task', { workspace: WORKSPACE.id, task: request.id, reason: 'Done.' })).toMatch(
      /^refused: .* is a human request/u,
    );
    expect(await refusal(target, 'close_task', { workspace: WORKSPACE.id, task: id, reason: 'Done.' })).toMatch(
      new RegExp(`^refused: ${id} waits on ${request.id}, steps a person is asked to do`, 'u'),
    );
  });

  it('advises moving a command out of a step’s text into its command, filing the request as asked', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const reply = await ask(project.id, id, { steps: [{ text: 'Run `./update.sh` on the host.' }, STEPS[1]] });
    expect(reply).toMatchObject({ created: true, lint: { advice: [expect.stringMatching(/^steps\[0\]\.text: /u)] } });
    expect((await ask(project.id, id)) as Record<string, unknown>).not.toHaveProperty('lint');
  });

  it('refuses steps that are missing, empty or carry an argument a step does not take', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    for (const [steps, at] of [
      [[], 'steps'],
      [[{ text: ' ' }], 'steps[0].text'],
      [[{ text: 'Run it.', run: 'ls' }], 'steps[0].run'],
    ] as const) {
      const sentence = await refusal(target, 'request_human_action', {
        workspace: WORKSPACE.id,
        task: id,
        title: 'Update the demo',
        context: 'Why.',
        steps,
      });
      expect(sentence.startsWith('invalid arguments: '), sentence).toBe(true);
      expect(sentence).toContain(at);
    }
    expect((await current(project, id)).dependencies).toEqual([]);
  });
});

describe('close_task', () => {
  it('closes with the reason, crediting the closer and model, and keeps the card it shipped with', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    await write(target, 'update_task', {
      project: project.id,
      task: id,
      card: { valuePerMonth: 5, likelihood: 0.2, reviewMinutes: 3, daysToSignal: 14, measurability: 'holdout' },
      idempotency_key: key(),
    });
    const args = {
      project: project.id,
      task: id,
      reason: 'Shipped in 4f2a9c1.',
      model: 'model-x',
      idempotency_key: key(),
      detail: 'full',
    };
    const reply = await write<{ task: Record<string, unknown>; replayed: boolean }>(target, 'close_task', args);
    expect(reply).toMatchObject({
      task: {
        status: 'closed',
        closeReason: 'Shipped in 4f2a9c1.',
        resolution: 'done',
        cardShipped: { closedAt: time.now(), commit: '4f2a9c1', card: { measurability: 'holdout', by: WRITER.name } },
      },
      replayed: false,
    });
    expect((await current(project, id)).close).toMatchObject({ by: WRITER.name, model: 'model-x' });

    const again = await write<{ task: Record<string, unknown>; replayed: boolean }>(target, 'close_task', args);
    expect(again).toEqual({ ...reply, replayed: true });
    expect(await refusal(target, 'close_task', { workspace: WORKSPACE.id, ...args, reason: 'Other.' })).toMatch(
      /^conflict: /u,
    );
    expect(await refusal(target, 'close_task', { workspace: WORKSPACE.id, ...args, idempotency_key: key() })).toBe(
      `refused: ${id} is already closed; get_task shows its close reason.`,
    );
  });

  it('leaves a task nobody held free to claim once it is reopened', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    await write(target, 'close_task', { task: id, reason: 'Shipped.', commit: '4f2a9c1' });
    expect(await current(project, id)).toMatchObject({ status: 'closed', assignee: null });
    await write(target, 'update_task', { task: id, status: 'open' });
    const other = api({ principal: granted({ [project.id]: 'write' }, 'agent-other'), engine });
    expect(await write(other, 'claim_task', { task: id })).toMatchObject({
      status: 'in_progress',
      assignee: 'agent-other',
    });
  });

  it('closes a duplicate, linking it to the task it duplicates', async () => {
    const project = await newProject(engine);
    const original = await task(project, { title: 'Original' });
    const { id } = await task(project, { title: 'Copy' });
    const reply = await write<{ task: Record<string, unknown> }>(target, 'close_task', {
      project: project.id,
      task: id,
      reason: `Same as ${original.id}.`,
      resolution: 'duplicate',
      duplicate_of: original.id,
      idempotency_key: key(),
      detail: 'full',
    });
    expect(reply.task).toMatchObject({ resolution: 'duplicate', duplicateOf: original.id, cardShipped: null });
    expect((await current(project, id)).dependencies).toEqual([
      { taskId: original.id, type: 'related', title: 'Original', status: 'open' },
    ]);
  });

  it('refuses a task held by someone else, one waiting on an approval or on open children, and a person’s decision', async () => {
    const project = await newProject(engine);
    const held = await task(project);
    await engine.writeTask(
      project.id,
      held.id,
      { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress' } },
      AGENT,
    );
    const gated = await task(project);
    const { created } = await engine.writeTask(
      project.id,
      gated.id,
      { expectedVersion: 1, requestApproval: { reason: 'Approve.' } },
      OWNER,
    );
    const epic = await task(project, { title: 'Epic', type: 'epic' });
    const child = await task(project, { title: 'Child', parentId: epic.id });
    const human = await task(project, { title: 'Human', labels: ['human'] });
    const blocker = await task(project);
    const waiting = await task(project, {
      title: 'Waiting',
      links: [{ direction: 'depends-on', taskId: blocker.id, type: 'blocks' }],
    });
    const close = (id: string, args: Record<string, unknown> = {}) =>
      refusal(target, 'close_task', {
        workspace: WORKSPACE.id,
        project: project.id,
        task: id,
        reason: 'Done.',
        idempotency_key: key(),
        ...args,
      });

    expect(await close(held.id)).toBe(
      `refused: ${held.id} is held by ${AGENT.name}, and only its holder closes it. Reach ${AGENT.name} with comment_on_task, or ask a person to close it in the web app.`,
    );
    expect(await close(gated.id)).toBe(
      `refused: ${gated.id} waits on approval ${created[0]!.id}, which is still open. Use reconcile_task on the gate with the owner’s scoped answer, or action declined with their refusal; then close ${gated.id} with implementation evidence. A declined action must not happen.`,
    );
    expect(await close(epic.id)).toBe(
      `refused: ${epic.id} has open children: ${child.id}. Close them first, or give them another parent with update_task.`,
    );
    expect(await close(human.id)).toMatch(new RegExp(`^refused: ${human.id} is a human request\\.`, 'u'));
    expect(await close(created[0]!.id)).toMatch(new RegExp(`^refused: ${created[0]!.id} is a human request\\.`, 'u'));
    expect(await close(waiting.id, { resolution: 'duplicate' })).toBe(
      'invalid arguments: duplicate_of (required with resolution duplicate: the task this one duplicates)',
    );
    expect(await close(waiting.id, { duplicate_of: blocker.id })).toBe(
      'invalid arguments: duplicate_of (only with resolution duplicate)',
    );
    expect(await close(waiting.id, { resolution: 'duplicate', duplicate_of: waiting.id })).toBe(
      'invalid arguments: duplicate_of (another task than the one closing)',
    );
    // A task it depends on may still be open.
    await write(target, 'close_task', {
      project: project.id,
      task: waiting.id,
      reason: 'Done anyway.',
      idempotency_key: key(),
    });
    expect((await current(project, waiting.id)).status).toBe('closed');
  });

  it('turns an engine refusal it did not foresee into a refusal, never a fault', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const failing = api({
      principal: WRITER,
      engine,
      wrap: (inner) => ({
        ...inner,
        writeTask: async () => {
          throw new TaskRefused('invalid', 'The write is not valid.');
        },
      }),
    });
    expect(
      await refusal(failing, 'close_task', {
        workspace: WORKSPACE.id,
        project: project.id,
        task: id,
        reason: 'Done.',
        idempotency_key: key(),
      }),
    ).toBe('invalid arguments: The write is not valid.');
  });
});

describe('create_task with claim and done', () => {
  it('files a task claimed by the sender, in progress, in one call', async () => {
    const project = await newProject(engine);
    const filed = await write<{ id: string }>(target, 'create_task', {
      project: project.id,
      title: 'Start this now',
      claim: true,
      model: 'model-x',
    });
    expect(filed).toMatchObject({ status: 'in_progress', assignee: WRITER.name, version: 1, replayed: false });
    expect(await current(project, filed.id)).toMatchObject({ assigneeModel: 'model-x', startedAt: time.now() });
    // A batch entry takes it too.
    const batch = await write<{ results: { id: string; status: string }[] }>(target, 'create_tasks', {
      project: project.id,
      tasks: [{ title: 'Start this as well', claim: true }],
    });
    expect(batch.results[0]).toMatchObject({ status: 'in_progress', assignee: WRITER.name });
  });

  it('files finished work closed as done, with its evidence and proof, held by nobody', async () => {
    const project = await newProject(engine);
    const filed = await write<{ id: string; warnings?: string[] }>(target, 'create_task', {
      project: project.id,
      title: 'Fixed the broken link',
      type: 'bug',
      done: { evidence: 'Fixed in 4f2a9c1.', commit: '4F2A9C1' },
    });
    expect(filed).toMatchObject({
      status: 'closed',
      resolution: 'done',
      delivery: { stage: 'built', commit: '4f2a9c1' },
      version: 1,
    });
    expect(filed).not.toHaveProperty('warnings');
    expect(await current(project, filed.id)).toMatchObject({
      assignee: null,
      close: { reason: 'Fixed in 4f2a9c1.', by: WRITER.name },
    });
    const history = await read<{ changes: { actions: string[] }[] }>(target, 'get_task_history', { task: filed.id });
    expect(history.changes.map((change) => change.actions)).toEqual([['created']]);
  });

  it('refuses a task filed both claimed and done, done while it waits on an approval, or done when a person closes it', async () => {
    const project = await newProject(engine);
    const refused = (args: Record<string, unknown>) =>
      refusal(target, 'create_task', { workspace: WORKSPACE.id, project: project.id, title: 'T', ...args });
    const done = { evidence: 'Done.' };
    expect(await refused({ claim: true, done })).toMatch(/^invalid arguments: claim and done /u);
    expect(await refused({ done, approval: 'Approve it.' })).toMatch(/^invalid arguments: done and approval /u);
    expect(await refused({ done, labels: ['human'] })).toMatch(/^refused: /u);
    const waiting = await task(project, { title: 'Waits on an approval' });
    const { created } = await engine.writeTask(
      project.id,
      waiting.id,
      { expectedVersion: 1, requestApproval: { reason: 'Approve it.' } },
      OWNER,
    );
    const gate = created[0]!.id;
    const gated = await refused({ done, depends_on: [gate] });
    expect(gated).toMatch(/^refused: /u);
    expect(gated).toContain(gate);
    expect(await refused({ done: { evidence: 'Done.', link: 'not a url' } })).toMatch(
      /^invalid arguments: done\.link /u,
    );
    expect(await refused({ done: { evidence: 'Done.', when: 'today' } })).toMatch(/^invalid arguments: done /u);
    expect((await engine.listTasks(project.id, { limit: 10 })).tasks.map((row) => row.id).sort()).toEqual(
      [waiting.id, gate].sort(),
    );
  });

  it('names open tasks in its project whose titles share most of its words as possible duplicates', async () => {
    const project = await newProject(engine);
    const other = await newProject(engine);
    const alike = await task(project, { title: 'Fix the login redirect loop on Safari' });
    await task(project, { title: 'Write the pricing page' });
    const closed = await task(project, { title: 'Fix the login redirect loop' });
    await engine.writeTask(
      project.id,
      closed.id,
      { expectedVersion: 1, close: { reason: 'Done.', resolution: 'done' } },
      OWNER,
    );
    await task(other, { title: 'Fix the login redirect loop on Safari' });
    const filed = await write<{ id: string; possibleDuplicates?: unknown }>(target, 'create_task', {
      project: project.id,
      title: 'Login redirect loop on Safari',
    });
    expect(filed.possibleDuplicates).toEqual([{ id: alike.id, title: alike.title, status: 'open' }]);
    const unlike = await write(target, 'create_task', { project: project.id, title: 'Rename the settings tab' });
    expect(unlike).not.toHaveProperty('possibleDuplicates');
    // A batch's tasks are not each other's duplicates; the task filed above is one, less alike.
    const batch = await write<{ results: { possibleDuplicates?: { id: string }[] }[] }>(target, 'create_tasks', {
      project: project.id,
      tasks: [{ title: 'Safari login redirect loop fix' }, { title: 'Safari login redirect loop fix' }],
    });
    for (const result of batch.results)
      expect(result.possibleDuplicates?.map((entry) => entry.id)).toEqual([alike.id, filed.id]);
  });
});

describe('claim_task by pull request', () => {
  it('claims the open task a pull request names, through its link or its holder’s work details, and refuses none or several', async () => {
    const project = await newProject(engine);
    const pull = (number: number) => `https://github.com/example/web/pull/${number}`;
    const linked = await task(project, {
      title: 'Linked',
      externalLinks: [{ url: pull(7), title: 'The fix', kind: 'pull-request' }],
    });
    const claimed = await write(target, 'claim_task', { pr: 'https://github.com/Example/Web/pull/7/files' });
    expect(claimed).toMatchObject({ id: linked.id, status: 'in_progress', assignee: WRITER.name });

    // Another holder's work details name pull request 8: the task is found, and its claim refused for that holder.
    const working = await task(project, { title: 'Working' });
    await engine.writeTask(
      project.id,
      working.id,
      { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress', work: { pr: pull(8) } } },
      AGENT,
    );
    const refused = (pr: string) => refusal(target, 'claim_task', { workspace: WORKSPACE.id, pr });
    expect(await refused(pull(8))).toBe(
      `refused: ${working.id} is held by ${AGENT.name}. Choose another task, or reach ${AGENT.name} with comment_on_task.`,
    );
    expect(await refused(pull(99))).toMatch(/^refused: no open task names pull request /u);
    const twins = [
      await task(project, { title: 'One', externalLinks: [{ url: pull(9), title: 'PR', kind: 'pull-request' }] }),
      await task(project, { title: 'Two', externalLinks: [{ url: pull(9), title: 'PR', kind: 'pull-request' }] }),
    ];
    const several = await refused(pull(9));
    for (const twin of twins) expect(several).toContain(twin.id);
    expect(await refusal(target, 'claim_task', { workspace: WORKSPACE.id })).toMatch(/^invalid arguments: task /u);
  });
});

describe('close_task on several tasks', () => {
  type Closed = { results: Record<string, unknown>[]; unblocked: { id: string; title: string }[] };

  it('closes each with one evidence, refusing a held one alone, and lists the tasks they unblocked', async () => {
    const project = await newProject(engine);
    const [a, b] = [await task(project, { title: 'A' }), await task(project, { title: 'B' })];
    const held = await task(project, { title: 'Held' });
    await engine.writeTask(
      project.id,
      held.id,
      { expectedVersion: 1, set: { assignee: AGENT.name, status: 'in_progress' } },
      AGENT,
    );
    const waiting = await task(project, {
      title: 'Waits on A and B',
      links: [
        { direction: 'depends-on', taskId: a.id, type: 'blocks' },
        { direction: 'depends-on', taskId: b.id, type: 'blocks' },
      ],
    });
    await task(project, {
      title: 'Waits on the held one',
      links: [{ direction: 'depends-on', taskId: held.id, type: 'blocks' }],
    });
    const args = { tasks: [a.id, held.id, b.id], reason: 'Shipped in 4f2a9c1.', commit: '4f2a9c1' };
    const reply = await write<Closed>(target, 'close_task', args);
    const closed = (id: string) => ({
      id,
      status: 'closed',
      resolution: 'done',
      delivery: expect.objectContaining({ stage: 'built', commit: '4f2a9c1' }),
      version: expect.any(Number),
      replayed: false,
    });
    expect(reply.results).toEqual([
      closed(a.id),
      { id: held.id, error: expect.stringMatching(new RegExp(`^refused: ${held.id} is held by ${AGENT.name}`, 'u')) },
      closed(b.id),
    ]);
    expect(reply.unblocked).toEqual([{ id: waiting.id, title: 'Waits on A and B' }]);
    expect(await current(project, held.id)).toMatchObject({ status: 'in_progress' });
    // A close leaves who holds the task as it was; the close records who closed it.
    expect(await current(project, a.id)).toMatchObject({
      status: 'closed',
      assignee: null,
      close: { by: WRITER.name },
    });
    // The same call sent again answers each close it made, and closes nothing twice.
    const again = await write<Closed>(target, 'close_task', args);
    expect(again.results.map((result) => result.replayed ?? null)).toEqual([true, null, true]);
  });

  it('closes an epic after every open task under it, with with_children', async () => {
    const project = await newProject(engine);
    const epic = await task(project, { title: 'Launch', type: 'epic' });
    const child = await task(project, { title: 'Page', parentId: epic.id });
    const grandchild = await task(project, { title: 'Copy', parentId: child.id });
    const done = await task(project, { title: 'Done already', parentId: epic.id });
    await engine.writeTask(
      project.id,
      done.id,
      { expectedVersion: 1, close: { reason: 'Done.', resolution: 'done' } },
      OWNER,
    );
    const link = 'https://docs.example.com/launch';
    const reply = await write<Closed>(target, 'close_task', {
      task: epic.id,
      with_children: true,
      reason: 'Launched.',
      link,
    });
    expect(reply.results.map((result) => [result.id, result.status])).toEqual([
      [grandchild.id, 'closed'],
      [child.id, 'closed'],
      [epic.id, 'closed'],
    ]);
    expect((await current(project, epic.id)).close).toMatchObject({ reason: 'Launched.', link });
    expect((await current(project, grandchild.id)).close).toMatchObject({ reason: 'Launched.', link });
  });

  it('names the epic that closed itself with its last open task, and lists the tasks that waited on it as ready', async () => {
    const project = await newProject(engine);
    const epic = await task(project, { title: 'Launch', type: 'epic' });
    const last = await task(project, { title: 'Page', parentId: epic.id });
    const next = await task(project, {
      title: 'Announce it',
      links: [{ direction: 'depends-on', taskId: epic.id, type: 'blocks' }],
    });

    const reply = await write<{ closedEpics: unknown; unblocked: unknown }>(target, 'close_task', {
      task: last.id,
      reason: 'Shipped in 4f2a9c1.',
    });

    expect(reply.closedEpics).toEqual([{ id: epic.id, resolution: 'done' }]);
    expect(reply.unblocked).toEqual([{ id: next.id, title: 'Announce it' }]);
  });

  it('shows nothing under an epic in a project the sender cannot reach, and finds the tasks under one named by key', async () => {
    const mine = await newProject(engine);
    const theirs = await newProject(engine);
    const hidden = await task(theirs, { title: 'Their epic', type: 'epic' });
    const secret = await task(theirs, { title: 'Their child', parentId: hidden.id });
    const sender = api({ principal: granted({ [mine.id]: 'write' }, 'agent-mine'), engine });
    const reply = await write<Closed>(sender, 'close_task', {
      project: theirs.id,
      task: hidden.id,
      with_children: true,
      reason: 'Done.',
    });
    expect(reply.results).toEqual([{ id: hidden.id, error: missingProject(theirs.id) }]);
    expect(JSON.stringify(reply)).not.toContain(secret.id);
    expect((await current(theirs, secret.id)).status).toBe('open');

    const epic = await task(mine, { title: 'My epic', type: 'epic' });
    const child = await task(mine, { title: 'My child', parentId: epic.id });
    const named = await write<Closed>(sender, 'close_task', {
      project: mine.key,
      task: epic.id,
      with_children: true,
      reason: 'Done.',
      commit: '4f2a9c1',
    });
    expect(named.results.map((result) => result.id)).toEqual([child.id, epic.id]);
  });

  it('refuses a call that would close more than 50 tasks in all, writing nothing, and names how many', async () => {
    const project = await newProject(engine);
    const epics = [
      await task(project, { title: 'First', type: 'epic' }),
      await task(project, { title: 'Second', type: 'epic' }),
    ];
    for (const epic of epics)
      for (let index = 0; index < 30; index += 1) await task(project, { title: `Part ${index}`, parentId: epic.id });
    const idempotency_key = key();
    const refused = await refusal(target, 'close_task', {
      workspace: WORKSPACE.id,
      tasks: epics.map((epic) => epic.id),
      with_children: true,
      reason: 'Done.',
      idempotency_key,
    });
    expect(refused).toMatch(/^invalid arguments: tasks /u);
    expect(refused).toContain('62');
    const open = await engine.listBoard(project.id, { statuses: ['open'] });
    expect(open).toHaveLength(62);
    // Nothing was written, not even the key's record: the key still takes a smaller call.
    await write(target, 'close_task', { tasks: [epics[0]!.id], with_children: true, reason: 'Done.', idempotency_key });
    expect((await current(project, epics[0]!.id)).status).toBe('closed');
  });

  it('refuses a key sent again with other tasks, writing none of them (rule 3)', async () => {
    const project = await newProject(engine);
    const [a, b, c] = [await task(project, { title: 'A' }), await task(project, { title: 'B' }), await task(project)];
    const idempotency_key = key();
    const args = { tasks: [a.id, b.id], reason: 'Shipped.', commit: '4f2a9c1', idempotency_key };
    await write(target, 'close_task', args);
    const again = await write<Closed>(target, 'close_task', args);
    expect(again.results.map((result) => result.replayed)).toEqual([true, true]);
    expect(await refusal(target, 'close_task', { workspace: WORKSPACE.id, ...args, tasks: [c.id] })).toMatch(
      /^conflict: /u,
    );
    expect((await current(project, c.id)).status).toBe('open');

    const comment = { tasks: [a.id, b.id], text: 'Checked.', idempotency_key: key() };
    await write(target, 'comment_on_task', comment);
    expect(await refusal(target, 'comment_on_task', { workspace: WORKSPACE.id, ...comment, tasks: [c.id] })).toMatch(
      /^conflict: /u,
    );
    expect(await engine.listComments(project.id, c.id)).toEqual([]);
  });
});

describe('proof of work closed as done', () => {
  it('shows proof none on a task done with no commit, pull request or link, and warns its closer', async () => {
    const project = await newProject(engine);
    const plain = await task(project, { title: 'Write the runbook' });
    const reply = await write<{ warnings?: string[] }>(target, 'close_task', { task: plain.id, reason: 'Written.' });
    expect(reply.warnings).toHaveLength(1);
    expect(reply.warnings?.[0]).toContain(plain.id);
    expect((await read<{ task: Record<string, unknown> }>(target, 'get_task', { task: plain.id })).task.proof).toBe(
      'none',
    );
    const listed = await read<{ tasks: Record<string, unknown>[] }>(target, 'list_tasks', { project: project.id });
    expect(listed.tasks.find((row) => row.id === plain.id)?.proof).toBe('none');
  });

  it('counts a link, a commit or pull request, or the ones its holder recorded, as proof, and exempts decisions and epics', async () => {
    const project = await newProject(engine);
    const link = 'https://docs.example.com/runbook';
    const shown = async (id: string) =>
      (await read<{ task: Record<string, unknown> }>(target, 'get_task', { task: id })).task;

    const linked = await task(project, { title: 'Linked' });
    const reply = await write(target, 'close_task', { task: linked.id, reason: 'Published.', link });
    expect(reply).not.toHaveProperty('warnings');
    expect(await shown(linked.id)).toMatchObject({ closeLink: link });
    expect(await shown(linked.id)).not.toHaveProperty('proof');

    const worked = await task(project, { title: 'Worked' });
    await write(target, 'claim_task', { task: worked.id, commit: '4f2a9c1' });
    expect(await write(target, 'close_task', { task: worked.id, reason: 'Merged.' })).not.toHaveProperty('warnings');

    for (const type of ['decision', 'epic'] as const) {
      const exempt = await task(project, { title: type, type });
      expect(await write(target, 'close_task', { task: exempt.id, reason: 'Done.' })).not.toHaveProperty('warnings');
      expect(await shown(exempt.id)).not.toHaveProperty('proof');
    }
    const dropped = await task(project, { title: 'Dropped' });
    await write(target, 'close_task', { task: dropped.id, reason: 'Not needed.', resolution: 'wont-do' });
    expect(await shown(dropped.id)).not.toHaveProperty('proof');
    expect(
      await refusal(target, 'close_task', {
        workspace: WORKSPACE.id,
        task: dropped.id,
        reason: 'x',
        resolution: 'wont-do',
        link,
      }),
    ).toMatch(/^invalid arguments: commit, pr and link /u);
  });
});

describe('comment_on_task on several tasks', () => {
  it('records the same comment once on each, refusing a missing task alone', async () => {
    const project = await newProject(engine);
    const [a, b] = [await task(project, { title: 'A' }), await task(project, { title: 'B' })];
    const missing = `${project.prefix}-none`;
    const args = { tasks: [a.id, missing, b.id], text: 'Checked with the full suite.' };
    const reply = await write<{ results: Record<string, unknown>[] }>(target, 'comment_on_task', args);
    expect(reply.results).toEqual([
      { task: a.id, commentId: expect.any(String), replayed: false },
      { task: missing, error: expect.stringMatching(/^refused: /u) },
      { task: b.id, commentId: expect.any(String), replayed: false },
    ]);
    // Sent again, each comment answers as it was, and none is added twice.
    const again = await write<{ results: Record<string, unknown>[] }>(target, 'comment_on_task', args);
    expect(again.results.map((result) => result.replayed ?? null)).toEqual([true, null, true]);
    for (const id of [a.id, b.id]) expect(await engine.listComments(project.id, id)).toHaveLength(1);
    expect(
      await refusal(target, 'comment_on_task', { workspace: WORKSPACE.id, task: a.id, tasks: [b.id], text: 'x' }),
    ).toMatch(/^invalid arguments: task and tasks /u);
  });
});
