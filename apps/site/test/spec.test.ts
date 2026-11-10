import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createMarkdownRenderer } from 'vitepress';
import { specMarkdownOptions } from '../lib/spec.ts';

// The spec's Markdown through VitePress's own renderer, with the site's
// options. VitePress keeps one renderer a process, so the docs' links into
// spec/ are tested in markdown.test.ts.
const specDir = fileURLToPath(new URL('../../../spec/', import.meta.url));
const spec = await createMarkdownRenderer(specDir, specMarkdownOptions, '/spec/');
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);

test('a link in spec/ opens a schema at its $id, a page on the site, and any other file on GitHub', () => {
  const html = spec.render(
    [
      '[a](schemas/task.schema.json)',
      '[b](mcp-profile.md#mcp-1)',
      '[c](conformance/README.md)',
      '[d](examples/)',
      '[e](conformance/ntasks/local.ts)',
      '[f](../packages/github-adapter/README.md#run-it)',
    ].join(' '),
    { relativePath: 'protocol.md', cleanUrls: true },
  );
  assert.deepEqual(hrefs(html), [
    'https://ntasks.notice.cx/spec/v0/schemas/task.schema.json',
    './mcp-profile#mcp-1',
    './conformance/',
    'https://github.com/notice-cx/Ntasks/tree/main/spec/examples',
    'https://github.com/notice-cx/Ntasks/blob/main/spec/conformance/ntasks/local.ts',
    'https://github.com/notice-cx/Ntasks/blob/main/packages/github-adapter/README.md#run-it',
  ]);
});
