import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { docsSidebar, pageSummary, readIndex, UNLISTED_GROUP } from '../lib/docs-index.ts';

test('the sidebar lists the pages docs/index.md lists, in its order, and then any page it does not', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ntasks-site-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'index.md'),
    [
      '# Docs',
      '',
      '## Start here',
      '',
      '- [Why](why.md): the problems.',
      '- [Concepts](concepts.md): projects, tasks',
      '  and claims.',
      '',
      '## Reference',
      '',
      '- [The API](api.md): the routes.',
    ].join('\n'),
  );
  for (const [file, title] of [
    ['why.md', 'Why'],
    ['concepts.md', 'Concepts'],
    ['api.md', 'The API'],
    ['zebra.md', 'Zebra'],
    ['new-page.md', 'A new page'],
  ]) {
    writeFileSync(join(dir, file ?? ''), `# ${title}\n\nText.\n`);
  }

  assert.deepEqual(docsSidebar(dir), [
    {
      text: 'Start here',
      items: [
        { text: 'Why', link: '/why' },
        { text: 'Concepts', link: '/concepts' },
      ],
    },
    { text: 'Reference', items: [{ text: 'The API', link: '/api' }] },
    {
      text: UNLISTED_GROUP,
      items: [
        { text: 'A new page', link: '/new-page' },
        { text: 'Zebra', link: '/zebra' },
      ],
    },
  ]);
  assert.equal(
    readIndex(`## A\n\n- [Concepts](concepts.md): projects, tasks\n  and claims.\n`)[0]?.files[0]?.description,
    'projects, tasks and claims.',
  );
});

test("a page's description is its first paragraph as plain text, with names such as AUTH_SECRET intact", () => {
  assert.equal(
    pageSummary(
      '# Deploy\n\nSet `AUTH_SECRET`, then call **get_task_guide** _first_ ([guide](guide.md)).\n\n## Next\n',
    ),
    'Set AUTH_SECRET, then call get_task_guide first (guide).',
  );
});
