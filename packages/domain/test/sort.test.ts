import { describe, expect, it } from 'vitest';
import { taskComparator, type SortFacts } from '../src/index.ts';

function task(id: string, fields: Partial<SortFacts> = {}): SortFacts {
  return {
    id,
    title: id,
    priority: 2,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    closedAt: null,
    ...fields,
  };
}

const order = (tasks: SortFacts[], ...sort: Parameters<typeof taskComparator>) =>
  [...tasks].sort(taskComparator(...sort)).map((entry) => entry.id);

describe('sorting tasks', () => {
  const tasks = [
    task('web-a', { priority: 2, title: 'Rename the tab', createdAt: '2026-11-03T00:00:00.000Z' }),
    task('web-b', { priority: 0, title: 'fix the reset link', createdAt: '2026-11-05T00:00:00.000Z' }),
    task('web-c', {
      priority: 1,
      title: 'Add task 10',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
      closedAt: '2026-11-08T00:00:00.000Z',
    }),
    task('web-d', { priority: 1, title: 'Add task 9', createdAt: '2026-11-02T00:00:00.000Z' }),
  ];

  it('reads priority most urgent first by default, and the least urgent first descending', () => {
    expect(order(tasks, 'priority')).toEqual(['web-b', 'web-c', 'web-d', 'web-a']);
    // A tie keeps the default order, oldest first, whichever way priority reads.
    expect(order(tasks, 'priority', 'desc')).toEqual(['web-a', 'web-c', 'web-d', 'web-b']);
  });

  it('reads dates newest first by default, and oldest first ascending', () => {
    expect(order(tasks, 'created')).toEqual(['web-b', 'web-a', 'web-d', 'web-c']);
    expect(order(tasks, 'created', 'asc')).toEqual(['web-c', 'web-d', 'web-a', 'web-b']);
    expect(order(tasks, 'updated')[0]).toBe('web-c');
  });

  it('puts the tasks without the time a sort reads last, in either direction', () => {
    expect(order(tasks, 'closed')[0]).toBe('web-c');
    expect(order(tasks, 'closed', 'asc')[0]).toBe('web-c');
    // The open ones follow in the default order.
    expect(order(tasks, 'closed').slice(1)).toEqual(['web-b', 'web-d', 'web-a']);
  });

  it('reads titles A to Z ignoring case, with numbers in number order', () => {
    expect(order(tasks, 'title')).toEqual(['web-d', 'web-c', 'web-b', 'web-a']);
    expect(order(tasks, 'title', 'desc')).toEqual(['web-a', 'web-b', 'web-c', 'web-d']);
  });

  it('breaks a full tie by id', () => {
    expect(order([task('web-z'), task('web-y'), task('web-x')], 'updated')).toEqual(['web-x', 'web-y', 'web-z']);
  });
});
