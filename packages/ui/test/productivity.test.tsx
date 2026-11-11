import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { fixtureSeed } from '@/api/fixture-data';
import type { Win, WinsPage } from '@/api/types';
import { dayLabel, weekdayDay } from '@/lib/dates';
import { firstShipped, winsByDay, winsDayRule } from '@/lib/wins';
// The Worker's own payload, so this test fails when the page's types and the server's answer drift apart.
import type { WinsPayload } from '../../../workers/api/src/wins.ts';
import { renderApp } from './render';
import { sourceFiles, withoutComments } from './shipped-copy';

const DAY = 24 * 3_600_000;

describe('the words and days of the wins', () => {
  it('names days in words', () => {
    expect(dayLabel('2026-11-10')).toBe('Tue, Nov 10');
    expect(weekdayDay('2026-11-10')).toBe('Tue 10');
    expect(winsDayRule({ shipped: 42, decided: 10, finished: 1 })).toBe('42 shipped, 10 decided, 1 epic finished');
    expect(winsDayRule({ shipped: 0, decided: 0, finished: 2 })).toBe('2 epics finished');
  });

  it("groups wins by their day in the viewer's time zone, newest first", () => {
    const win = (id: string, at: string): Win => ({
      kind: 'finished',
      at,
      projectId: 'p',
      id,
      title: id,
      done: 1,
    });
    const wins = [
      win('a', '2026-11-09T23:59:00.000Z'),
      win('b', '2026-11-10T00:01:00.000Z'),
      win('c', '2026-11-09T08:00:00.000Z'),
    ];
    const days = winsByDay(wins, 'UTC');
    expect(days.map(({ day, wins }) => [day, wins.map((entry) => (entry.kind === 'shipped' ? '' : entry.id))])).toEqual(
      [
        ['2026-11-10', ['b']],
        ['2026-11-09', ['a', 'c']],
      ],
    );
    // In Los Angeles all three fall on 9 Nov: 8 am UTC is midnight there, and the other two are evening.
    expect(winsByDay(wins, 'America/Los_Angeles').map(({ day, wins: list }) => [day, list.length])).toEqual([
      ['2026-11-09', 3],
    ]);
  });

  it('says from which day merges are recorded only when none shipped before the days read', () => {
    const page = (shippedBefore: boolean, shipped: number[]): WinsPage => ({
      readAt: '2026-11-10T00:20:00.000Z',
      from: '2026-11-04T00:00:00.000Z',
      to: '2026-11-11T00:00:00.000Z',
      earlier: '2026-11-04',
      projects: 1,
      shippedBefore,
      totals: { shipped: 0, decided: 0, finished: 0, approved: 0 },
      days: shipped.map((count, i) => ({
        day: `2026-11-${String(4 + i).padStart(2, '0')}`,
        shipped: count,
        decided: 0,
        finished: 0,
      })),
      wins: [],
    });
    expect(firstShipped([page(false, [0, 0, 0, 0, 0, 3, 1])])).toBe('2026-11-09');
    expect(firstShipped([page(true, [0, 0, 0, 0, 0, 3, 1])])).toBeNull();
    expect(firstShipped([page(false, [0, 0, 0, 0, 0, 0, 0])])).toBeNull();
  });

  it('reads the answer the Worker sends', () => {
    // Fails to compile when a field the page reads leaves the Worker's payload or changes type.
    const read = (payload: WinsPayload): WinsPage => payload;
    expect(read).toBeTypeOf('function');
  });
});

describe('the Productivity page', () => {
  it('shows the days, then each win under its day: changes shipped and answers given, and no task closed', async () => {
    const api = createFixtureTasksApi();
    await api.choose('web-d4x1', 'web', 'a');
    renderApp('/tasks/productivity', api);

    const strip = await screen.findByRole('list', { name: 'Wins by day' });
    expect(within(strip).getAllByRole('listitem')).toHaveLength(7);
    const summary = document.querySelector('[data-wins-summary]') as HTMLElement;
    expect(summary.textContent).toContain('2 shipped');
    expect(summary.textContent).toContain('1 decided');
    expect(summary.textContent).toContain('0 epics finished');
    expect(summary.textContent).toContain('and 1 approval');
    // The fixture's merges are its first, so the page says from when they are recorded.
    expect(document.querySelector('[data-wins-note]')?.textContent).toMatch(
      /^Merges are recorded from \w{3}, \w{3} \d+\./,
    );

    const kinds = [...document.querySelectorAll('[data-wins-row]')].map((row) => row.getAttribute('data-wins-row'));
    expect(kinds).toEqual(['decided', 'shipped', 'shipped']);
    const decided = document.querySelector('[data-wins-row="decided"]') as HTMLElement;
    expect(decided.textContent).toContain('Choose the sign-in methods the page offers');
    expect(decided.textContent).toContain('Chose Email link only');
    const [live, merged] = [...document.querySelectorAll('[data-wins-row="shipped"]')] as HTMLElement[];
    expect(live!.textContent).toContain('Show the password rules under the field');
    expect(within(live!).getByRole('link', { name: '#39' }).getAttribute('href')).toBe(
      'https://github.com/example/web/pull/39',
    );
    expect(live!.textContent).toContain('Live');
    expect(merged!.textContent).toContain('9f8e7d6');
    expect(merged!.textContent).toContain('Merged');
    // A close with nothing shipped, and a close as no longer needed, are not wins.
    expect(screen.queryByText('Update the screenshots in the setup guide')).toBeNull();
    expect(screen.queryByText('Remove the old landing page')).toBeNull();

    expect(document.title).toBe('Productivity — Ntasks');
    const nav = screen.getByRole('link', { name: 'Productivity' });
    expect(nav.getAttribute('href')).toBe('/tasks/productivity');
  });

  it('draws a finished epic apart, folds a busy day after eight wins, and reads the days before', async () => {
    const seed = fixtureSeed(Date.now());
    const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
    for (let n = 1; n <= 10; n++) {
      seed.tasks.push({
        ...seed.tasks[0]!,
        id: `web-e${n}`,
        title: `Finished epic ${n}`,
        issueType: 'epic',
        status: 'closed',
        resolution: 'done',
        closedAt: at,
        updatedAt: at,
      });
    }
    seed.tasks.push({
      ...seed.tasks[0]!,
      id: 'web-e1.1',
      title: 'Its task',
      issueType: 'task',
      parent: 'web-e1',
      status: 'closed',
      resolution: 'done',
      closedAt: at,
    });
    renderApp('/tasks/productivity', createFixtureTasksApi({ seed }), undefined, 'UTC');

    const today = new Date(Date.now() - 2 * 3_600_000).toISOString().slice(0, 10);
    const group = await screen.findByRole('region', { name: dayLabel(today) });
    const finished = () => group.querySelectorAll('[data-wins-row="finished"]').length;
    expect(finished()).toBe(8);
    expect(group.textContent).toContain('10 epics finished');
    fireEvent.click(within(group).getByRole('button', { name: 'Show 2 more' }));
    expect(finished()).toBe(10);
    const first = [...group.querySelectorAll('[data-wins-row="finished"]')].find((row) =>
      row.textContent?.includes('Finished epic 1 '),
    );
    expect(first?.textContent ?? group.textContent).toContain('1 task done');

    fireEvent.click(screen.getByRole('button', { name: 'Show the 7 days before' }));
    expect(await screen.findByText(/^No wins from /)).not.toBeNull();
  });

  it('reads one project when one is chosen, and reaches back eight weeks', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/productivity?project=docs', api, undefined, 'UTC');
    await screen.findByRole('list', { name: 'Wins by day' });
    expect(screen.getByRole('button', { name: /Example docs/ })).not.toBeNull();
    await waitFor(() => expect(document.title).toBe('Productivity · Example docs — Ntasks'));
    expect([...document.querySelectorAll('[data-wins-row]')].map((row) => row.textContent)).toEqual([
      expect.stringContaining('Fix the broken links in the README'),
    ]);
    for (let read = 1; read < 8; read++) {
      fireEvent.click(await screen.findByRole('button', { name: 'Show the 7 days before' }));
      await waitFor(() => expect(screen.getAllByText(/^No wins from /)).toHaveLength(read));
    }
    expect(await screen.findByText('The feed reaches back 8 weeks.')).not.toBeNull();
    // The oldest read starts 55 days before today.
    const oldest = Date.now() - 55 * DAY;
    expect(screen.getAllByText(/^No wins from /).at(-1)?.textContent).toContain(
      dayLabel(new Date(oldest).toISOString().slice(0, 10)),
    );
  });
});

describe("the viewer's time zone", () => {
  // 8 pm on 9 Nov in Los Angeles, already 10 Nov in UTC; the answer came at 6 pm there.
  const NOW = Date.parse('2026-11-10T04:00:00.000Z');
  function answered() {
    const seed = fixtureSeed(NOW);
    const decision = seed.tasks.find((task) => task.id === 'web-d4x1')!;
    decision.choice = { option: 'a', label: 'Email link only', by: 'Example Owner', at: '2026-11-10T02:00:00.000Z' };
    return createFixtureTasksApi({ now: () => NOW, seed });
  }
  const groupOf = (row: Element | null) => row?.closest('section')?.getAttribute('aria-label');

  it('puts a 6 pm win in Los Angeles under that day, today there', async () => {
    renderApp('/tasks/productivity', answered(), undefined, 'America/Los_Angeles');
    const strip = await screen.findByRole('list', { name: 'Wins by day' });
    expect(within(strip).getAllByRole('listitem').at(-1)?.getAttribute('data-wins-day')).toBe('2026-11-09');
    expect(groupOf(document.querySelector('[data-wins-row="decided"]'))).toBe('Mon, Nov 9');
  });

  it('regroups the feed in another time zone', async () => {
    renderApp('/tasks/productivity', answered(), undefined, 'UTC');
    await screen.findByRole('list', { name: 'Wins by day' });
    expect(groupOf(document.querySelector('[data-wins-row="decided"]'))).toBe('Tue, Nov 10');
  });

  it('regroups the feed when the person chooses a time zone in Settings, and saves it with their account', async () => {
    const api = answered();
    renderApp('/tasks/settings/you', api);
    const pick = async (zone: string) => {
      const select = (await screen.findByLabelText('Time zone')) as HTMLSelectElement;
      await waitFor(() => expect(select.disabled).toBe(false));
      fireEvent.change(select, { target: { value: zone } });
      await waitFor(async () => expect((await api.account()).timeZone).toBe(zone));
    };
    const decidedDay = async () => {
      fireEvent.click(screen.getByRole('link', { name: 'Productivity' }));
      await screen.findByRole('list', { name: 'Wins by day' });
      await waitFor(() => expect(document.querySelector('[data-wins-row="decided"]')).not.toBeNull());
      return groupOf(document.querySelector('[data-wins-row="decided"]'));
    };
    await pick('America/Los_Angeles');
    expect(await decidedDay()).toBe('Mon, Nov 9');
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('link', { name: 'You' }));
    await pick('UTC');
    await waitFor(async () => expect(await decidedDay()).toBe('Tue, Nov 10'));
    // Two pages and a list of every time zone, rendered twice.
  }, 20_000);

  it('every date the pages show goes through lib/dates.ts', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    // Days and their words come from lib/dates.ts; the fixture's invented data may build its own dates.
    const skip = new Set(['src/lib/dates.ts', 'src/api/fixture.ts', 'src/api/fixture-data.ts']);
    const forbidden = [
      /Intl\.DateTimeFormat\(/u,
      /toISOString\(\)\.slice\(0, 10\)/u,
      /\.get(?:FullYear|Month|Date|Day|Hours)\(\)/u,
      /\.setDate\(/u,
      /toLocale(?:Date|Time)?String\(/u,
    ];
    const found = sourceFiles(root, 'src', skip).flatMap((file) => {
      const text = withoutComments(readFileSync(path.join(root, file), 'utf8'));
      return forbidden.filter((pattern) => pattern.test(text)).map((pattern) => `${file}: ${pattern.source}`);
    });
    expect(found).toEqual([]);
  });
});
