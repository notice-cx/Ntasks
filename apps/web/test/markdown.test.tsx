import { fireEvent, render, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownText, TaskPrefixesProvider, taskListItems, toggleTaskListLine } from '@/routes/tasks/task-markdown';

function draw(source: string, props: Partial<Parameters<typeof MarkdownText>[0]> = {}) {
  const view = render(
    <MemoryRouter>
      <TaskPrefixesProvider value={new Set(['web'])}>
        <MarkdownText source={source} {...props} />
      </TaskPrefixesProvider>
    </MemoryRouter>,
  );
  return view.container.querySelector('[data-markdown]') as HTMLElement;
}

/** Every attribute any element in `root` carries, as `tag attribute=value`. */
function attributes(root: HTMLElement): string[] {
  return [...root.querySelectorAll('*')].flatMap((element) =>
    [...element.attributes].map((attribute) => `${element.tagName.toLowerCase()} ${attribute.name}=${attribute.value}`),
  );
}

describe('task text as Markdown', () => {
  it('draws headings, lists, quotes, tables, code and line breaks', () => {
    const root = draw(
      [
        '# Plan',
        '',
        'First line',
        'second line, **bold**, _leaning_ and ~~struck~~',
        '',
        '- one',
        '  - nested',
        '1. first',
        '',
        '> quoted',
        '',
        '| Field | Value |',
        '| :-- | --: |',
        '| status | open |',
        '',
        '```ts',
        'const answer: number = 42;',
        '```',
      ].join('\n'),
    );
    // A Markdown heading sits under the page's own headings.
    expect(within(root).getByRole('heading', { level: 3, name: 'Plan' })).toBeTruthy();
    expect(root.querySelector('p br')).not.toBeNull();
    expect(root.querySelector('strong')?.textContent).toBe('bold');
    expect(root.querySelector('em')?.textContent).toBe('leaning');
    expect(root.querySelector('del')?.textContent).toBe('struck');
    expect(within(root).getAllByRole('list')).toHaveLength(3);
    expect(root.querySelector('blockquote')?.textContent).toContain('quoted');
    const table = within(root).getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Field' })).toBeTruthy();
    expect(within(table).getByRole('cell', { name: 'open' }).style.textAlign).toBe('right');
    const code = root.querySelector('pre code') as HTMLElement;
    expect(code.textContent).toBe('const answer: number = 42;\n');
    expect(code.querySelector('.hljs-keyword')?.textContent).toBe('const');
  });

  it('draws a block in a language it does not highlight as plain code', () => {
    const root = draw('```cobol\nDISPLAY "HI".\n```');
    expect(root.querySelector('pre code')?.textContent).toBe('DISPLAY "HI".\n');
  });

  it('opens a link to another site in a new tab, with no opener and no referrer', () => {
    const root = draw(
      '[docs](https://example.com/docs) and https://example.com/bare and [mail](mailto:owner@example.com)',
    );
    const docs = within(root).getByRole('link', { name: 'docs' });
    expect(docs.getAttribute('href')).toBe('https://example.com/docs');
    expect(docs.getAttribute('target')).toBe('_blank');
    expect(docs.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(root).getByRole('link', { name: 'https://example.com/bare' }).getAttribute('target')).toBe('_blank');
    const mail = within(root).getByRole('link', { name: 'mail' });
    expect(mail.getAttribute('href')).toBe('mailto:owner@example.com');
    expect(mail.getAttribute('target')).toBeNull();
  });

  it("links a known project's task ids to their pages, but not inside code", () => {
    const root = draw('Blocked by web-a1b2 and docs-x1. Run `web-a1b2` again.');
    expect(within(root).getByRole('link', { name: 'web-a1b2' }).getAttribute('href')).toBe('/tasks/web-a1b2');
    expect(within(root).queryByRole('link', { name: 'docs-x1' })).toBeNull();
    expect(root.querySelector('code')?.textContent).toBe('web-a1b2');
    expect(root.querySelector('code a')).toBeNull();
  });

  it("leads each of the task guide's labelled lines with its label", () => {
    const root = draw('WHAT: Fix the link\nWHY: It sends people nowhere');
    expect([...root.querySelectorAll('[data-label]')].map((label) => label.textContent)).toEqual(['what', 'why']);
    expect(root.textContent).toContain('Fix the link');
  });
});

describe('task text written to attack the page', () => {
  it('drops an injected script and any raw HTML', () => {
    const root = draw(
      [
        'Before',
        '',
        '<script>window.injected = true</script>',
        '',
        'Inline <b>bold</b> and <iframe src="https://example.com"></iframe>',
        '',
        '<div style="position:fixed;inset:0">cover</div>',
      ].join('\n'),
    );
    expect(root.querySelector('script, iframe, b, div[style]')).toBeNull();
    expect(root.textContent).toContain('Before');
    expect(root.textContent).not.toContain('injected');
    expect(root.textContent).not.toContain('<b>');
    expect((window as { injected?: boolean }).injected).toBeUndefined();
  });

  it("drops a script written inside a sentence, with its words, and keeps the sentence's", () => {
    const root = draw(
      'Run <script>window.injected = true</script> now, then <style>body{display:none}</style>read on.',
    );
    expect(root.textContent).toBe('Run  now, then read on.');
  });

  it('carries no event handler and no inline style from the text', () => {
    const root = draw(
      [
        '<img src="x" onerror="window.injected = true">',
        '',
        '<a href="https://example.com" onclick="window.injected = true">click</a>',
        '',
        '[styled](https://example.com "title" onmouseover="window.injected = true")',
        '',
        '| a |',
        '| -- |',
        '| <span style="color:red">red</span> |',
      ].join('\n'),
    );
    const found = attributes(root);
    expect(found.filter((attribute) => / on[a-z]+=/i.test(attribute))).toEqual([]);
    expect(found.filter((attribute) => / style=/.test(attribute))).toEqual([]);
    expect(root.querySelector('img')).toBeNull();
    expect((window as { injected?: boolean }).injected).toBeUndefined();
  });

  it('links no javascript:, data: or vbscript: address, however it is spelled', () => {
    const root = draw(
      [
        '[plain](javascript:window.injected=true)',
        '[cased](JaVaScRiPt:window.injected=true)',
        '[encoded](&#106;avascript:window.injected=true)',
        '[spaced]( javascript:window.injected=true)',
        '[data](data:text/html;base64,PHNjcmlwdD4=)',
        '[vb](vbscript:msgbox)',
        '<javascript:window.injected=true>',
        '[ref]',
        '',
        '[ref]: javascript:window.injected=true',
      ].join('\n'),
    );
    for (const link of root.querySelectorAll('a')) {
      expect(link.getAttribute('href') ?? '').toMatch(/^(?:https?:|mailto:|\/)/);
    }
    for (const words of ['plain', 'cased', 'encoded', 'data', 'vb', 'ref']) {
      expect(within(root).queryByRole('link', { name: words })).toBeNull();
    }
    expect(root.textContent).toContain('plain');
  });

  it('loads no image from another site, and links to it instead', () => {
    const root = draw('![build status](https://images.example.com/pixel.png) ![diagram](/files/diagram.png)');
    const images = [...root.querySelectorAll('img')];
    expect(images.map((image) => new URL(image.src).pathname)).toEqual(['/files/diagram.png']);
    expect(images[0]?.getAttribute('alt')).toBe('diagram');
    const offSite = within(root).getByRole('link', { name: 'build status' });
    expect(offSite.getAttribute('href')).toBe('https://images.example.com/pixel.png');
    expect(offSite.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('task-list checkboxes', () => {
  it('counts the boxes the page draws, in lists, numbered lists and quotes', () => {
    const text = 'Intro\n- [ ] One\n1. [x] Two\n> - [ ] Three\n```\n- [ ] Example\n```';
    expect(taskListItems(text)).toEqual({ done: 1, total: 3 });
    expect(toggleTaskListLine(text, 3)).toBe('Intro\n- [ ] One\n1. [x] Two\n> - [x] Three\n```\n- [ ] Example\n```');
    expect(toggleTaskListLine(text, 2)).toBe('Intro\n- [ ] One\n1. [ ] Two\n> - [ ] Three\n```\n- [ ] Example\n```');
    expect(toggleTaskListLine(text, 5)).toBe(text);
  });

  it('names each box by its words and hands back the line a pressed box sits on', () => {
    const onToggleTask = vi.fn();
    const root = draw('- [ ] Ship it\n  - [x] Write the tests\n- plain item', { onToggleTask });
    const nested = within(root).getByRole('checkbox', { name: 'Write the tests' });
    expect(nested.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(nested);
    expect(onToggleTask).toHaveBeenCalledWith(1);
    fireEvent.click(within(root).getByRole('checkbox', { name: 'Ship it' }));
    expect(onToggleTask).toHaveBeenLastCalledWith(0);
    expect(within(root).getAllByRole('checkbox')).toHaveLength(2);
  });

  it('draws boxes that cannot be pressed when nothing may tick them', () => {
    const root = draw('- [x] Done already');
    const box = within(root).getByRole('checkbox', { name: 'Done already' });
    expect(box.tagName).toBe('SPAN');
    expect(box.getAttribute('aria-disabled')).toBe('true');
  });
});
