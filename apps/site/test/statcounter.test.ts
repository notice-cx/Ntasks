import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { SITE_ORIGIN } from '../lib/site.ts';
import { onNewPage, statcounterHtml } from '../lib/statcounter.ts';

/** Runs the counter's inline script at `hostname`, and returns the scripts it added and the globals it set. */
function runCounter(hostname: string) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(statcounterHtml)?.[1] ?? '';
  const added: { src?: string; async?: boolean }[] = [];
  const context: Record<string, unknown> = {
    location: { hostname },
    document: { createElement: () => ({}), head: { appendChild: (node: { src?: string }) => added.push(node) } },
  };
  runInNewContext(script, context);
  return { added, project: context.sc_project, security: context.sc_security };
}

test("the counter loads at the site's own address, with the project it counts for", () => {
  const { added, project, security } = runCounter(new URL(SITE_ORIGIN).hostname);
  assert.deepEqual(added, [{ async: true, src: 'https://www.statcounter.com/counter/counter.js' }]);
  assert.equal(typeof project, 'number');
  assert.equal(typeof security, 'string');
});

test('a local build or preview counts no visit', () => {
  for (const hostname of ['localhost', '127.0.0.1', 'ntasks-site.example.workers.dev']) {
    const { added, project } = runCounter(hostname);
    assert.deepEqual(added, [], hostname);
    assert.equal(project, undefined, hostname);
  }
});

test('the docs count each page they open in place, once', () => {
  let views = 0;
  const opened = onNewPage('/docs/', () => views++);
  opened('/docs/'); // the router's first load: the counter counted it
  assert.equal(views, 0);
  opened('/docs/agents');
  opened('/docs/agents'); // a jump to a heading on the same page
  assert.equal(views, 1);
  opened('/docs/');
  assert.equal(views, 2);
});
