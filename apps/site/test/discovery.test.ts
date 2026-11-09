import assert from 'node:assert/strict';
import { test } from 'node:test';
import { docsSchema, jsonLd, llmsText } from '../lib/discovery.ts';
import { DOCS_BASE, SITE_ORIGIN } from '../lib/site.ts';

test('a documentation title cannot close its JSON-LD script', () => {
  const title = '</script><script>alert("example")</script>';
  const [, , content] = jsonLd({ name: title });
  assert.ok(content);
  assert.equal(content.includes('<'), false);
  assert.deepEqual(JSON.parse(content), { name: title });
});

test('docs breadcrumbs identify the canonical page without repeating the docs index', () => {
  for (const path of ['', 'agents']) {
    const url = `${SITE_ORIGIN}${DOCS_BASE}${path}`;
    const [, , content] = docsSchema('Connect an agent', 'Agent setup.', url);
    const data = JSON.parse(content ?? '');
    assert.equal(data.url, url);
    assert.equal(data.breadcrumb.itemListElement.length, path ? 3 : 2);
    assert.equal(data.breadcrumb.itemListElement.at(-1).item, url);
  }
});

test('the machine-readable directory follows documentation index edits', () => {
  const text = llmsText('# Docs\n\n## Start here\n\n- [A new page](new-page.md): Its current description.\n');
  assert.ok(text.includes(`- [A new page](${SITE_ORIGIN}${DOCS_BASE}new-page): Its current description.`));
  assert.ok(text.includes('## Start here'));
});
