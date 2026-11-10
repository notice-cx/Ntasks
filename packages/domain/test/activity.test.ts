import { describe, expect, it } from 'vitest';
import cases from '../../../spec/conformance/cases/activity.json' with { type: 'json' };
import { activityOf, isStalled, STALLED_AFTER_MS } from '../src/task.ts';

describe('activityOf', () => {
  it('gives every activity case of the protocol its activity', () => {
    // The cases fix the stall period; Ntasks states its own, which must be theirs.
    expect(STALLED_AFTER_MS).toBe(cases.stalledAfterMs);
    expect(
      cases.cases.map(({ name, task }) => ({
        name,
        stalled: isStalled(task, cases.readAt),
        activity: activityOf(task, cases.readAt),
      })),
    ).toEqual(cases.cases.map(({ name, stalled, activity }) => ({ name, stalled, activity })));
  });
});
