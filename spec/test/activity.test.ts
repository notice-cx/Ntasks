/**
 * The suite's own copy of STATE-20 and STATE-16, which its checks judge a
 * server by, gives every fixed-clock case in conformance/cases/activity.json
 * the stalled and activity the case names.
 */
import { describe, expect, it } from 'vitest';
import cases from '../conformance/cases/activity.json' with { type: 'json' };
import { activityAt, stalledAt } from '../conformance/src/activity.ts';

describe('the activity cases', () => {
  it.each(cases.cases)('hold for the reference rule: $name', ({ task, stalled, activity }) => {
    const marked = stalledAt(task, cases.readAt, cases.stalledAfterMs);
    expect([marked, activityAt(task, cases.readAt, marked)]).toEqual([stalled, activity]);
  });

  it('cover each group, and a task with no activity', () => {
    expect(new Set(cases.cases.map((one) => one.activity))).toEqual(new Set(['active', 'quiet', 'stalled', null]));
  });
});
