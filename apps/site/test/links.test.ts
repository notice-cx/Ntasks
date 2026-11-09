import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { checkLinks } from '../lib/links.ts';

test('the link check reports each missing page, heading, image and repository file, and nothing else', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ntasks-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const github = 'https://github.com/example/repo';

  write('repo/README.md', '# Repo\n\n## Set up\n\n```sh\n# not a heading\n```\n');
  write('repo/src/index.ts', '');
  write('dist/assets/board.webp', '');
  write('dist/docs/index.html', '<h1 id="docs">Docs</h1>');
  write('dist/docs/agents.html', '<h2 id="the-skill">The skill</h2>');
  write(
    'dist/index.html',
    [
      '<a href="/docs/">ok</a>',
      '<a href="/docs">ok, redirected to /docs/</a>',
      '<a href="/docs/agents#the-skill">ok</a>',
      '<a href="docs/agents">ok, relative</a>',
      '<a href="#top">no such id</a>',
      '<a href="/docs/agents#set-up">no such heading</a>',
      '<a href="/docs/missing">no such page</a>',
      '<img src="/assets/board.webp"><img src="/assets/missing.webp">',
      `<a href="${github}/blob/main/README.md#set-up">ok</a>`,
      `<a href="${github}/tree/main/src/">ok</a>`,
      `<a href="${github}/blob/main/README.md#not-a-heading">no such heading</a>`,
      `<a href="${github}/blob/main/missing.md">no such file</a>`,
      '<a href="https://example.com/elsewhere">not checked</a>',
      '<a href="mailto:someone@example.com">not checked</a>',
    ].join('\n'),
  );

  const dead = checkLinks({
    distDir: join(root, 'dist'),
    repoDir: join(root, 'repo'),
    siteOrigin: 'https://site.example.com',
    repository: github,
    branch: 'main',
  });
  assert.deepEqual(
    dead.map((link) => link.href),
    [
      '#top',
      '/docs/agents#set-up',
      '/docs/missing',
      `${github}/blob/main/README.md#not-a-heading`,
      `${github}/blob/main/missing.md`,
      '/assets/missing.webp',
    ],
  );
});
