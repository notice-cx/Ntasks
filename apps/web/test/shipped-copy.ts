// How the copy guards (ui-lexicon.test.ts, ui-noun.test.ts) read a file: the
// text a person sees, with offsets that still point into the file. Carried
// over from NoticeOS's scripts/test/shipped-copy.mjs.

import { readdirSync } from 'node:fs';
import path from 'node:path';

// Newlines survive the blanking, so the line number in a failure is the line
// in the file.
const blank = (match: string) => match.replace(/[^\n]/g, ' ');

/** Comments only, offsets kept. Block comments (JSX `{/* … *\/}` included) go
 * whole; line comments only when the `//` opens the line, so a `https://…`
 * inside a string survives. */
export function commentsBlanked(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^[ \t]*\/\/.*$/gm, blank);
}

/** Comments are not labels, and neither is a module path. `${…}` is an
 * expression. `from "…"` and `import("…")` are module specifiers. */
export function withoutComments(source: string): string {
  return commentsBlanked(source)
    .replace(/\$\{[^{}]*\}/g, blank)
    .replace(/\bfrom\s+(["'])(?:[^"'\\\n]|\\.)*\1/g, blank)
    .replace(/\bimport\s*\(\s*(["'])(?:[^"'\\\n]|\\.)*\1\s*\)/g, blank);
}

/** Whether the hit at `at` is covered by one of `phrases`, checked against
 * this hit, not "the line mentions it somewhere". `window` is
 * `text.slice(from, …)`, so `from` maps back to file offsets. */
export function coveredByPhrase(window: string, from: number, at: number, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => {
    for (let found = window.indexOf(phrase); found >= 0; found = window.indexOf(phrase, found + 1)) {
      const start = from + found;
      if (start <= at && at < start + phrase.length) return true;
    }
    return false;
  });
}

/** The `.ts` and `.tsx` files under `dir` (relative to `root`), less `skip`. */
export function sourceFiles(root: string, dir: string, skip: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sourceFiles(root, rel, skip));
    else if (/\.tsx?$/.test(entry.name) && !skip.has(rel)) found.push(rel);
  }
  return found;
}

/** The spans of a file that end up in front of a person: string and template
 * literals, plus JSX text nodes. A JSX text node may not contain `=`, so an
 * expression between a `>` and a `<` is not read as a label. */
export function shippedSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const match of text.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)) {
    spans.push([match.index, match.index + match[0].length]);
  }
  for (const match of text.matchAll(/(?<![=\-!<>])>([^<>{}=]*)<(?=[/A-Za-z])/g)) {
    spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}

/** Part of a longer identifier (`beadId`, `siteName`) even inside a literal: still code. */
export function insideIdentifier(text: string, at: number, length: number): boolean {
  const before = at > 0 ? (text[at - 1] ?? '') : '';
  const after = text[at + length] ?? '';
  return /[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after);
}
