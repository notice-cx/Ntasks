import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createMarkdownRenderer } from 'vitepress';
import { docsMarkdownOptions } from '../lib/markdown.ts';
import { inlineMark } from '../lib/mark.ts';

// The docs' Markdown through VitePress's own renderer, with the site's options.
const docsDir = fileURLToPath(new URL('../../../docs/', import.meta.url));
const md = await createMarkdownRenderer(docsDir, docsMarkdownOptions, '/docs/');
const render = (source: string, page = 'agents.md') => md.render(source, { relativePath: page, cleanUrls: true });

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);

test('a link that leaves docs/ opens the file or folder on GitHub; a link between pages stays on the site', () => {
  const html = render(
    '[a](../SECURITY.md) [b](../skills/ntasks/) [c](../tools/migrate/README.md#back-up-and-restore) [d](sign-in.md#settings) [e](#steps)',
  );
  assert.deepEqual(hrefs(html), [
    'https://github.com/notice-cx/Ntasks/blob/main/SECURITY.md',
    'https://github.com/notice-cx/Ntasks/tree/main/skills/ntasks',
    'https://github.com/notice-cx/Ntasks/blob/main/tools/migrate/README.md#back-up-and-restore',
    './sign-in#settings',
    '#steps',
  ]);
});

test('a link to a page of spec/ opens that page on the site, and to any other file of it on GitHub', () => {
  const html = render(
    '[a](../spec/protocol.md#inv-1) [b](../spec/README.md) [c](../spec/schemas/)',
    'shared-work-protocol.md',
  );
  assert.deepEqual(hrefs(html), [
    'https://ntasks.notice.cx/spec/protocol#inv-1',
    'https://ntasks.notice.cx/spec/',
    'https://github.com/notice-cx/Ntasks/tree/main/spec/schemas',
  ]);
});

test("a heading's id is the one GitHub gives it, so links written for GitHub reach it", () => {
  const html = render(
    '## "Done" that isn\'t done\n\n## Changing `AUTH_SECRET`\n\n## Agents · and people\n\n## Agents · and people',
  );
  const ids = [...html.matchAll(/<h2 id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, ['done-that-isnt-done', 'changing-auth_secret', 'agents--and-people', 'agents--and-people-1']);
});

test("a picture with a dark source becomes one image for each of the site's themes", () => {
  const html = render(
    [
      '<picture>',
      '  <source media="(prefers-color-scheme: dark)" srcset="images/board-dark.webp">',
      '  <img src="images/board-light.webp" width="800" alt="The board">',
      '</picture>',
    ].join('\n'),
    'web-app.md',
  );
  assert.doesNotMatch(html, /<picture|prefers-color-scheme/);
  const images = [...html.matchAll(/<img [^>]*>/g)].map((match) => match[0]);
  assert.equal(images.length, 2);
  assert.match(images[0] ?? '', /class="only-light".*src="\.\/images\/board-light\.webp"/);
  assert.match(images[1] ?? '', /class="only-dark".*src="\.\/images\/board-dark\.webp"/);
  for (const image of images) assert.match(image, /alt="The board"/);
});

test('an image in raw HTML gets a path the build bundles', () => {
  const html = render('<img src="images/how-ntasks-works.svg"\n  alt="Diagram">', 'architecture.md');
  assert.match(html, /src="\.\/images\/how-ntasks-works\.svg"/);
});

test('a mermaid block becomes a diagram that carries its source', () => {
  const source = 'flowchart LR\n  A["web-1<br/>closed"] --> B\n';
  const html = render(`\`\`\`mermaid\n${source}\`\`\``, 'concepts.md');
  const code = /<MermaidDiagram code="([^"]+)" \/>/.exec(html)?.[1];
  assert.equal(decodeURIComponent(code ?? ''), source);
});

test('the inlined mark keeps no <style>, which would recolour every path on the page', () => {
  const svg = '<svg viewBox="0 0 1 1"><style>path{fill:#000}</style><path d="M0 0H1"/></svg>';
  const mark = inlineMark(svg, 'mark');
  assert.doesNotMatch(mark, /<style/);
  assert.match(mark, /^<svg class="mark" fill="currentColor"/);
});
