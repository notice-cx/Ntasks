/**
 * Appendix A stays true: every Ntasks test it names still exists under that
 * name, and every rule the protocol defines appears in it, with a test or as
 * a gap. A renamed test or a new rule fails here instead of leaving the
 * appendix stale.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SPEC = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY = join(SPEC, '..');
const read = (name: string): string => readFileSync(join(SPEC, name), 'utf8');

const appendix = read('tests.md');
const [proved = '', gaps = ''] = appendix.split('## Rules with no test');

/** Each "| RULE | `file` › "test name" |" row of the first table. */
const citations = [...proved.matchAll(/^\| ([A-Z]+-\d+) \| `([^`]+)` › "([^"]+)" \|$/gmu)].map((match) => ({
  rule: match[1]!,
  file: match[2]!,
  name: match[3]!,
}));

/** Every rule a part of the protocol defines, as `**ID.**` or `**ID. Title.**`. */
const defined = [
  ...new Set(
    ['protocol.md', 'mcp-profile.md', 'http-binding.md'].flatMap((file) =>
      [...read(file).matchAll(/\*\*([A-Z]+-\d+)\./gu)].map((match) => match[1]!),
    ),
  ),
];

describe('the test appendix', () => {
  it('cites tests', () => {
    expect(citations.length).toBeGreaterThan(0);
  });

  it.each(citations)('names a test that exists: $rule, $name', ({ file, name }) => {
    const path = join(REPOSITORY, file);
    expect(existsSync(path), `${file} exists`).toBe(true);
    const source = readFileSync(path, 'utf8');
    const quoted = [`'${name}'`, `"${name}"`, `\`${name}\``];
    expect(
      quoted.some((form) => source.includes(form)),
      `${file} has a test named ${name}`,
    ).toBe(true);
  });

  it('lists every rule the protocol defines, with a test or as a gap', () => {
    const listed = new Set([...citations.map((citation) => citation.rule), ...gaps.match(/[A-Z]+-\d+/gu)!]);
    expect(defined.length).toBeGreaterThan(0);
    expect(defined.filter((rule) => !listed.has(rule))).toEqual([]);
  });

  it('cites only rules the protocol defines', () => {
    const known = new Set(defined);
    expect(citations.map((citation) => citation.rule).filter((rule) => !known.has(rule))).toEqual([]);
  });
});
