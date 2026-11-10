import { describe, expect, it } from 'vitest';
import { overlappingTouches } from '../src/touches.ts';

describe('overlappingTouches', () => {
  it('meets the same path, written with or without ./ and a trailing slash', () => {
    expect(overlappingTouches(['./scripts/bundle-baseline.json'], ['scripts/bundle-baseline.json'])).toEqual([
      'scripts/bundle-baseline.json',
    ]);
    expect(overlappingTouches(['docs/'], ['docs'])).toEqual(['docs']);
  });

  it('meets a folder and a path inside it, either way round', () => {
    const migrations = 'workers/api/src/store/migrations';
    const file = `${migrations}/0006_merge_order.sql`;
    expect(overlappingTouches([migrations], [file])).toEqual([file]);
    expect(overlappingTouches([file], [migrations])).toEqual([migrations]);
  });

  it('keeps apart paths that only start alike, and letters of another case', () => {
    expect(overlappingTouches(['src/header'], ['src/header.tsx', 'src/headers/a.ts', 'SRC/header'])).toEqual([]);
  });
});
