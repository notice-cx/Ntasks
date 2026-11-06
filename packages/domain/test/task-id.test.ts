import { describe, expect, it } from 'vitest';
import { isTaskId } from '../src/index.ts';

describe('isTaskId', () => {
  it.each([
    ['a top-level task', 'web-a1b2'],
    ['a numeric key', 'web-697'],
    ['a prefix with digits', 'web2-a1b2'],
    ['a child task', 'web-a1b2.3'],
    ['a grandchild task', 'web-a1b2.289.18'],
  ])('accepts %s: %s', (_case, id) => {
    expect(isTaskId(id)).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['a prefix alone', 'web'],
    ['a missing key', 'web-'],
    ['a missing prefix', '-a1b2'],
    ['a hyphen inside the prefix', 'web-app-a3f8e9'],
    ['two hyphens after the prefix', 'web--a1b2'],
    ['upper case', 'WEB-A1B2'],
    ['the Kelvin sign, which case folding turns into k', 'web-K1b2'],
    ['the long s, which case folding turns into s', 'ſite-a1b2'],
    ['an empty child number', 'web-a1b2.'],
    ['a child that is not a number', 'web-a1b2.x'],
    ['a space', 'web a1b2'],
    ['a trailing newline', 'web-a1b2\n'],
  ])('refuses %s', (_case, id) => {
    expect(isTaskId(id)).toBe(false);
  });

  it.each([[42], [null], [undefined], [{ id: 'web-a1b2' }]])('refuses a value that is not a string: %o', (value) => {
    expect(isTaskId(value)).toBe(false);
  });
});
