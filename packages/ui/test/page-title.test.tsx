// Each page's browser tab title: the most specific part first, cut to about
// 60 characters, ending in Ntasks; and a host that receives it instead.
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtureTasksApi } from '../src/fixture';
import { NtasksApp } from '../src/index';
import { pageTitle, TITLE_LENGTH, TITLE_SUFFIX } from '../src/lib/page-title';
import { renderApp } from './render';

beforeEach(() => {
  document.title = 'Ntasks';
});

const titled = (expected: string | RegExp) =>
  waitFor(() =>
    typeof expected === 'string' ? expect(document.title).toBe(expected) : expect(document.title).toMatch(expected),
  );

describe('a page title', () => {
  it('leads with the most specific part and ends in Ntasks', () => {
    expect(pageTitle('Settings')).toBe('Settings — Ntasks');
    expect(pageTitle('Epics (4)', 'Example web app')).toBe('Epics (4) · Example web app — Ntasks');
    // Parts with no words are left out.
    expect(pageTitle('web-b2r6', null, undefined, '')).toBe('web-b2r6 — Ntasks');
  });

  it('cuts what follows the lead to fit, and never the lead', () => {
    const cut = pageTitle('web-b2r6', 'Fix the reset link in the welcome email and in every password email we send');
    expect(cut.startsWith('web-b2r6 · Fix the reset link')).toBe(true);
    expect(cut.endsWith(`…${TITLE_SUFFIX}`)).toBe(true);
    expect(cut.length - TITLE_SUFFIX.length).toBeLessThanOrEqual(TITLE_LENGTH);
    const id = `web-${'x'.repeat(70)}`;
    expect(pageTitle(id, 'Anything')).toBe(`${id}${TITLE_SUFFIX}`);
  });
});

describe('the pages’ titles', () => {
  it('lead with the task’s id on its page, then its title, cut when long', async () => {
    const view = renderApp('/tasks/web-b2r6');
    await titled('web-b2r6 · Fix the broken reset link in the welcome email — Ntasks');
    view.unmount();

    const api = createFixtureTasksApi();
    api.state.tasks.find((entry) => entry.id === 'web-t5w3')!.title =
      'Rename the Settings tab to Account on every page, in every email and in the help pages';
    renderApp('/tasks/web-t5w3', api);
    await titled(/^web-t5w3 · Rename the Settings tab to Account.*… — Ntasks$/);
    expect(document.title.length - TITLE_SUFFIX.length).toBeLessThanOrEqual(TITLE_LENGTH);
  });

  it('name a project’s view with its count, then the project', async () => {
    renderApp('/tasks?project=web&view=waiting');
    await titled(/^Waiting for you \(\d+\) · Example web app — Ntasks$/);
    const region = await screen.findByRole('region', { name: 'Waiting for you' });
    const shown = await waitFor(() => {
      const rows = region.querySelectorAll('[data-inbox-row]').length;
      expect(rows).toBeGreaterThan(0);
      return rows;
    });
    expect(document.title).toBe(`Waiting for you (${shown}) · Example web app — Ntasks`);
  });

  it('name Live with the tasks in progress, and Settings', async () => {
    const view = renderApp('/tasks/live');
    // web-k3m9.2, docs-n6j1 and web-w6n2 are in progress.
    await titled('Live (3) — Ntasks');
    view.unmount();
    renderApp('/tasks/settings');
    await titled('Settings — Ntasks');
  });

  it('go to a host that asks for them, which keeps its own document title', async () => {
    document.title = 'Example Tower';
    const onTitle = vi.fn();
    render(
      <MemoryRouter initialEntries={['/tasks/settings']}>
        <Routes>
          <Route path="/tasks/*" element={<NtasksApp api={createFixtureTasksApi()} onTitle={onTitle} />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(onTitle).toHaveBeenLastCalledWith('Settings — Ntasks'));
    expect(document.title).toBe('Example Tower');
  });
});
