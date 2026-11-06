import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import type { LiveTask } from '@/api/types';
import { createAnswerQueue, HIDE_AFTER_SEND_MS, UNDO_WINDOW_MS } from '@/lib/answer-queue';
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

describe('the fixture API', () => {
  it('answers the same write again from its retry key, and refuses the key for a different change', async () => {
    const api = createFixtureTasksApi();
    const first = await api.createTask({ project: 'web', title: 'Once' }, { idempotencyKey: 'key-1' });
    await expect(api.createTask({ project: 'web', title: 'Once' }, { idempotencyKey: 'key-1' })).resolves.toEqual(
      first,
    );
    expect(api.state.tasks.filter((task) => task.title === 'Once')).toHaveLength(1);
    await expect(
      api.createTask({ project: 'web', title: 'Changed' }, { idempotencyKey: 'key-1' }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'idempotency_conflict',
    });
    await expect(api.comment('web-b2r6', 'web', 'Once', { idempotencyKey: 'key-1' })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    await api.comment('web-b2r6', 'web', 'A note', { idempotencyKey: 'key-2' });
    await api.comment('web-b2r6', 'web', 'A note', { idempotencyKey: 'key-2' });
    expect(api.state.comments.get('web-b2r6')).toHaveLength(1);
  });
});

describe('the fixture API retry keys on answers', () => {
  it('applies an answer, a pick and an approval once when they are sent again with their key', async () => {
    const api = createFixtureTasksApi();
    const comments = () => api.state.comments.get('web-q8n5')?.length ?? 0;
    await api.respond('web-q8n5', 'web', 'support@example.com', { idempotencyKey: 'answer-1' });
    await api.respond('web-q8n5', 'web', 'support@example.com', { idempotencyKey: 'answer-1' });
    expect(comments()).toBe(1);
    await api.choose('web-d4x1', 'web', 'a', undefined, { idempotencyKey: 'pick-1' });
    await expect(api.choose('web-d4x1', 'web', 'a', undefined, { idempotencyKey: 'pick-1' })).resolves.toBeUndefined();
    await api.resolveGate('web-g7p2', 'web', undefined, { idempotencyKey: 'approve-1' });
    await expect(
      api.resolveGate('web-g7p2', 'web', undefined, { idempotencyKey: 'approve-1' }),
    ).resolves.toBeUndefined();
    await expect(
      api.respond('web-q8n5', 'web', 'Another answer', { idempotencyKey: 'answer-1' }),
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
  });

  it('applies an update, a close and a decline once per key, and a refused write leaves its key unused', async () => {
    const api = createFixtureTasksApi();
    const task = (id: string) => api.state.tasks.find((entry) => entry.id === id);
    await api.updateTask('web-t5w3', 'web', { claim: true }, { idempotencyKey: 'claim-1' });
    await api.updateTask('web-t5w3', 'web', { claim: true }, { idempotencyKey: 'claim-1' });
    await expect(
      api.updateTask('web-t5w3', 'web', { priority: 0 }, { idempotencyKey: 'claim-1' }),
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    expect(task('web-t5w3')?.priority).toBe(3);

    // Refused for a missing reason, so the key is still free for the corrected close.
    await expect(api.closeTask('web-t5w3', 'web', ' ', { idempotencyKey: 'close-1' })).rejects.toMatchObject({
      code: 'task_refused',
    });
    await api.closeTask('web-t5w3', 'web', 'Renamed in 1a2b3c4', { idempotencyKey: 'close-1' });
    await expect(
      api.closeTask('web-t5w3', 'web', 'Renamed in 1a2b3c4', { idempotencyKey: 'close-1' }),
    ).resolves.toBeUndefined();
    expect(task('web-t5w3')?.closeReason).toBe('Renamed in 1a2b3c4');

    await api.dismiss('docs-r4s9', 'docs', 'Not needed', { idempotencyKey: 'decline-1' });
    await expect(
      api.dismiss('docs-r4s9', 'docs', 'Not needed', { idempotencyKey: 'decline-1' }),
    ).resolves.toBeUndefined();
    await expect(
      api.dismiss('docs-r4s9', 'docs', 'Other reason', { idempotencyKey: 'decline-1' }),
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
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
    expect(queue.hides('web-a2', Date.now())).toBe(false);
    // Hidden while the read on screen was received before the answer went, by this browser's clock.
    const before = Date.now() - 1;
    expect(queue.hides('web-a1', before)).toBe(true);
    expect(queue.hides('web-a1', Date.now() + 1)).toBe(false);
    // Once a later read has shown it, it stays shown.
    expect(queue.hides('web-a1', before)).toBe(false);
  });

  it('stops hiding a sent answer that no later read follows', async () => {
    const queue = createAnswerQueue();
    queue.schedule({ id: 'web-a1', send: async () => {} });
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    const read = Date.now() - 1;
    expect(queue.hides('web-a1', read)).toBe(true);
    await vi.advanceTimersByTimeAsync(HIDE_AFTER_SEND_MS + 1);
    expect(queue.hides('web-a1', read)).toBe(false);
  });

  it('forgets a sent answer when its hiding ends, without being asked about it again', async () => {
    const queue = createAnswerQueue();
    queue.schedule({ id: 'web-a1', send: async () => {} });
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    const read = Date.now() - 1;
    const before = queue.version();
    await vi.advanceTimersByTimeAsync(HIDE_AFTER_SEND_MS + 1);
    // The queue told its readers on its own, with no call for this task in between.
    expect(queue.version()).toBeGreaterThan(before);
    expect(queue.hides('web-a1', read)).toBe(false);
  });

  it('sends what is waiting when the page it is attached to is left, and only while attached', () => {
    const queue = createAnswerQueue();
    const sent: boolean[] = [];
    const detach = queue.attach(window);
    queue.schedule({
      id: 'web-a1',
      send: async (keepalive) => {
        sent.push(keepalive);
      },
    });
    window.dispatchEvent(new Event('pagehide'));
    expect(sent).toEqual([true]);
    detach();
    queue.schedule({
      id: 'web-a2',
      send: async (keepalive) => {
        sent.push(keepalive);
      },
    });
    window.dispatchEvent(new Event('pagehide'));
    expect(sent).toEqual([true]);
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

  it('skips a checkbox inside a code block and keeps the line endings it was given', () => {
    const text = '- [ ] One\r\n```\r\n- [ ] Example\r\n```\r\n- [ ] Two';
    expect(taskListItems(text)).toEqual({ done: 0, total: 2 });
    expect(toggleTaskListLine(text, 2)).toBe(text);
    expect(toggleTaskListLine(text, 4)).toBe('- [ ] One\r\n```\r\n- [ ] Example\r\n```\r\n- [x] Two');
    expect(toggleTaskListLine('- [ ] A\r- [ ] B', 1)).toBe('- [ ] A\r- [x] B');
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
