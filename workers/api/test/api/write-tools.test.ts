// The MCP tools that change tasks, as an agent calls them: their schemas,
// what each one changes and answers, the sentences each refusal returns, and
// retries. Names and arguments are NoticeOS's task tools'.
import { TaskRefused, type Project, type Task, type TaskEngine } from '@ntasks/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { CHOICES_ADVICE } from '../../src/noticeos-fields.ts';
import { AGENT, clock, newProject, OWNER } from '../engine/helpers.ts';
import {
  api,
  callTool,
  granted,
  ORIGIN,
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
// agents written for NoticeOS were given. reconcile_task and get_agent_stats
// are copied from their definitions in scripts/hosted-task-mcp.mts at commit
// 09563bcc, with the workspace argument its endpoint adds to every tool.
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
      'reconcile_task.detail',
      'list_tasks.fields',
      'create_task.notes',
      'create_task.design',
      'create_task.estimate_minutes',
      'create_task.duplicates',
      'create_task.supersedes',
      'create_task.external_links',
      'create_task.fields',
      'create_task.detail',
      'create_tasks.tasks.notes',
      'create_tasks.tasks.design',
      'create_tasks.tasks.estimate_minutes',
      'create_tasks.tasks.duplicates',
      'create_tasks.tasks.supersedes',
      'create_tasks.tasks.external_links',
      'create_tasks.tasks.fields',
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
      'comment_on_task.model',
      'comment_on_task.detail',
      'add_dependency.model',
      'remove_dependency.model',
      'request_human_approval.model',
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
    ['add_dependency', (project, id) => ({ project, task: id, depends_on: `${id}x` })],
    ['remove_dependency', (project, id) => ({ project, task: id, depends_on: `${id}x` })],
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
    // create_tasks reports a refused task in its answer, as its first task refused.
    expect(
      await write(sender, 'create_tasks', { project: project.id, tasks: [{ title: 'New' }], idempotency_key: key() }),
    ).toMatchObject({ created: [], failed: { index: 0, error: forbidden } });
    for (const [name, args] of calls.filter(([name]) => name !== 'create_tasks')) {
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
    const closed = await write(target, 'close_task', { task: id, reason: 'Shipped in abc1234.' });
    expect(closed).toEqual({
      id,
      status: 'closed',
      resolution: 'done',
      version: (await current(project, id)).version,
      replayed: false,
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

  it('answers the same write sent again without a key with its first result, and writes it once', async () => {
    const project = await newProject(engine);
    const args = { project: project.id, title: 'Once' };
    const first = await write(target, 'create_task', args);
    expect(await write(target, 'create_task', args)).toEqual({ ...first, replayed: true });
    expect((await engine.listTasks(project.id, { limit: 10 })).tasks).toHaveLength(1);
    // A key of the caller's own makes the same change again on purpose, and another sender's call is its own.
    await write(target, 'create_task', { ...args, idempotency_key: key() });
    await write(api({ principal: granted({ [project.id]: 'write' }, 'agent-o'), engine }), 'create_task', args);
    expect((await engine.listTasks(project.id, { limit: 10 })).tasks).toHaveLength(3);
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
    const batch = await write<{ staleClient: string; created: { id: string }[] }>(target, 'create_tasks', {
      project: project.id,
      tasks: [{ title: 'Plain' }, { title: 'Carded', card: JSON.stringify(card) }],
      idempotency_key: key(),
    });
    expect(batch.staleClient).toBe(stale('tasks[1].card'));
    expect((await current(project, batch.created[1]!.id)).metadata.noticeos_card).toMatchObject(card);

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
    ).toMatchObject({ created: [], failed: { index: 0, error: unavailable } });
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
    const reply = await write<{ created: { id: string; replayed: boolean }[]; note?: string }>(
      target,
      'create_tasks',
      args,
    );
    const [epic, child, gated] = reply.created.map((entry) => entry.id);
    expect(reply).toMatchObject({
      created: [
        { index: 0, id: epic, status: 'open', replayed: false, lint: { missing: ['## Success Criteria'] } },
        { index: 1, id: `${epic}.1`, status: 'open', replayed: false },
        { index: 2, id: gated, replayed: false, approval: { status: 'open', reason: 'Approve it.' }, held: true },
      ],
      note: 'A task with an approval waits for the owner’s scoped approval. Record an existing answer with reconcile_task.',
    });
    expect((await current(project, gated!)).dependencies.map((link) => link.taskId)).toContain(child);

    const again = await write<{ created: { id: string; replayed: boolean }[] }>(target, 'create_tasks', args);
    expect(again.created.map((entry) => [entry.id, entry.replayed])).toEqual(
      reply.created.map((entry) => [entry.id, true]),
    );
    expect((await engine.listTasks(project.id, { limit: 10 })).tasks).toHaveLength(4);
  });

  it('stops at the first task refused, saying which, and files the rest on a retry', async () => {
    const project = await newProject(engine);
    const args = {
      project: project.id,
      tasks: [{ title: 'First' }, { title: 'Second', parent: `${project.prefix}-none` }, { title: 'Third' }],
      idempotency_key: key(),
    };
    const reply = await write<Record<string, unknown> & { created: { id: string }[] }>(target, 'create_tasks', args);
    expect(reply).toMatchObject({
      created: [{ index: 0, replayed: false }],
      failed: {
        index: 1,
        error: `refused: ${project.prefix}-none is not a task in projectId ${project.id} (${project.name}); list_tasks lists its tasks.`,
      },
      notAttempted: 1,
    });
    expect((await engine.listTasks(project.id, { limit: 10 })).tasks).toHaveLength(1);
  });

  it('files nothing when an entry breaks a rule, naming the entry and the argument by its path', async () => {
    const project = await newProject(engine);
    const refused = (tasks: unknown) =>
      refusal(target, 'create_tasks', { workspace: WORKSPACE.id, project: project.id, tasks, idempotency_key: key() });
    expect(await refused([{ title: 'Fine' }, { title: '' }])).toBe('invalid arguments: tasks[1].title (empty)');
    expect(await refused([{ title: 'A', parent: '#0' }])).toBe(
      "invalid arguments: tasks[0].parent (#0 is not an earlier task of this call: #n counts this call's tasks from zero, so tasks[0] may name none, as the first)",
    );
    expect(await refused([{ title: 'A' }, { title: 'B' }, { title: 'C', blocks: ['#1', '#2'] }])).toBe(
      "invalid arguments: tasks[2].blocks[1] (#2 is not an earlier task of this call: #n counts this call's tasks from zero, so tasks[2] may name #0 to #1)",
    );
    expect(await refused([{ title: 'A', depends_on: ['Not An Id'] }])).toBe(
      'invalid arguments: tasks[0].depends_on[0] (a task id such as abc-1x2)',
    );
    expect(await refused([{ title: 'A', model: 'x' }])).toBe('invalid arguments: unknown argument tasks[0].model');
    expect(await refused([])).toBe('invalid arguments: tasks (1–25)');
    expect((await engine.listTasks(project.id, { limit: 10 })).tasks).toEqual([]);
  });

  it('reports a project it cannot reach as its first task refused', async () => {
    const reply = await write<Record<string, unknown>>(target, 'create_tasks', {
      project: 'missing',
      tasks: [{ title: 'A' }, { title: 'B' }],
      idempotency_key: key(),
    });
    expect(reply).toMatchObject({
      created: [],
      failed: { index: 0, error: missingProject('missing') },
      notAttempted: 1,
    });
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
    const batch = await write<{ created: { id: string }[] }>(target, 'create_tasks', {
      project: project.id,
      tasks: [{ title: 'Second', notes: 'Batch note.', estimate_minutes: 0 }],
      idempotency_key: key(),
    });
    expect(await current(project, batch.created[0]!.id)).toMatchObject({
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
    expect(listed.tasks.find((row) => row.id === batch.created[0]!.id)).toMatchObject({ estimateMinutes: 0 });
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

    expect(
      await write(target, 'remove_dependency', { project: project.id, task: later.id, depends_on: elsewhere.id }),
    ).toMatchObject({ removed: true });
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

  it('refuse a link to the task itself, and a type add_dependency does not take', async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const kin = await task(project, { title: 'Kin' });
    const base = { workspace: WORKSPACE.id, project: project.id, task: id, idempotency_key: key() };
    expect(await refusal(target, 'update_task', { ...base, supersedes: [id] })).toBe(
      'invalid arguments: supersedes (another task than this one)',
    );
    expect(
      await refusal(target, 'add_dependency', {
        workspace: WORKSPACE.id,
        project: project.id,
        task: id,
        depends_on: kin.id,
        type: 'duplicates',
      }),
    ).toBe('invalid arguments: type (one of blocks, related, discovered-from)');
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
      comment: { id: expect.any(String), author: WRITER.name, text: 'Halfway.', createdAt: time.now() },
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
});

describe('add_dependency and remove_dependency', () => {
  it('records a dependency once, keeps its type, and removes it', async () => {
    const project = await newProject(engine);
    const blocker = await task(project, { title: 'Blocker' });
    const { id } = await task(project, { title: 'Waits' });
    const args = { project: project.id, task: id, depends_on: blocker.id };
    expect(await write(target, 'add_dependency', args)).toEqual({ task: id, dependsOn: blocker.id, type: 'blocks' });
    expect(await write(target, 'add_dependency', args)).toEqual({ task: id, dependsOn: blocker.id, type: 'blocks' });
    expect(await current(project, id)).toMatchObject({ ready: false, version: 2 });
    expect(await refusal(target, 'add_dependency', { workspace: WORKSPACE.id, ...args, type: 'related' })).toBe(
      `refused: ${id} already depends on ${blocker.id} as blocks, and a dependency keeps the type it was added with. To record it as related, remove_dependency first, then add it again.`,
    );
    expect(
      await refusal(target, 'add_dependency', {
        workspace: WORKSPACE.id,
        project: project.id,
        task: blocker.id,
        depends_on: id,
      }),
    ).toBe(
      `refused: ${id} already waits on ${blocker.id}, so ${blocker.id} cannot depend on it: the two would wait on each other in a loop.`,
    );
    expect(await write(target, 'remove_dependency', args)).toEqual({ task: id, dependsOn: blocker.id, removed: true });
    expect(await write(target, 'remove_dependency', args)).toEqual({ task: id, dependsOn: blocker.id, removed: true });
    expect(await current(project, id)).toMatchObject({ ready: true, dependencies: [], version: 3 });
  });

  it('links a related task in another project, but refuses a blocking one there', async () => {
    const project = await newProject(engine);
    const other = await newProject(engine);
    const { id } = await task(project);
    const kin = await task(other);
    await write(target, 'add_dependency', { project: project.id, task: id, depends_on: kin.id, type: 'related' });
    expect((await current(project, id)).dependencies).toEqual([
      { taskId: kin.id, type: 'related', title: 'A task', status: 'open' },
    ]);
    expect(
      await refusal(target, 'add_dependency', {
        workspace: WORKSPACE.id,
        project: project.id,
        task: id,
        depends_on: kin.id,
      }),
    ).toBe(
      `refused: ${kin.id} is not in projectId ${project.id} (${project.name}), whose tasks start ${project.prefix}-; tasks with prefix ${other.prefix} are in projectId ${other.id} (${other.name}).`,
    );
  });

  it("leaves a dependency on a person's decision for the person", async () => {
    const project = await newProject(engine);
    const { id } = await task(project);
    const { created } = await engine.writeTask(
      project.id,
      id,
      { expectedVersion: 1, requestApproval: { reason: 'Approve it.' } },
      OWNER,
    );
    expect(
      await refusal(target, 'remove_dependency', {
        workspace: WORKSPACE.id,
        project: project.id,
        task: id,
        depends_on: created[0]!.id,
      }),
    ).toMatch(new RegExp(`^refused: ${created[0]!.id} is a human request\\.`, 'u'));
    expect(
      await refusal(target, 'add_dependency', {
        workspace: WORKSPACE.id,
        project: project.id,
        task: id,
        depends_on: id,
      }),
    ).toBe('invalid arguments: depends_on (another task than this one)');
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
    expect(again).toEqual({ task: reply.task, replayed: true });
    expect(await refusal(target, 'close_task', { workspace: WORKSPACE.id, ...args, reason: 'Other.' })).toMatch(
      /^conflict: /u,
    );
    expect(await refusal(target, 'close_task', { workspace: WORKSPACE.id, ...args, idempotency_key: key() })).toBe(
      `refused: ${id} is already closed; get_task shows its close reason.`,
    );
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
