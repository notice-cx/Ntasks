/**
 * Whether two actor names name the same sender. Names written by different
 * sign-ins may spell the same agent with `.`, `-` or `_` between words, and
 * `--` where another writes `/`, so they compare as one canonical spelling.
 */
function canonicalActor(name: string): string {
  return name.replace(/[._-]+/gu, (run) => (run === '--' ? '/' : '_'));
}

export function sameActor(a: string, b: string): boolean {
  return a === b || canonicalActor(a) === canonicalActor(b);
}
