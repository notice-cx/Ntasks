import { describe, expect, it } from 'vitest';
import { timelineOrder, type TimelineEntry } from '@/components/TaskTimeline';
import { fieldKeyName, fieldValueText, formatMinutes, parseMinutes } from '@/lib/format';

describe("a task's facts in words", () => {
  it('writes an estimate as hours and minutes', () => {
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(120)).toBe('2h');
    expect(formatMinutes(90)).toBe('1h 30m');
    expect(formatMinutes(0)).toBe('0m');
    expect(formatMinutes(-5)).toBe('0m');
  });

  it('reads an estimate as a person types it, in whole minutes', () => {
    expect(parseMinutes('90', 600)).toBe(90);
    expect(parseMinutes('45m', 600)).toBe(45);
    expect(parseMinutes('2h', 600)).toBe(120);
    expect(parseMinutes('1.5h', 600)).toBe(90);
    expect(parseMinutes('1h 30m', 600)).toBe(90);
    expect(parseMinutes('1h30m', 600)).toBe(90);
    expect(parseMinutes('1:30', 600)).toBe(90);
    expect(parseMinutes('2 hours 5 minutes', 600)).toBe(125);
    // What the fact shows reads back as the same estimate.
    expect(parseMinutes(formatMinutes(525_600), 525_600)).toBe(525_600);
    for (const wrong of ['', 'soon', '1h 30', 'h', '-5', '1:75']) expect(parseMinutes(wrong, 600)).toBeNull();
    expect(parseMinutes('11h', 600)).toBeNull();
  });

  it("names a custom field by its key until the field's own name is read", () => {
    expect(fieldKeyName('story_points')).toBe('Story points');
    expect(fieldKeyName('needs-review')).toBe('Needs review');
    expect(fieldKeyName('area')).toBe('Area');
  });

  it("writes a custom field's value: yes or no, a list joined, anything else as it is", () => {
    expect(fieldValueText(true)).toBe('Yes');
    expect(fieldValueText(false)).toBe('No');
    expect(fieldValueText(['web', 'docs'])).toBe('web, docs');
    expect(fieldValueText(3)).toBe('3');
    expect(fieldValueText('https://example.com')).toBe('https://example.com');
  });
});

describe("a task's activity", () => {
  const entry = (id: string, at: string | null): TimelineEntry => ({ id, at, kind: 'comment', actor: null, label: id });

  it('lists the moments oldest first, then the ones with no readable time', () => {
    const ordered = timelineOrder([
      entry('late', '2026-11-05T10:00:00Z'),
      entry('undated', null),
      entry('early', '2026-11-01T10:00:00Z'),
      entry('unreadable', 'not a time'),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(['early', 'late', 'undated', 'unreadable']);
  });
});
