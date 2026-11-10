import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TasksApi } from '@/api/client';
import { createFixtureTasksApi } from '@/api/fixture';
import { fixtureSeed } from '@/api/fixture-data';
import type { BurndownDay, BurndownPage } from '@/api/types';
import { dayCounts, isRecorded, niceCeil, openChange, weekTicks } from '@/lib/burndown';
import { dayLabel } from '@/lib/dates';
// The Worker's own payload, so this test fails when the page's types and the server's answer drift apart.
import type { BurndownPayload } from '../../../workers/api/src/burndown.ts';
import { renderApp } from './render';

const day = (date: string, open: number | null, created = 0, done = 0, closedNotDone = 0): BurndownDay =>
  open === null
    ? { day: date, open: null, created: null, done: null, closedNotDone: null }
    : { day: date, open, created, done, closedNotDone };

describe('the scale and words of the burn-down', () => {
  it('rounds a scale up to a whole 1, 2, 3, 4, 5, 6 or 8 times a power of ten', () => {
    expect([0, 1, 7, 9, 13, 26, 52, 312, 1_450].map(niceCeil)).toEqual([1, 1, 8, 10, 20, 30, 60, 400, 2_000]);
  });

  it('names each week back from the last day, and the change since the first recorded day', () => {
    const days = Array.from({ length: 56 }, (_, i) => day(`d${i}`, i < 10 ? null : 60 - i));
    expect(weekTicks(days)).toEqual([6, 13, 20, 27, 34, 41, 48, 55]);
    expect(openChange(days)).toEqual({ since: 'd10', change: -45 });
    expect(openChange([day('a', null), day('b', 3)])).toBeNull();
    expect(dayCounts({ day: 'a', open: 312, created: 14, done: 20, closedNotDone: 0 })).toBe(
      '312 open, 14 created, 20 done',
    );
    expect(dayCounts({ day: 'a', open: 1_204, created: 1, done: 0, closedNotDone: 2 })).toBe(
      '1,204 open, 1 created, 0 done, 2 closed, not done',
    );
  });

  it("reads the Worker's payload", () => {
    // Fails to compile when a field the page reads leaves the Worker's payload or changes type.
    const read = (payload: BurndownPayload): BurndownPage => payload;
    expect(read).toBeTypeOf('function');
  });
});

/** The rows of the chart's table, as their cells' text. */
function tableRows(section: HTMLElement): string[][] {
  const table = within(section).getByRole('table', { name: 'Open tasks by day, last 8 weeks' });
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent ?? ''));
}

const readout = (section: HTMLElement) => section.querySelector('[data-burndown-readout]')?.textContent;

describe('the burn-down on the Productivity page', () => {
  it('shows every day of the eight weeks, today first in words, and a day pointed at or stepped to', async () => {
    const api = createFixtureTasksApi();
    const page = await api.burndown({ timeZone: 'UTC' });
    renderApp('/tasks/productivity', api, undefined, 'UTC');

    const section = await screen.findByRole('region', { name: 'Open tasks' });
    const today = page.days.at(-1)!;
    expect(isRecorded(today)).toBe(true);
    const summary = section.querySelector('[data-burndown-summary]')?.textContent ?? '';
    expect(summary).toContain(`${today.open} open`);
    const change = openChange(page.days)!;
    expect(summary).toContain(`${Math.abs(change.change)} ${change.change < 0 ? 'fewer' : 'more'} than on`);
    expect(tableRows(section)).toEqual(
      page.days.map((entry) =>
        isRecorded(entry)
          ? [dayLabel(entry.day), ...[entry.open, entry.created, entry.done, entry.closedNotDone].map(String)]
          : [dayLabel(entry.day), 'Not recorded'],
      ),
    );
    // The invented history reaches past the eight weeks, so every day is recorded.
    expect(section.querySelector('[data-burndown-gap]')).toBeNull();

    const plot = within(section).getByRole('group', { name: 'Open tasks' });
    const said = (index: number) => {
      const entry = page.days[index]!;
      return `${dayLabel(entry.day)}: ${isRecorded(entry) ? dayCounts(entry) : 'Not recorded'}`;
    };
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(readout(section)).toBe(said(54));
    fireEvent.keyDown(plot, { key: 'Home' });
    expect(readout(section)).toBe(said(0));
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(readout(section)).toBe(said(0));
    fireEvent.keyDown(plot, { key: 'End' });
    expect(readout(section)).toBe(said(55));
    fireEvent.blur(plot);
    expect(readout(section)).toBe(`Today: ${today.created} created, ${today.done} done`);

    // A pointer finds the day under it: the plot is 560 px wide, so each day is 10 px.
    plot.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 0, width: 560, height: 200 });
    fireEvent.pointerMove(plot, { clientX: 100 + 10 * 20 + 4 });
    expect(readout(section)).toBe(said(20));
    fireEvent.pointerLeave(plot);
    expect(readout(section)).toContain('Today: ');
  });

  it('shows the days before a project was first recorded as not recorded, never as zero', async () => {
    const api = createFixtureTasksApi();
    const page = await api.burndown({ project: 'docs', timeZone: 'UTC' });
    const first = page.days.findIndex(isRecorded);
    // The docs project's invented history starts three weeks ago.
    expect(first).toBeGreaterThan(8);
    renderApp('/tasks/productivity?project=docs', api, undefined, 'UTC');

    const section = await screen.findByRole('region', { name: 'Open tasks' });
    const rows = tableRows(section);
    expect(rows.slice(0, first).every((cells) => cells.length === 2 && cells[1] === 'Not recorded')).toBe(true);
    expect(rows[first]).toHaveLength(5);
    const gap = section.querySelector('[data-burndown-gap]');
    expect(gap?.getAttribute('data-burndown-gap')).toBe(String(first));
    expect(gap?.textContent).toBe('Not recorded');
    fireEvent.keyDown(within(section).getByRole('group', { name: 'Open tasks' }), { key: 'Home' });
    expect(readout(section)).toBe(`${dayLabel(page.days[0]!.day)}: Not recorded`);
  });

  it('says so when a project holds no tasks', async () => {
    const seed = fixtureSeed(Date.now());
    seed.projects.push({
      projectId: 'p-empty',
      logicalKey: 'empty',
      displayName: 'Example empty',
      prefix: 'empty',
      deploys: false,
    });
    seed.fields.set('empty', []);
    renderApp('/tasks/productivity?project=empty', createFixtureTasksApi({ seed }), undefined, 'UTC');

    const section = await screen.findByRole('region', { name: 'Open tasks' });
    expect(section.querySelector('[data-burndown-empty]')).not.toBeNull();
    expect(within(section).queryByRole('table')).toBeNull();
    expect(within(section).queryByRole('group')).toBeNull();
  });

  it('holds its place while it loads, keeps the wins when it fails, and loads again on Retry', async () => {
    const fixture = createFixtureTasksApi();
    let refuse: (error: Error) => void = () => undefined;
    let answer: () => Promise<BurndownPage> = () =>
      new Promise((_, reject) => {
        refuse = reject;
      });
    const api: TasksApi = { ...fixture, burndown: () => answer() };
    renderApp('/tasks/productivity', api, undefined, 'UTC');

    await screen.findByRole('list', { name: 'Wins by day' });
    const place = document.querySelector('[data-burndown-section]') as HTMLElement;
    expect(within(place).getByRole('status').textContent).toBe('Loading…');
    expect(screen.queryByRole('region', { name: 'Open tasks' })).toBeNull();

    refuse(new Error('The task store did not answer.'));
    const failed = await within(place).findByRole('alert');
    expect(failed.textContent).toContain('The task store did not answer.');
    expect(screen.getByRole('list', { name: 'Wins by day' })).not.toBeNull();

    answer = () => fixture.burndown({ timeZone: 'UTC' });
    fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Open tasks' })).not.toBeNull();
  });

  it('follows the project menu', async () => {
    const api = createFixtureTasksApi();
    renderApp('/tasks/productivity', api, undefined, 'UTC');
    const every = await screen.findByRole('region', { name: 'Open tasks' });
    expect(every.querySelector('[data-burndown-gap]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /All projects/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Example docs' }));
    await waitFor(() => expect(document.querySelector('[data-burndown-gap]')).not.toBeNull());
    const docs = await api.burndown({ project: 'docs', timeZone: 'UTC' });
    const section = screen.getByRole('region', { name: 'Open tasks' });
    expect(section.querySelector('[data-burndown-summary]')?.textContent).toContain(`${docs.days.at(-1)!.open} open`);
  });
});
