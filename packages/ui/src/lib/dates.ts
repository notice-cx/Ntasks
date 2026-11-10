/**
 * Every date the pages show, in the person's own time zone: the one place
 * that turns an instant into a day and a day into words. The zone is the
 * browser's unless the app is given another (`TimeZoneProvider`). A day is
 * written `YYYY-MM-DD`; its words never depend on the zone, so they are
 * drawn as UTC from the day's own midnight.
 */
import { addDays, zoneDays, type ZoneDays } from '@ntasks/domain';
import { createContext, createElement, useContext, type ReactNode } from 'react';

export { addDays };

/** Each zone's days, built once: a page shows one person's zone. */
const zones = new Map<string, ZoneDays>();
function daysOf(zone: string): ZoneDays {
  let days = zones.get(zone);
  if (days === undefined) {
    days = zoneDays(zone);
    zones.set(zone, days);
  }
  return days;
}

/** The day instant `ms` falls on in `zone`, as `YYYY-MM-DD`. */
export function dayIn(ms: number, zone: string): string {
  return daysOf(zone).dayIn(ms);
}

/** The browser's time zone, such as America/Los_Angeles; UTC when it names none. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const TimeZone = createContext<string | null>(null);

/** Sets the time zone the pages under it show dates in. */
export function TimeZoneProvider({ zone, children }: { zone: string; children: ReactNode }) {
  return createElement(TimeZone.Provider, { value: zone }, children);
}

/** The time zone dates are shown in: the one set above, else the browser's. */
export function useTimeZone(): string {
  return useContext(TimeZone) ?? browserTimeZone();
}

/** The time zone set above, or null where none is. */
export function useGivenTimeZone(): string | null {
  return useContext(TimeZone);
}

/** Every time zone this browser knows, by IANA name, for a person to choose from. Browsers list the
 * places' zones without UTC itself, which is offered too. */
export function timeZoneNames(): readonly string[] {
  const known = (Intl as { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf?.('timeZone') ?? [];
  return [...new Set([...(known.length > 0 ? known : [browserTimeZone()]), 'UTC'])];
}

/** The day `addDays` days after the one `nowMs` falls on in `zone`: today, tomorrow, in a week. */
export function dayFrom(nowMs: number, zone: string, add = 0): string {
  return addDays(dayIn(nowMs, zone), add);
}

const SHORT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const SHORT_YEAR = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const LONG = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });

/** A day's own midnight as an instant, for its words; NaN when it is no day. */
const midnightOf = (day: string) =>
  /^\d{4}-\d{2}-\d{2}$/u.test(day) ? Date.parse(`${day}T00:00:00.000Z`) : Number.NaN;

/** A day as `Nov 6`, with the year when it is not this year's in `zone`. */
export function calendarDay(day: string, nowMs: number, zone: string): string {
  const at = midnightOf(day);
  if (Number.isNaN(at)) return day;
  return day.slice(0, 4) === dayIn(nowMs, zone).slice(0, 4) ? SHORT.format(at) : SHORT_YEAR.format(at);
}

/** A day as `Tue, Nov 10`. */
export function dayLabel(day: string): string {
  const at = midnightOf(day);
  return Number.isNaN(at) ? day : LONG.format(at);
}

/** A day as its weekday and date, `Tue 10`. */
export function weekdayDay(day: string): string {
  const at = midnightOf(day);
  return Number.isNaN(at) ? day : `${WEEKDAY.format(at)} ${Number(day.slice(8))}`;
}
