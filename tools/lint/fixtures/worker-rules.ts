// Code that breaks CONTRIBUTING.md's rules for Worker code on purpose. The lint
// run skips this directory; test/worker-rules.test.ts lints the file as if it
// were source in a Worker workspace. A line that ends with a rule's name must
// be reported by that rule, and no other line may be reported.

// Request data in a module-level variable.
export let lastUser = ''; // no-restricted-syntax
let counter = 0; // no-restricted-syntax
var legacy = 1; // no-restricted-syntax
export const cache = new Map<string, string>(); // no-restricted-syntax
const seen = new Set<string>(); // no-restricted-syntax
const byUser: Record<string, string> = {}; // no-restricted-syntax
const queue: string[] = []; // no-restricted-syntax
const state = {} as Record<string, string>; // no-restricted-syntax
const pending = [] satisfies string[]; // no-restricted-syntax

// Constants that nothing fills at run time, and variables that live for one call.
const METHODS = new Set(['GET', 'HEAD']);
const NAMES = ['a', 'b'];
const LIMITS = { max: 10 };

export function perRequest(): number {
  let count = 0;
  const visited = new Set<string>();
  for (const name of NAMES) {
    visited.add(name);
    count += METHODS.has(name) ? 1 : LIMITS.max;
  }
  return count + counter + legacy + seen.size + queue.length + pending.length + Object.keys(byUser).length;
}

// Tokens and ids.
export function makeIds(): string[] {
  const guess = Math.random().toString(36); // no-restricted-properties
  const { random } = Math; // no-restricted-properties
  return [guess, String(random()), crypto.randomUUID(), lastUser, Object.keys(cache).join(), Object.keys(state).join()];
}

// Comparing secrets.
declare const token: string;
declare const expected: string;
declare const session: { token: string; signature: string; kind: string; tokenType: string };
declare function timingSafeEqual(a: string, b: string): boolean;

export function compare(): boolean {
  if (token === expected) return true; // no-restricted-syntax
  if (session.signature !== expected) return false; // no-restricted-syntax
  if (expected == session.token) return true; // no-restricted-syntax

  // Not a comparison of a secret with another value.
  if (token === undefined || session.token === null || token === '') return false;
  if (session.kind === 'token' || session.tokenType === 'bearer') return false;
  if (token.length === 0 || typeof token === 'string') return timingSafeEqual(token, expected);
  return false;
}
