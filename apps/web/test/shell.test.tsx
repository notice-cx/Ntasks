import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Shell } from '../src/shell';

function Where() {
  const { pathname, search, hash } = useLocation();
  return <output data-where="">{`${pathname}${search}${hash}`}</output>;
}

/** Where the web app lands after opening `address`. */
function open(address: string) {
  cleanup();
  const view = render(
    <MemoryRouter initialEntries={[address]}>
      <Shell />
      <Where />
    </MemoryRouter>,
  );
  return view.container.querySelector('[data-where]')?.textContent;
}

beforeEach(() => {
  // Nobody is signed in, so the app shows its Sign in step and reads nothing more.
  vi.stubGlobal('fetch', async () => Response.json({ error: 'sign_in_required' }, { status: 401 }));
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the web app', () => {
  it('opens the board at the site root and at any address it does not serve', () => {
    expect(open('/')).toBe('/tasks');
    expect(open('/nowhere')).toBe('/tasks');
  });

  it('opens a page at its old address outside /tasks, keeping the query and the fragment', () => {
    expect(open('/live?stalled=1d#top')).toBe('/tasks/live?stalled=1d#top');
    for (const page of ['projects', 'members', 'settings']) expect(open(`/${page}`)).toBe(`/tasks/${page}`);
  });

  it('signs in with the Worker’s own sign-in page, on its own origin', async () => {
    open('/tasks');
    expect((await screen.findByRole('link', { name: 'Sign in' })).getAttribute('href')).toBe('/sign-in');
  });
});
