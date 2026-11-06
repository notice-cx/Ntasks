import { describe, expect, it } from 'vitest';
import { GUARD_REFUSALS, guardRefusalOf, TASK_REFUSALS, TaskRefused } from '../src/index.ts';

describe('guardRefusalOf', () => {
  it.each(GUARD_REFUSALS)('reads %s from a D1 error message', (refusal) => {
    expect(guardRefusalOf(`D1_ERROR: ntasks refused: ${refusal}: SQLITE_CONSTRAINT`)).toBe(refusal);
  });

  it('returns null for an error that did not come from the guard', () => {
    expect(guardRefusalOf('D1_ERROR: UNIQUE constraint failed: tasks.id: SQLITE_CONSTRAINT')).toBeNull();
  });

  it('returns null for the guard naming a refusal the contract does not list', () => {
    expect(guardRefusalOf('ntasks refused: unknown guard refusal')).toBeNull();
  });

  it('lists only refusals the contract names', () => {
    for (const refusal of GUARD_REFUSALS) expect(TASK_REFUSALS).toContain(refusal);
  });
});

describe('TaskRefused', () => {
  it('carries the refusal beside its message', () => {
    const error = new TaskRefused('version_conflict', 'The task changed after you read it.');

    expect(error).toBeInstanceOf(Error);
    expect(error.refusal).toBe('version_conflict');
    expect(error.message).toBe('The task changed after you read it.');
  });
});
