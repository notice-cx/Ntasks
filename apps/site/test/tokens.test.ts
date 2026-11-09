import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The site draws in the web app's colours: each token src/tokens.css defines
// has the value apps/web/src/index.css gives it, in each theme.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

function tokens(css: string, selector: RegExp): Map<string, string> {
  const block = selector.exec(css)?.[1] ?? '';
  return new Map(
    [...block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((match) => [
      match[1] ?? '',
      (match[2] ?? '').replace(/\s+/g, ' ').trim(),
    ]),
  );
}

test("the site's tokens have the web app's values in light and dark", () => {
  const site = read('../src/tokens.css');
  const app = read('../../web/src/index.css');
  for (const [name, siteBlock, appBlock] of [
    ['light', /:root\s*\{([^}]*)\}/, /:root,\s*\.light\s*\{([^}]*)\}/],
    ['dark', /\.dark\s*\{([^}]*)\}/, /\.dark\s*\{([^}]*)\}/],
  ] as const) {
    const ours = tokens(site, siteBlock);
    const theirs = tokens(app, appBlock);
    const colours = [...ours].filter(([token]) => !token.startsWith('--font-'));
    assert.ok(colours.length > 10, `${name}: the site defines its colours`);
    for (const [token, value] of colours) {
      assert.equal(value, theirs.get(token), `${name} ${token}`);
    }
  }
});
