// Moving tasks as an agent and the web app do it: move_tasks and POST
// /api/tasks/move, and the old id of a task moved to another project, which
// every tool and task route still reads as the task.
import type { Project, Task, TaskEngine } from '@ntasks/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { newProject, OWNER } from '../engine/helpers.ts';
import { api, get, granted, read, refusal, send, write, WRITER, type TestApi } from './helpers.ts';

const LINK = 'https://example.com/deploys/42';

let target: TestApi;
let engine: TaskEngine;

beforeAll(() => {
  target = api({ principal: WRITER });
  engine = target.engine;
});

async function task(project: Project, input: Parameters<TaskEngine['createTask']>[1] = { title: 'A task' }) {
  return (await engine.createTask(project.id, input, OWNER)).task;
}

async function stored(project: Project, ids: readonly string[]): Promise<readonly Task[]> {
  return engine.getTasks(project.id, ids);
}

interface Moved {
  readonly tasks: readonly { readonly id: string; readonly parent: string | null; readonly version: number }[];
  readonly moved: Readonly<Record<string, string>>;
  readonly fieldsKept?: Readonly<Record<string, readonly string[]>>;
  readonly epics?: readonly { readonly id: string; readonly status: string }[];
  readonly replayed: boolean;
}

describe('move_tasks', () => {
  it('moves a task to another project, and its old id names it in get_task, update_task and link_tasks', async () => {
    const [from, to] = [await newProject(engine), await newProject(engine)];
    const moving = await task(from, { title: 'Write the runbook' });
    const other = await task(to, { title: 'Train the team' });

    const answer = await write<Moved>(target, 'move_tasks', { task: moving.id, project: to.key });

    const newId = answer.moved[moving.id]!;
    expect(newId.startsWith(`${to.prefix}-`)).toBe(true);
    expect(answer.tasks).toEqual([{ id: newId, parent: null, version: moving.version + 1 }]);
    const shown = await read<{ task: { id: string }; formerIds: Record<string, string> }>(target, 'get_task', {
      task: moving.id,
    });
    expect(shown.task.id).toBe(newId);
    expect(shown.formerIds).toEqual({ [moving.id]: newId });
    const updated = await write<{ id: string; formerIds: Record<string, string> }>(target, 'update_task', {
      task: moving.id,
      priority: 0,
    });
    expect(updated).toMatchObject({ id: newId, formerIds: { [moving.id]: newId } });
    await write(target, 'link_tasks', { task: other.id, to: moving.id, type: 'related' });
    const [linked] = await stored(to, [other.id]);
    expect(linked!.dependencies).toMatchObject([{ taskId: newId, type: 'related' }]);
    expect((await stored(to, [newId]))[0]).toMatchObject({ priority: 0, projectId: to.id });
  });

  it('moves an epic with the tasks under it only with with_children, refusing first and moving nothing', async () => {
    const [from, to] = [await newProject(engine), await newProject(engine)];
    const epic = await task(from, { title: 'Launch', type: 'epic' });
    const child = await task(from, { title: 'Pick the date', parentId: epic.id });
    const marketing = await task(to, { title: 'Marketing', type: 'epic' });

    const refused = await refusal(target, 'move_tasks', { task: epic.id, parent: marketing.id });
    const before = await stored(from, [epic.id, child.id]);
    const answer = await write<Moved>(target, 'move_tasks', {
      task: epic.id,
      parent: marketing.id,
      with_children: true,
    });

    expect(refused).toContain(`with_children (${epic.id} has tasks under it, such as ${child.id}`);
    expect(before.map((one) => one.version)).toEqual([epic.version, child.version]);
    expect(answer.moved).toEqual({ [epic.id]: `${marketing.id}.1`, [child.id]: `${marketing.id}.1.1` });
    expect(answer.tasks).toEqual([{ id: `${marketing.id}.1`, parent: marketing.id, version: epic.version + 1 }]);
    expect(await stored(from, [epic.id, child.id])).toEqual([]);
  });

  it('refuses a project of another workspace, a disabled project, a parent in another project and too many tasks, moving nothing', async () => {
    const [from, to, off] = [await newProject(engine), await newProject(engine), await newProject(engine)];
    await engine.updateProject(off.id, { disabled: true });
    const moving = await task(from);
    const elsewhere = await task(off, { title: 'Brand', type: 'epic' });
    const epic = await task(from, { title: 'Big', type: 'epic' });
    for (let index = 0; index < 50; index += 1) await task(from, { title: `Part ${index}`, parentId: epic.id });

    const unknown = await refusal(target, 'move_tasks', { task: moving.id, project: 'other-workspace.example.com' });
    const disabled = await refusal(target, 'move_tasks', { task: moving.id, project: off.key });
    const mismatched = await refusal(target, 'move_tasks', { task: moving.id, project: to.key, parent: elsewhere.id });
    const many = await refusal(target, 'move_tasks', { task: epic.id, project: to.key, with_children: true });

    expect(unknown).toContain('A task moves only between projects of its own workspace');
    expect(disabled).toContain('is disabled, so it takes no new tasks');
    expect(mismatched).toContain(`invalid arguments: parent (${elsewhere.id} is in`);
    expect(many).toContain('one move places at most 50 tasks');
    expect(await stored(from, [moving.id, epic.id])).toEqual([
      expect.objectContaining({ id: moving.id, version: moving.version }),
      expect.objectContaining({ id: epic.id, version: epic.version }),
    ]);
  });

  it('refuses a task its sender may only read, and one it cannot reach as if it did not exist, moving nothing', async () => {
    const [from, to, hidden] = [await newProject(engine), await newProject(engine), await newProject(engine)];
    const readable = await task(from);
    const unseen = await task(hidden);
    const agent = api({ principal: granted({ [from.id]: 'read', [to.id]: 'write' }), engine });

    const readOnly = await refusal(agent, 'move_tasks', { task: readable.id, project: to.key });
    const missing = await refusal(agent, 'move_tasks', { tasks: [unseen.id], project: to.key });

    expect(readOnly).toContain('this call needs tasks:write');
    expect(missing).toContain(`no project you can reach has prefix ${hidden.prefix}`);
    expect(await stored(from, [readable.id])).toEqual([expect.objectContaining({ version: readable.version })]);
    expect(await stored(hidden, [unseen.id])).toEqual([expect.objectContaining({ version: unseen.version })]);
  });

  it('answers the same move sent again with its key, naming the old ids, without moving again', async () => {
    const [from, to] = [await newProject(engine), await newProject(engine)];
    const moving = await task(from);
    const args = { tasks: [moving.id], project: to.key, idempotency_key: `key-${crypto.randomUUID()}` };

    const first = await write<Moved>(target, 'move_tasks', args);
    const again = await write<Moved & { formerIds: Record<string, string> }>(target, 'move_tasks', args);
    const keyless = await task(from);
    const once = await write<Moved>(target, 'move_tasks', { task: keyless.id, project: to.key });
    const twice = await write<Moved>(target, 'move_tasks', { task: keyless.id, project: to.key });

    expect(again).toMatchObject({ moved: first.moved, tasks: first.tasks, replayed: true });
    expect(again.formerIds).toEqual(first.moved);
    expect(twice).toMatchObject({ moved: once.moved, replayed: true });
    for (const newId of [first.moved[moving.id]!, once.moved[keyless.id]!])
      expect((await engine.listHistory(to.id, newId, { limit: 10 })).map((event) => event.kind)).toEqual([
        'updated',
        'created',
      ]);
  });

  it('keeps field values the new project does not define, and names them', async () => {
    const [from, to] = [await newProject(engine), await newProject(engine)];
    await engine.defineField(from.id, { key: 'area', name: 'Area', type: 'text' }, OWNER);
    await engine.defineField(from.id, { key: 'points', name: 'Points', type: 'number' }, OWNER);
    await engine.defineField(to.id, { key: 'points', name: 'Points', type: 'number' }, OWNER);
    const moving = await task(from, { title: 'Estimate it', fields: { area: 'ops', points: 3 } });

    const answer = await write<Moved>(target, 'move_tasks', { task: moving.id, project: to.key });

    const newId = answer.moved[moving.id]!;
    expect(answer.fieldsKept).toEqual({ [newId]: ['area'] });
    expect((await stored(to, [newId]))[0]!.fields).toEqual({ area: 'ops', points: 3 });
  });
});

describe('a move and the approvals and retries around it', () => {
  it('takes an open approval along with the task waiting on it, which still waits until it is answered', async () => {
    const [from, to] = [await newProject(engine), await newProject(engine)];
    const moving = await task(from, { title: 'Deploy the API' });
    const asked = await write<{ approval: { id: string } }>(target, 'request_human_approval', {
      task: moving.id,
      reason: 'Approve deploying the API',
    });

    const answer = await write<Moved>(target, 'move_tasks', { task: moving.id, project: to.key });
    const refused = await refusal(target, 'close_task', { task: moving.id, reason: 'Deployed.', link: LINK });

    const gate = answer.moved[asked.approval.id]!;
    expect(gate.startsWith(`${to.prefix}-`)).toBe(true);
    expect(Object.keys(answer.moved).sort()).toEqual([asked.approval.id, moving.id].sort());
    expect((await stored(to, [answer.moved[moving.id]!]))[0]!.dependencies).toMatchObject([
      { taskId: gate, type: 'blocks', status: 'open' },
    ]);
    expect(refused).toContain(gate);
  });

  it('leaves an answered approval where it was', async () => {
    const [from, to] = [await newProject(engine), await newProject(engine)];
    const moving = await task(from, { title: 'Deploy the API' });
    const opened = await engine.writeTask(
      from.id,
      moving.id,
      { expectedVersion: moving.version, requestApproval: { reason: 'Approve deploying the API' } },
      OWNER,
    );
    const [gate] = opened.created;
    await engine.writeTask(
      from.id,
      gate!.id,
      { expectedVersion: gate!.version, close: { reason: 'Approved', resolution: 'done' } },
      OWNER,
    );

    const answer = await write<Moved>(target, 'move_tasks', { task: moving.id, project: to.key });

    expect(Object.keys(answer.moved)).toEqual([moving.id]);
    expect(await stored(from, [gate!.id])).toEqual([expect.objectContaining({ id: gate!.id, status: 'closed' })]);
  });

  it('keeps an approval that another task still waits on where it is, and the moved task still waits on it', async () => {
    const [from, to] = [await newProject(engine), await newProject(engine)];
    const moving = await task(from, { title: 'Deploy the API' });
    const staying = await task(from, { title: 'Deploy the site' });
    const asked = await write<{ approval: { id: string } }>(target, 'request_human_approval', {
      task: moving.id,
      reason: 'Approve deploying both',
    });
    await write(target, 'link_tasks', { task: staying.id, to: asked.approval.id, type: 'blocks' });

    const answer = await write<Moved>(target, 'move_tasks', { task: moving.id, project: to.key });
    const refused = await refusal(target, 'close_task', { task: moving.id, reason: 'Deployed.', link: LINK });

    expect(Object.keys(answer.moved)).toEqual([moving.id]);
    expect(refused).toContain(asked.approval.id);
    expect((await stored(to, [answer.moved[moving.id]!]))[0]).toMatchObject({ status: 'open' });
  });

  it('answers a move repeated with its key once its project no longer takes tasks, without moving again', async () => {
    const [from, to] = [await newProject(engine), await newProject(engine)];
    const moving = await task(from);
    const args = { task: moving.id, project: to.key, idempotency_key: `key-${crypto.randomUUID()}` };
    const first = await write<Moved>(target, 'move_tasks', args);
    await engine.updateProject(to.id, { disabled: true });

    const again = await write<Moved>(target, 'move_tasks', args);

    expect(again).toMatchObject({ moved: first.moved, replayed: true });
  });

  it('answers a move under a parent repeated with its key after the parent moved on with it', async () => {
    const [from, to, later] = [await newProject(engine), await newProject(engine), await newProject(engine)];
    const epic = await task(to, { title: 'Launch', type: 'epic' });
    const moving = await task(from, { title: 'Pick the date' });
    const args = { task: moving.id, parent: epic.id, idempotency_key: `key-${crypto.randomUUID()}` };
    const first = await write<Moved>(target, 'move_tasks', args);
    await write(target, 'move_tasks', { task: epic.id, project: later.key, with_children: true });

    const again = await write<Moved>(target, 'move_tasks', args);

    expect(again).toMatchObject({ moved: first.moved, replayed: true });
  });

  it('leaves out of a repeated move the tasks that moved on to a project its sender cannot reach', async () => {
    const [from, to, hidden] = [await newProject(engine), await newProject(engine), await newProject(engine)];
    const moving = await task(from, { title: 'Draft the contract' });
    const agent = api({ principal: granted({ [from.id]: 'write', [to.id]: 'write' }), engine });
    const args = { task: moving.id, project: to.key, idempotency_key: `key-${crypto.randomUUID()}` };
    const first = await write<Moved>(agent, 'move_tasks', args);
    await write(target, 'move_tasks', { task: first.moved[moving.id]!, project: hidden.key });

    const again = await write<Moved>(agent, 'move_tasks', args);

    expect(again).toMatchObject({ tasks: [], replayed: true });
    expect(JSON.stringify(again)).not.toContain(hidden.prefix);
  });
});

describe('POST /api/tasks/move', () => {
  it('moves the tasks, and the old id’s task routes answer for the moved task in its new project', async () => {
    const [from, to] = [await newProject(engine), await newProject(engine)];
    const moving = await task(from, { title: 'Write the runbook' });
    await engine.addComment(from.id, moving.id, 'Started on the outline.', OWNER);

    const moved = await send(target, 'POST', '/api/tasks/move', { tasks: [moving.id], projectId: to.id });
    const newId = (moved.body.moved as Record<string, string>)[moving.id]!;
    const page = await get(target, `/api/tasks/${moving.id}?project=${from.id}`);
    const history = await get(target, `/api/tasks/${moving.id}/history?project=${from.id}`);
    const edited = await send(target, 'PATCH', `/api/tasks/${moving.id}`, { projectId: from.id, priority: 0 });

    expect(moved).toMatchObject({ status: 200, body: { tasks: [{ id: newId }] } });
    expect(page).toMatchObject({ status: 200, body: { prefix: to.prefix, task: { id: newId } } });
    expect((page.body.comments as { text: string }[]).map((comment) => comment.text)).toEqual([
      'Started on the outline.',
    ]);
    expect(history.status).toBe(200);
    expect(edited.status).toBe(200);
    expect((await stored(to, [newId]))[0]).toMatchObject({ priority: 0 });
  });

  it('answers for a moved task named by its old id and project to a sender who no longer reaches that project', async () => {
    const [from, to] = [await newProject(engine), await newProject(engine)];
    const moving = await task(from, { title: 'Write the runbook' });
    const newId = (await write<Moved>(target, 'move_tasks', { task: moving.id, project: to.key })).moved[moving.id]!;
    const reader = api({ principal: granted({ [to.id]: 'read' }), engine });

    const page = await get(reader, `/api/tasks/${moving.id}?project=${from.id}`);

    expect(page).toMatchObject({ status: 200, body: { task: { id: newId } } });
  });

  it('refuses a task named twice in place of parent, and a missing destination, moving nothing', async () => {
    const [from] = [await newProject(engine)];
    const moving = await task(from);

    const underItself = await send(target, 'POST', '/api/tasks/move', {
      tasks: [moving.id],
      projectId: from.id,
      parent: moving.id,
    });
    const nowhere = await send(target, 'POST', '/api/tasks/move', { tasks: [moving.id] });

    expect(underItself).toMatchObject({ status: 400 });
    expect(nowhere).toMatchObject({ status: 400 });
    expect(await stored(from, [moving.id])).toEqual([expect.objectContaining({ version: moving.version })]);
  });
});
