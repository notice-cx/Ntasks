import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { enabledButton, renderApp } from './render';

/** The pull request the fixture's approval web-g7p2 gates, and its name. */
const PULL_REQUEST = 'https://github.com/example/web/pull/57';
const PULL_REQUEST_NAME = 'example/web#57';

/** The fixture with web-g7p2 linking no pull request: an approval that gates none. */
function ungated() {
  const api = createFixtureTasksApi();
  api.state.tasks.find((entry) => entry.id === 'web-g7p2')!.externalLinks = [];
  return api;
}

/** The element `selector` finds, once the page draws it. */
async function drawn(selector: string): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = document.querySelector<HTMLElement>(selector);
    expect(found).not.toBeNull();
  });
  return found as unknown as HTMLElement;
}

/** The links inside the elements that describe `control`. */
function describedLinks(control: HTMLElement): HTMLAnchorElement[] {
  return (control.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .flatMap((id) => [...(document.getElementById(id)?.querySelectorAll('a') ?? [])]);
}

const PLACES = [
  { place: 'the task page', path: '/tasks/web-g7p2', scope: () => drawn('[data-task-actions]') },
  { place: 'its row in Waiting for you', path: '/tasks', scope: () => drawn('[data-inbox-row="web-g7p2"]') },
  { place: 'focus', path: '/tasks/focus', scope: () => drawn('[data-focus-decision="web-g7p2"]') },
];

describe.each(PLACES)('Approve on $place', ({ path, scope }) => {
  it('is described by the pull request whose auto-merge it turns on, linked to GitHub in a new tab', async () => {
    renderApp(path);
    const approve = await enabledButton('Approve', await scope());
    const links = describedLinks(approve);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([PULL_REQUEST]);
    expect(links[0]?.target).toBe('_blank');
    expect(links[0]?.textContent).toBe(PULL_REQUEST_NAME);
  });

  it('names no pull request on an approval that gates none', async () => {
    renderApp(path, ungated());
    const approve = await enabledButton('Approve', await scope());
    expect(describedLinks(approve)).toEqual([]);
    expect(screen.queryByRole('link', { name: PULL_REQUEST_NAME })).toBeNull();
  });
});
