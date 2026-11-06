import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveTask } from '@/api/types';
import { createAnswerQueue, UNDO_WINDOW_MS } from '@/lib/answer-queue';
import { boardRows, closeAsReason, closeNote, inboxAsk, inboxOrder, waitsOnPerson } from '@/lib/task-model';
import { MarkdownText, taskListItems, toggleTaskListLine } from '@/routes/tasks/task-markdown';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

function task(fields: Partial<LiveTask>): LiveTask {
  return {
    id: 'web-a1',
    title: 'A task',
    status: 'open',
    priority: 2,
    issueType: 'task',
    assignee: null,
    updatedAt: '2026-11-01T00:00:00Z',
    closedAt: null,
    createdAt: '2026-11-01T00:00:00Z',
    parent: null,
    deferUntil: null,
    description: '',
    acceptance: '',
    labels: [],
    ready: true,
    dependencies: [],
    comments: 0,
    metadata: null,
    startedAt: null,
    closeReason: null,
    awaitType: null,
    ...fields,
  };
}

describe('what waits on a person', () => {
  it('is an open approval, or a ready task labelled human that nobody answered', () => {
    expect(inboxAsk(task({ issueType: 'gate', awaitType: 'human', ready: false }))).toBe('approve');
    expect(inboxAsk(task({ labels: ['human'] }))).toBe('answer');
    expect(
      inboxAsk(
        task({
          labels: ['human'],
          choices: {
            question: 'Which?',
            options: [
              { key: 'a', label: 'A', recommended: true },
              { key: 'b', label: 'B' },
            ],
          },
        }),
      ),
    ).toBe('choose');
    expect(waitsOnPerson(task({ labels: ['human'], ready: false }))).toBe(false);
    expect(waitsOnPerson(task({ labels: ['human'], status: 'deferred' }))).toBe(false);
    expect(
      waitsOnPerson(
        task({ labels: ['human'], choice: { option: 'a', label: 'A', by: 'x', at: '2026-11-01T00:00:00Z' } }),
      ),
    ).toBe(false);
    expect(waitsOnPerson(task({ issueType: 'gate', awaitType: 'timer' }))).toBe(false);
  });

  it('orders an approval by the urgency of the work it holds back', () => {
    const rows = boardRows('web', [
      task({ id: 'web-g1', issueType: 'gate', awaitType: 'human', priority: 3 }),
      task({ id: 'web-q1', labels: ['human'], priority: 1 }),
      task({
        id: 'web-w1',
        priority: 0,
        ready: false,
        dependencies: [{ id: 'web-g1', type: 'blocks', title: null, status: 'open' }],
      }),
    ]);
    const asks = rows.filter((row) => inboxAsk(row) !== null).sort(inboxOrder);
    expect(asks.map((row) => row.id)).toEqual(['web-g1', 'web-q1']);
    expect(asks[0]?.proceeds?.map((row) => row.id)).toEqual(['web-w1']);
  });
});

describe('a close where nothing shipped', () => {
  it("records the person's note, else the resolution's words, and shows only a note", () => {
    expect(closeAsReason({ resolution: 'duplicate', duplicateOf: 'web-b2' })).toBe('Duplicate of web-b2');
    expect(closeAsReason({ resolution: 'wont-do', note: ' Out of scope ' })).toBe('Out of scope');
    expect(closeNote('Duplicate of web-b2', 'duplicate', 'web-b2')).toBeNull();
    expect(closeNote('Dismissed: not needed', 'wont-do', null)).toBe('not needed');
    expect(closeNote('Landed in 1a2b3c4', 'done', null)).toBe('Landed in 1a2b3c4');
  });
});

describe('the Undo window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends after the window, and Undo cancels an answer not yet sent', async () => {
    const queue = createAnswerQueue();
    const sent: string[] = [];
    queue.schedule({
      id: 'web-a1',
      group: 'one',
      send: async () => {
        sent.push('web-a1');
      },
    });
    queue.schedule({
      id: 'web-a2',
      group: 'two',
      send: async () => {
        sent.push('web-a2');
      },
    });
    expect(queue.hides('web-a1', null)).toBe(true);
    expect(queue.undoGroup('two')).toBe(1);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    expect(sent).toEqual(['web-a1']);
    // Hidden until a read taken after the answer.
    expect(queue.hides('web-a1', '2000-01-01T00:00:00Z')).toBe(true);
    expect(queue.hides('web-a1', new Date(Date.now() + 1000).toISOString())).toBe(false);
    expect(queue.hides('web-a2', null)).toBe(false);
  });

  it('sends what is waiting at once when the page is leaving', () => {
    const queue = createAnswerQueue();
    const sent: boolean[] = [];
    queue.schedule({
      id: 'web-a1',
      send: async (keepalive) => {
        sent.push(keepalive);
      },
    });
    queue.flush(true);
    expect(sent).toEqual([true]);
  });
});

describe('task Markdown', () => {
  it('counts and flips a checklist line', () => {
    const text = 'Intro\n- [ ] One\n- [x] Two';
    expect(taskListItems(text)).toEqual({ done: 1, total: 2 });
    expect(toggleTaskListLine(text, 1)).toBe('Intro\n- [x] One\n- [x] Two');
    expect(toggleTaskListLine(text, 0)).toBe(text);
  });

  it('links only safe addresses and draws no raw HTML', () => {
    render(
      <MemoryRouter>
        <MarkdownText source={'[ok](https://example.com) [bad](javascript:alert(1)) <b>raw</b>'} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'ok' }).getAttribute('href')).toBe('https://example.com');
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    expect(screen.getByText(/<b>raw<\/b>/)).toBeTruthy();
  });
});
