// The warnings a write gives for text that cites what its next reader cannot
// check: a path on one machine, or an exact count of tests passed or failed.
// The write lands either way.
import type { TaskEngine } from '@ntasks/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { citationWarnings } from '../../src/mcp/citations.ts';
import { clock, newProject, OWNER } from '../engine/helpers.ts';
import { api, write, WRITER, type TestApi } from './helpers.ts';

const time = clock('2026-11-06T12:00:00.000Z');
let target: TestApi;
let engine: TaskEngine;

beforeAll(() => {
  target = api({ principal: WRITER, now: time.now });
  engine = target.engine;
});

interface Written {
  id: string;
  warnings?: string[];
}

describe('a write citing what its next reader cannot check', () => {
  it('files and changes the task, with a warning naming each field that cites a path on one machine', async () => {
    const project = await newProject(engine);
    const filed = await write<Written>(target, 'create_task', {
      project: project.id,
      title: 'Draw the settings page',
      description: 'The design is in /tmp/x.png.',
    });
    expect(filed.warnings).toHaveLength(1);
    expect(filed.warnings![0]).toContain('/tmp/x.png');
    expect((await engine.getTask(project.id, filed.id))!.description).toBe('The design is in /tmp/x.png.');

    const changed = await write<Written>(target, 'update_task', {
      task: filed.id,
      acceptance: '- [ ] Matches ~/Desktop/settings.png',
    });
    expect(changed.warnings).toHaveLength(1);
    expect(changed.warnings![0]).toContain('acceptance');
    expect((await engine.getTask(project.id, filed.id))!.acceptance).toBe('- [ ] Matches ~/Desktop/settings.png');

    const batch = await write<{ created: Written[]; warnings?: string[] }>(target, 'create_tasks', {
      project: project.id,
      tasks: [
        { title: 'First', description: 'WHERE: workers/api/src/views.ts' },
        { title: 'Second', acceptance: 'Screens in /Users/sam/shots/a.png' },
      ],
    });
    expect(batch.created).toHaveLength(2);
    expect(batch.warnings).toHaveLength(1);
    expect(batch.warnings![0]).toContain('tasks[1].acceptance');
  });

  it('closes the task, with a warning when the reason gives an exact test count', async () => {
    const project = await newProject(engine);
    const { task } = await engine.createTask(project.id, { title: 'Fix the reset link' }, OWNER);
    const closed = await write<Written & { status: string }>(target, 'close_task', {
      task: task.id,
      reason: 'Landed in 4f2a9c1; 123 passed.',
    });
    expect(closed.status).toBe('closed');
    expect(closed.warnings).toHaveLength(1);
    expect(closed.warnings![0]).toContain('reason');
  });

  it('gives no warning for a repository path, a commit, a link or a command', async () => {
    const project = await newProject(engine);
    const filed = await write<Written>(target, 'create_task', {
      project: project.id,
      title: 'Show the estimate on ready rows',
      description: 'WHERE: apps/web/src/routes/tasks/task-row.tsx, https://example.com/home/tmp/plan',
      acceptance: '- [ ] `pnpm test` passes',
    });
    expect(filed).not.toHaveProperty('warnings');
    const closed = await write<Written>(target, 'close_task', {
      task: filed.id,
      reason: 'Landed in 4f2a9c1; pnpm test passes.',
    });
    expect(closed).not.toHaveProperty('warnings');
  });
});

describe('citationWarnings', () => {
  const warned = (text: string) => citationWarnings({ text }, ['text']).length;

  it('names temporary and home folders, and exact test counts', () => {
    for (const text of [
      'at /private/tmp/shots/a.png',
      'at /var/folders/ab/T/a.png',
      'see [the shot](/tmp/s.png)',
      'in /home/sam/notes.md',
      'Tests  40 passed (40)',
      '5 passed, 1 failed in 0.12s',
      'all 1,234 tests passed locally',
    ])
      expect(warned(text), text).toBe(1);
  });

  it('leaves out relative paths, URLs, and counts of something other than tests', () => {
    for (const text of [
      '../tmp/x and src/home/y',
      'https://example.com/tmp/x',
      'GET /users/42',
      'After 3 failed sign-ins the account locks',
      '2 failed in a row',
      'PR 42 passed review',
    ])
      expect(warned(text), text).toBe(0);
  });
});
