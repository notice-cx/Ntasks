import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { coveredByPhrase, insideIdentifier, shippedSpans, sourceFiles, withoutComments } from './shipped-copy';

// The app speaks plain English. Read a screen aloud to someone who has never
// seen this repository: any word you would have to stop and define fails.
// These words survive in the task model, the docs and the command-line tools
// this app replaces, so they come back one string at a time; this is what
// fails when one does. Carried over from NoticeOS's scripts/ui-lexicon.test.mjs,
// with its word list and its rules for a labelled command.
//
// It reads shipped text only: string and template literals and JSX text.
// Not comments, identifiers or module paths. Its exemptions are exact
// phrases, so widening the guard is a decision someone makes on purpose.
//
// NoticeOS's rule for its money and portfolio pages, which keeps operational
// words off them, has nothing to guard here: every page of this app is about
// tasks.

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Files whose strings are not copy anyone reads. Empty: every source file is swept. */
const NOT_COPY = new Set<string>();

/** Each banned coinage, with the word to write instead. */
const BANNED = [
  { pattern: /\bbeads?\b/gi, word: 'task' },
  { pattern: /\bbd\b/g, word: 'a labelled command: `bd` inside <code> or backticks' },
  { pattern: /\bspokes?\b/gi, word: 'project' },
  // The compound is the coinage; a bare "hub" may be someone's own word.
  { pattern: /\btask[- ]hubs?\b|\bthe hubs?\b/gi, word: 'Tasks, or the task list' },
  { pattern: /\blanes?\b/gi, word: 'say which: the API, a data source or a scheduled job' },
  { pattern: /\bpulses?\b/gi, word: 'nightly report' },
  { pattern: /\basset #0\b/gi, word: 'the System' },
  { pattern: /\bpollers?\b/gi, word: 'the server' },
  { pattern: /\bknobs?\b/gi, word: 'setting' },
  { pattern: /\b(?:the|a|this) registers?\b/gi, word: 'the catalog' },
  { pattern: /\btiles?\b/gi, word: 'widget' },
  { pattern: /\bObserve only\b/gi, word: 'Monitor only' },
  { pattern: /\bAutomation on\b/gi, word: 'Automation enabled' },
] as const;

/** Exact strings that may contain a banned word, each with its reason. */
const ALLOWED_PHRASES: readonly string[] = [];

/**
 * Whether the hit at `at` sits in a labelled command, the one place `bd`
 * stays: a `<code>` element, or an inline backtick pair inside a sentence.
 * A backtick that opens a template literal follows JS syntax, not a word,
 * so it is not inline markup.
 */
function insideLabelledCommand(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 160), at);
  if (/<code\b[^<>]*>\s*$/.test(before)) return true;
  const tick = /^([\s\S]*)`[^`\n]*$/.exec(before);
  if (!tick) return false;
  const lead = (tick[1] ?? '').replace(/\s+$/, '').slice(-1);
  return lead !== '' && !/[=(:,+[{;]/.test(lead);
}

const FILES = sourceFiles(APP_ROOT, 'src', NOT_COPY);

function offendersIn(name: string, source: string): string[] {
  const text = withoutComments(source);
  const spans = shippedSpans(text);
  const found: string[] = [];
  for (const { pattern, word } of BANNED) {
    for (const hit of text.matchAll(pattern)) {
      const at = hit.index;
      if (!spans.some(([start, end]) => at >= start && at < end)) continue;
      if (insideIdentifier(text, at, hit[0].length)) continue;
      if (word.startsWith('a labelled command') && insideLabelledCommand(text, at)) continue;
      const from = Math.max(0, at - 70);
      const window = text.slice(from, at + 70);
      if (coveredByPhrase(window, from, at, ALLOWED_PHRASES)) continue;
      const line = text.slice(0, at).split('\n').length;
      found.push(`${name}:${line}  "${hit[0]}" → ${word}\n      …${window.replace(/\s+/g, ' ').trim()}…`);
    }
  }
  return found;
}

describe('the UI lexicon', () => {
  // A guard that scans nothing passes forever.
  it('has files to sweep', () => {
    expect(FILES.length).toBeGreaterThan(20);
    for (const name of [
      'src/App.tsx',
      'src/routes/TasksBoard.tsx',
      'src/routes/TaskRoute.tsx',
      'src/routes/FocusRoute.tsx',
      'src/components/TaskComposer.tsx',
    ]) {
      expect(FILES, `${name} must be in the scan`).toContain(name);
    }
  });

  it('finds no internal coinage in a shipped string', () => {
    const offenders = FILES.flatMap((name) => offendersIn(name, readFileSync(path.join(APP_ROOT, name), 'utf8')));
    expect(
      offenders,
      'these shipped strings still use internal vocabulary:\n  ' +
        offenders.join('\n  ') +
        '\n' +
        'Replace it with the word given, or add the exact phrase to ALLOWED_PHRASES with its reason; never widen a pattern. ' +
        'A `bd` command stays as it is when it is visibly a command: inside a <code> element, or in backticks inside a sentence.',
    ).toEqual([]);
  });

  // An allowlist nobody prunes stops being a decision and becomes a habit.
  it('has no exemption that matches nothing', () => {
    const corpus = FILES.map((name) => readFileSync(path.join(APP_ROOT, name), 'utf8')).join('\n');
    expect(ALLOWED_PHRASES.filter((phrase) => !corpus.includes(phrase))).toEqual([]);
  });

  // The guard has to be able to fail, or a broken reader would pass a page full of coinages.
  it('catches a coinage and spares a labelled command', () => {
    expect(offendersIn('probe.tsx', 'const a = <p>Filed as bead in the project its prefix names.</p>;')).toHaveLength(
      1,
    );
    expect(offendersIn('probe.tsx', 'const a = { label: "Open the task hub" };')).toHaveLength(1);
    expect(offendersIn('probe.tsx', 'const beadId = 1; // a bead in a comment')).toEqual([]);
    expect(offendersIn('probe.tsx', 'const a = <code className="font-mono">bd ready</code>;')).toEqual([]);
    expect(offendersIn('probe.tsx', 'const a = "this runtime has no `bd` command to talk to it";')).toEqual([]);
    const propArg = 'const init = ready ? null : `bd init --server`;';
    expect(insideLabelledCommand(propArg, propArg.indexOf('bd init'))).toBe(false);
  });
});
