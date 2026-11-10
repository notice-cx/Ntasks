/**
 * The package as a host page outside the Ntasks Worker renders it, through
 * its public entry points only: the board under the host's `/tasks` route,
 * and every read sent to the Ntasks the host names, with the person's token.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createFixtureTasksApi } from '../src/fixture';
import { NtasksApp, type TokenSource } from '../src/index';
import { originOf } from '../src/api/connection';
import { appPaths } from '../src/lib/paths';

const NTASKS = 'https://tasks.example.com';
const TOKEN = 'person-token-1';
const TASK = 'Fix the broken reset link in the welcome email';

interface Sent {
  url: string;
  authorization: string | null;
}

/** An Ntasks at `NTASKS` that answers the board's reads from the fixture's invented tasks. */
function ntasks(status = 200) {
  const fixture = createFixtureTasksApi();
  const sent: Sent[] = [];
  const keyOf = async (projectId: string | null) =>
    (await fixture.projects()).find((project) => project.projectId === projectId)?.logicalKey ?? '';
  async function answer(url: URL, headers: Headers): Promise<unknown> {
    fixture.selectWorkspace(headers.get('x-ntasks-workspace'));
    const project = url.searchParams.get('project');
    switch (url.pathname) {
      case '/api/workspaces':
        return { workspaces: await fixture.workspaces() };
      case '/api/access/me':
        return fixture.account();
      case '/api/tasks/capabilities':
        return fixture.capabilities();
      case '/api/tasks/projects':
        return { projects: await fixture.projects() };
      case '/api/tasks':
        return url.searchParams.has('stage')
          ? fixture.delivery(await keyOf(project))
          : fixture.board(await keyOf(project));
      case '/api/changes':
        return fixture.changes(Number(url.searchParams.get('after')));
      default: {
        const id = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname)?.[1];
        return id ? fixture.task(decodeURIComponent(id), await keyOf(project)) : null;
      }
    }
  }
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    sent.push({ url: input, authorization: headers.get('authorization') });
    if (status !== 200) return Response.json({ error: 'sign_in_required', detail: 'Sign in.' }, { status });
    const body = await answer(new URL(input), headers);
    return body === null ? Response.json({ error: 'not_found' }, { status: 404 }) : Response.json(body);
  });
  return sent;
}

const person = (signIn: TokenSource['signIn'] = () => {}): TokenSource => ({ token: () => TOKEN, signIn });

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('a host page', () => {
  it("renders the board in its own router's /tasks route, links a task at /tasks/<id> and reads the Ntasks it names as the person", async () => {
    const sent = ntasks();
    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <Routes>
          <Route path="/tasks/*" element={<NtasksApp apiOrigin={NTASKS} tokenSource={person()} basePath="/tasks" />} />
        </Routes>
      </MemoryRouter>,
    );
    const link = await screen.findByRole('link', { name: TASK });
    expect(link.getAttribute('href')).toBe('/tasks/web-b2r6');
    expect(document.querySelector('[data-ntasks]')?.contains(link)).toBe(true);
    const reads = sent.map((request) => new URL(request.url));
    expect(reads.map((url) => url.pathname)).toEqual(
      expect.arrayContaining(['/api/workspaces', '/api/tasks/projects', '/api/tasks']),
    );
    expect(reads.every((url) => url.origin === NTASKS)).toBe(true);
    expect(sent.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("opens a task on its own page with no router of the host's, on the page's history", async () => {
    ntasks();
    window.history.replaceState(null, '', '/tasks');
    render(<NtasksApp apiOrigin={NTASKS} tokenSource={person()} />);
    fireEvent.click(await screen.findByRole('link', { name: TASK }));
    expect(window.location.pathname).toBe('/tasks/web-b2r6');
    expect(await screen.findByRole('heading', { name: TASK })).toBeTruthy();
  });

  it('keeps its sidebar, with the source-code link, behind the Sidebar button when the host has its own navigation', async () => {
    ntasks();
    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <Routes>
          <Route
            path="/tasks/*"
            element={<NtasksApp apiOrigin={NTASKS} tokenSource={person()} basePath="/tasks" sidebar="sheet" />}
          />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole('link', { name: TASK });
    // The host's page holds the one main landmark.
    expect(screen.queryByRole('main')).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Ntasks' });
    expect(nav.hasAttribute('data-open')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Sidebar' }));
    expect(nav.hasAttribute('data-open')).toBe(true);
    const source = within(nav).getByRole('link', { name: 'Source code' });
    expect(source.getAttribute('href')).toBe('https://github.com/notice-cx/Ntasks');
    fireEvent.click(within(nav).getByRole('link', { name: 'Focus' }));
    expect(nav.hasAttribute('data-open')).toBe(false);
  });

  it("calls the host's sign-in when the Ntasks answers that nobody is signed in", async () => {
    ntasks(401);
    const signIn = vi.fn();
    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <Routes>
          <Route path="/tasks/*" element={<NtasksApp apiOrigin={NTASKS} tokenSource={person(signIn)} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Sign in to see your tasks')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(signIn).toHaveBeenCalledOnce();
  });
});

describe("the app's addresses", () => {
  it('put every page under the base path, however it is written, and never at the site root', () => {
    for (const base of ['/tasks', 'tasks', '/tasks/']) {
      const paths = appPaths(base);
      expect([paths.board, paths.task('web-a1'), paths.focus, paths.settings]).toEqual([
        '/tasks',
        '/tasks/web-a1',
        '/tasks/focus',
        '/tasks/settings',
      ]);
    }
    expect(appPaths('/tasks').isAppPage('/sign-in')).toBe(false);
    for (const root of ['/', '']) expect(() => appPaths(root)).toThrow(/below the root/);
  });
});

describe("the host's apiOrigin", () => {
  it('is read as an origin, and an address that is none is refused by name', () => {
    expect(originOf('https://tasks.example.com/')).toBe('https://tasks.example.com');
    for (const wrong of ['tasks.example.com', 'data:text/plain,x', 'file:///tasks']) {
      expect(() => originOf(wrong), wrong).toThrow(/apiOrigin must be an origin/);
    }
  });
});
