// Web addresses written out in task text open when pressed: in a title, in
// prose, in code and in a step's command, and only http and https ones.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { createFixtureTasksApi } from '@/api/fixture';
import { webAddresses } from '@/lib/web-links';
import { MarkdownText, TaskPrefixesProvider } from '@/routes/tasks/task-markdown';
import { renderApp } from './render';

function draw(source: string) {
  const view = render(
    <MemoryRouter>
      <TaskPrefixesProvider value={new Set(['web'])}>
        <MarkdownText source={source} />
      </TaskPrefixesProvider>
    </MemoryRouter>,
  );
  return view.container.querySelector('[data-markdown]') as HTMLElement;
}

/** Each link's address and words. */
const links = (root: Element) =>
  [...root.querySelectorAll('a')].map((link) => [link.getAttribute('href'), link.textContent]);

/** Whether a link opens in a new tab with no opener and no referrer. */
function opensApart(link: Element): boolean {
  return link.getAttribute('target') === '_blank' && link.getAttribute('rel') === 'noopener noreferrer';
}

describe('finding web addresses in plain text', () => {
  it('finds http and https addresses, without the punctuation that ends the sentence', () => {
    expect(webAddresses('See https://example.com/a. Then http://example.com/b, and stop.').map((a) => a.href)).toEqual([
      'https://example.com/a',
      'http://example.com/b',
    ]);
    expect(webAddresses('(see https://example.com/wiki/Thing_(word))').map((a) => a.href)).toEqual([
      'https://example.com/wiki/Thing_(word)',
    ]);
    const [found] = webAddresses('Open https://example.com/x now');
    expect(found).toEqual({ start: 5, end: 26, href: 'https://example.com/x' });
  });

  it('finds no other scheme', () => {
    expect(webAddresses('javascript:alert(1) ftp://example.com mailto:someone@example.com data:text/html,hi')).toEqual(
      [],
    );
  });
});

describe('web addresses in task text', () => {
  it('link in a paragraph and open in a new tab', () => {
    const root = draw('Open https://github.com/settings/apps to check.');
    expect(links(root)).toEqual([['https://github.com/settings/apps', 'https://github.com/settings/apps']]);
    expect(opensApart(root.querySelector('a') as Element)).toBe(true);
  });

  it('link in a code block, inline code and a highlighted block, piece by piece where tokens split one', () => {
    const plain = draw('```\nOpen https://github.com/settings/apps\n```');
    const pre = plain.querySelector('pre') as HTMLElement;
    expect(links(pre)).toEqual([['https://github.com/settings/apps', 'https://github.com/settings/apps']]);
    expect(opensApart(pre.querySelector('a') as Element)).toBe(true);

    const inline = draw('Run `curl https://example.com/health` first.');
    expect(links(inline.querySelector('code') as Element)).toEqual([
      ['https://example.com/health', 'https://example.com/health'],
    ]);

    // The highlighter makes $TASK a token of its own inside the address.
    const shell = draw('```bash\ncurl -s https://api.example.com/v1/$TASK\n```');
    const parts = links(shell.querySelector('pre') as Element);
    expect(parts.length).toBeGreaterThan(1);
    expect(new Set(parts.map(([href]) => href))).toEqual(new Set(['https://api.example.com/v1/$TASK']));
    expect(parts.map(([, words]) => words).join('')).toBe('https://api.example.com/v1/$TASK');
  });

  it('leave a javascript: address as text, in code and in prose', () => {
    const root = draw('```\njavascript:alert(1)\n```\n\nThen javascript:alert(2) here.');
    expect(root.querySelectorAll('a')).toHaveLength(0);
    expect(root.textContent).toContain('javascript:alert(1)');
  });

  it('copy a code block as written, its links included', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const source = 'Open https://github.com/settings/apps\nthen https://example.com/next.';
    const root = draw(`\`\`\`\n${source}\n\`\`\``);
    expect(root.querySelectorAll('pre a')).toHaveLength(2);
    fireEvent.click(within(root).getByRole('button', { name: 'Copy the code' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(source));
  });
});

describe('web addresses on a task’s page', () => {
  it('link in its title, and a javascript: address there stays text', async () => {
    const api = createFixtureTasksApi();
    const task = api.state.tasks.find((entry) => entry.id === 'web-t5w3')!;
    task.title = 'Rename the tab as https://example.com/spec shows, not javascript:alert(1)';
    renderApp('/tasks/web-t5w3', api);
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(links(heading)).toEqual([['https://example.com/spec', 'https://example.com/spec']]);
    expect(opensApart(heading.querySelector('a') as Element)).toBe(true);
    expect(heading.textContent).toBe(task.title);
  });

  it("link in a step's command", async () => {
    const api = createFixtureTasksApi();
    Object.assign(
      api.state.tasks.find((entry) => entry.id === 'web-g7p2')!,
      {
        title: 'Install the GitHub app',
        steps: [
          {
            text: 'Open the app settings page.',
            command: 'https://github.com/settings/apps',
            done: null,
            note: null,
            stuck: null,
          },
        ],
      },
    );
    renderApp('/tasks/web-g7p2', api);
    const link = await screen.findByRole('link', { name: 'https://github.com/settings/apps' });
    expect(link.closest('pre')).not.toBeNull();
    expect(opensApart(link)).toBe(true);
  });
});
