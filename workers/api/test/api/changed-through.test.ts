// What a coordinator reads back about the helper agents working under it:
// list_tasks finds the tasks a writer, a helper or a session changed, from
// each change in their history, and a comment or a close carries the test run
// that shows the work.
import type { Project, TaskEngine } from '@ntasks/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { SCOPES, type Principal } from '../../src/auth.ts';
import { clock, newProject, OWNER } from '../engine/helpers.ts';
import { api, read, refusal, write, WRITER, type TestApi } from './helpers.ts';

const time = clock('2026-11-06T12:00:00.000Z');
/** Another agent, which holds none of the coordinator's tasks. */
const OTHER: Principal = Object.freeze({
  id: 'principal-other',
  name: 'agent-o',
  scopes: [SCOPES.read, SCOPES.write],
  projects: 'all',
});
let coordinator: TestApi;
let other: TestApi;
let engine: TaskEngine;
let project: Project;

beforeAll(async () => {
  coordinator = api({ principal: WRITER, now: time.now });
  engine = coordinator.engine;
  other = api({ principal: OTHER, now: time.now, engine });
  project = await newProject(engine);
});

async function file(title: string): Promise<string> {
  return (await engine.createTask(project.id, { title }, OWNER)).task.id;
}

interface Change {
  readonly actor: string;
  readonly actions: readonly string[];
  readonly for?: string;
  readonly session?: string;
}

describe('list_tasks by who changed a task', () => {
  const ids: Record<string, string> = {};
  const listed = async (args: Record<string, unknown>) =>
    (await read<{ tasks: { id: string }[] }>(coordinator, 'list_tasks', { project: project.id, ...args })).tasks
      .map((task) => task.id)
      .sort();
  const sorted = (...names: string[]) => names.map((name) => ids[name]).sort();

  beforeAll(async () => {
    for (const name of ['page', 'form', 'footer', 'notes']) ids[name] = await file(`Rebuild the ${name}`);
    // The first helper claims the page, then comments without naming itself again.
    await write(coordinator, 'claim_task', { task: ids.page, for: 'rebuild-1', session: 'session-a' });
    await write(coordinator, 'comment_on_task', { task: ids.page, text: 'Half done.' });
    // The second helper closes the form, which clears the task's helper and session.
    await write(coordinator, 'claim_task', { task: ids.form, for: 'rebuild-2', session: 'session-b' });
    await write(coordinator, 'close_task', { task: ids.form, reason: 'Rebuilt.', commit: 'abc1234' });
    // The coordinator holds the footer itself; another agent comments on the page and changes the notes.
    await write(coordinator, 'claim_task', { task: ids.footer });
    await write(other, 'comment_on_task', { task: ids.page, text: 'Looks right.' });
    await write(other, 'update_task', { task: ids.notes, priority: 1 });
  });

  it('lists exactly the tasks a helper changed', async () => {
    expect(await listed({ changed_for: 'rebuild-1' })).toEqual(sorted('page'));
    expect(await listed({ changed_for: 'rebuild-2' })).toEqual(sorted('form'));
    expect(await listed({ changed_for: 'rebuild-3' })).toEqual([]);
  });

  it('lists exactly the tasks changed in a session', async () => {
    expect(await listed({ changed_in: 'session-a' })).toEqual(sorted('page'));
    expect(await listed({ changed_in: 'session-b' })).toEqual(sorted('form'));
  });

  it('lists exactly the tasks a writer changed, "me" for the caller', async () => {
    expect(await listed({ changed_by: 'me' })).toEqual(sorted('page', 'form', 'footer'));
    expect(await listed({ changed_by: OTHER.name })).toEqual(sorted('page', 'notes'));
  });

  it("names the helper and session in each change the holder made, and in no one else's", async () => {
    const history = async (task: string) =>
      (await read<{ changes: Change[] }>(coordinator, 'get_task_history', { task })).changes;
    const page = await history(ids.page!);
    expect(page.map(({ actor, actions, for: helper, session }) => ({ actor, actions, helper, session }))).toEqual([
      { actor: OTHER.name, actions: ['commented'], helper: undefined, session: undefined },
      { actor: WRITER.name, actions: ['commented'], helper: 'rebuild-1', session: 'session-a' },
      { actor: WRITER.name, actions: ['claimed'], helper: 'rebuild-1', session: 'session-a' },
      { actor: OWNER.name, actions: ['created'], helper: undefined, session: undefined },
    ]);
    const [closed] = await history(ids.form!);
    expect(closed).toMatchObject({ actor: WRITER.name, for: 'rebuild-2', session: 'session-b' });
  });
});

describe('a test run on a comment or a close', () => {
  it('keeps the run a comment reports, beside its words', async () => {
    const id = await file('Check the links');
    const run = { command: 'pnpm test', result: 'failed', passed: 21, failed: 1, commit: 'abc1234' };
    await write(coordinator, 'comment_on_task', { task: id, text: 'One link fails.', test: run });
    time.advance(1);
    await write(coordinator, 'comment_on_task', { task: id, text: 'Fixing it.' });

    const answer = await read<{ comments: Record<string, unknown>[] }>(coordinator, 'get_task', { task: id });
    expect(answer.comments.map(({ text, test }) => ({ text, test }))).toEqual([
      { text: 'One link fails.', test: run },
      { text: 'Fixing it.', test: null },
    ]);
  });

  it('keeps the run a close reports, until the task opens again', async () => {
    const id = await file('Fix the broken link');
    const run = { command: 'pnpm test', result: 'passed', passed: 22, failed: 0 };
    await write(coordinator, 'claim_task', { task: id });
    await write(coordinator, 'close_task', { task: id, reason: 'Fixed.', commit: 'abc1234', test: run });
    const closed = await read<{ task: Record<string, unknown> }>(coordinator, 'get_task', { task: id });
    expect(closed.task.closeTest).toEqual(run);

    await write(coordinator, 'update_task', { task: id, status: 'open' });
    const reopened = await read<{ task: Record<string, unknown> }>(coordinator, 'get_task', { task: id });
    expect(reopened.task.closeTest).toBeNull();
  });

  it('refuses a run with no command, another result or a count that is not a whole number', async () => {
    const id = await file('Check the forms');
    const comment = (test: Record<string, unknown>) =>
      refusal(coordinator, 'comment_on_task', { task: id, text: 'Ran it.', test });
    expect(await comment({ result: 'passed' })).toMatch(/test\.command/u);
    expect(await comment({ command: 'pnpm test', result: 'skipped' })).toMatch(/test\.result/u);
    expect(await comment({ command: 'pnpm test', result: 'passed', passed: 1.5 })).toMatch(/test\.passed/u);
    expect((await read<{ comments: unknown[] }>(coordinator, 'get_task', { task: id })).comments).toEqual([]);
  });
});
