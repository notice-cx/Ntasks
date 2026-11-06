import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { coveredByPhrase, insideIdentifier, shippedSpans, sourceFiles, withoutComments } from './shipped-copy';

// One word means one thing. The tasks this app shows are filed against the
// owner's assets, and NoticeOS, where the same people read them, calls such a
// thing an asset: never a *site* and never a *property*, which is the
// analytics provider's own object. Carried over from NoticeOS's
// scripts/ui-noun.test.mjs and the site rule in its ui-lexicon.test.mjs.
//
// It reads shipped text only: string and template literals and JSX text.
// Its exemptions are exact phrases, so widening it is a decision someone
// makes on purpose.

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = sourceFiles(APP_ROOT, 'src', new Set());

const NOUNS = [
  { pattern: /propert(?:y|ies)/gi, word: 'asset (a property is the analytics provider\'s own object)' },
  { pattern: /\bsites?\b/gi, word: 'asset' },
] as const;

/** Exact strings that may contain one of these nouns and do not mean an asset, each with its reason. */
const ALLOWED_PHRASES: readonly string[] = [];

function offendersIn(name: string, source: string): string[] {
  const text = withoutComments(source);
  const spans = shippedSpans(text);
  const found: string[] = [];
  for (const { pattern, word } of NOUNS) {
    for (const hit of text.matchAll(pattern)) {
      const at = hit.index;
      if (!spans.some(([start, end]) => at >= start && at < end)) continue;
      if (insideIdentifier(text, at, hit[0].length)) continue;
      // A path or a qualified name: `/sites/…`, `config.sites`.
      const before = at > 0 ? text[at - 1] : '';
      if (before === '/' || before === '.') continue;
      const from = Math.max(0, at - 60);
      const window = text.slice(from, at + 60);
      if (coveredByPhrase(window, from, at, ALLOWED_PHRASES)) continue;
      const line = text.slice(0, at).split('\n').length;
      found.push(`${name}:${line}  "${hit[0]}" → ${word}\n      …${window.replace(/\s+/g, ' ').trim()}…`);
    }
  }
  return found;
}

describe('the UI nouns', () => {
  it('has files to sweep', () => {
    expect(FILES.length).toBeGreaterThan(20);
    expect(FILES).toContain('src/routes/TaskRoute.tsx');
  });

  it('never calls an asset a site or a property in a shipped string', () => {
    const offenders = FILES.flatMap((name) => offendersIn(name, readFileSync(path.join(APP_ROOT, name), 'utf8')));
    expect(
      offenders,
      'these shipped strings use a noun reserved for something else:\n  ' + offenders.join('\n  ') + '\n'
        + 'Write asset. If a string names the provider\'s own property object, a stored value or an address, '
        + 'add that exact phrase to ALLOWED_PHRASES with its reason; never widen a pattern.',
    ).toEqual([]);
  });

  it('has no exemption that matches nothing', () => {
    const corpus = FILES.map((name) => readFileSync(path.join(APP_ROOT, name), 'utf8')).join('\n');
    expect(ALLOWED_PHRASES.filter((phrase) => !corpus.includes(phrase))).toEqual([]);
  });

  // The guard has to be able to fail, and to pass code.
  it('tells copy from code', () => {
    for (const copy of [
      'const a = () => <h1>Sites</h1>;',
      'const a = () => <p>No site matches.</p>;',
      'const a = { label: "All sites" };',
      'const a = { title: "Property settings" };',
    ]) expect(offendersIn('probe.tsx', copy), copy).not.toEqual([]);
    for (const code of [
      'const a = (id: string) => fetch(`/api/sites/${id}`);',
      'const siteName = "x";',
      'const a = { perProperty: 1 };',
      'const a = (c: { sites: string[] }) => c.sites;',
    ]) expect(offendersIn('probe.tsx', code), code).toEqual([]);
  });
});
