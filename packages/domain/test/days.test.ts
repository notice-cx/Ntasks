import { describe, expect, it } from 'vitest';
import { addDays, isDay, isTimeZone, zoneDays } from '../src/days.ts';

const dayIn = (ms: number, zone: string) => zoneDays(zone).dayIn(ms);
const dayStart = (day: string, zone: string) => zoneDays(zone).dayStart(day);

describe('the day an instant falls on', () => {
  it('depends on the time zone', () => {
    // 6 pm on 9 Nov in Los Angeles is already 10 Nov in UTC.
    const evening = Date.parse('2026-11-10T02:00:00.000Z');
    expect(dayIn(evening, 'America/Los_Angeles')).toBe('2026-11-09');
    expect(dayIn(evening, 'UTC')).toBe('2026-11-10');
    expect(dayIn(Date.parse('2026-11-09T16:00:00.000Z'), 'Asia/Tokyo')).toBe('2026-11-10');
  });
});

describe('the instant a day starts', () => {
  it('is its midnight in the zone', () => {
    expect(new Date(dayStart('2026-11-09', 'America/Los_Angeles')).toISOString()).toBe('2026-11-09T08:00:00.000Z');
    expect(new Date(dayStart('2026-11-09', 'UTC')).toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(new Date(dayStart('2026-11-10', 'Asia/Kolkata')).toISOString()).toBe('2026-11-09T18:30:00.000Z');
  });

  it('follows clock changes: a 23-hour day, a 25-hour day, and a day whose midnight is skipped', () => {
    const hours = (day: string, zone: string) => (dayStart(addDays(day, 1), zone) - dayStart(day, zone)) / 3_600_000;
    expect(hours('2026-03-08', 'America/Los_Angeles')).toBe(23);
    expect(hours('2026-11-01', 'America/Los_Angeles')).toBe(25);
    expect(hours('2026-03-29', 'Europe/Warsaw')).toBe(23);
    // Chile moves its clocks from midnight to 1 am, so 6 Sep starts at 1 am.
    expect(hours('2026-09-06', 'America/Santiago')).toBe(23);
  });

  it('is the first instant of the day and the instant before it is the day before, in every zone and season', () => {
    const zones = [
      'UTC',
      'America/Los_Angeles',
      'America/New_York',
      'America/Santiago',
      'Europe/Warsaw',
      'Asia/Kolkata',
      'Australia/Lord_Howe',
      'Pacific/Kiritimati',
    ];
    for (const zone of zones) {
      for (let day = '2026-01-01'; day < '2027-01-01'; day = addDays(day, 1)) {
        const start = dayStart(day, zone);
        expect(dayIn(start, zone), `${zone} ${day}`).toBe(day);
        expect(dayIn(start - 1, zone), `${zone} ${day}`).toBe(addDays(day, -1));
      }
    }
  });
});

describe('days and zones', () => {
  it('takes only a calendar day written YYYY-MM-DD', () => {
    expect(isDay('2026-11-10')).toBe(true);
    for (const day of ['2026-02-30', '2026-11-1', '10/11/2026', '', 20261110])
      expect(isDay(day), String(day)).toBe(false);
  });

  it('takes only a time zone the runtime knows', () => {
    for (const zone of ['America/Los_Angeles', 'Europe/Warsaw', 'UTC']) expect(isTimeZone(zone), zone).toBe(true);
    for (const zone of ['Mars/Olympus_Mons', '', 'x'.repeat(65), 42])
      expect(isTimeZone(zone), String(zone)).toBe(false);
  });

  it('counts days across months and years', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2026-11-10', -56)).toBe('2026-09-15');
  });
});
