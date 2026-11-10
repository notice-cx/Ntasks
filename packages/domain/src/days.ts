/**
 * Calendar days in a time zone, for the server and the web app alike: the
 * day an instant falls on in an IANA time zone such as America/Los_Angeles,
 * and the instant a day starts. A day is written `YYYY-MM-DD`. The time zone
 * rules are the JavaScript runtime's own (Intl), so a day lasts 23, 24 or 25
 * hours where clocks change.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** The longest IANA time zone name, America/Argentina/ComodRivadavia, is 32 characters. */
const ZONE_LENGTH = 64;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** Whether `zone` names a time zone this runtime knows, such as `America/Los_Angeles` or `UTC`. */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > ZONE_LENGTH) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Whether `day` is a calendar day written `YYYY-MM-DD`, such as `2026-11-10`. */
export function isDay(day: unknown): day is string {
  if (typeof day !== 'string') return false;
  const match = DAY.exec(day);
  if (match === null) return false;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(at).toISOString().slice(0, 10) === day;
}

/** The day `days` after `day` (before it when negative). */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The days of one time zone. Building one costs far more than using it, so a
 * read builds one and asks it for every day it needs. */
export interface ZoneDays {
  readonly zone: string;
  /** The day instant `ms` falls on. */
  dayIn(ms: number): string;
  /** The instant `day` starts: its midnight, or where a clock change skips midnight, its first instant. */
  dayStart(day: string): number;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** The days of `zone`, which must be one `isTimeZone` takes. */
export function zoneDays(zone: string): ZoneDays {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const fieldsIn = (ms: number) => {
    const fields: Record<string, number> = {};
    for (const part of format.formatToParts(ms)) if (part.type !== 'literal') fields[part.type] = Number(part.value);
    return fields as { year: number; month: number; day: number; hour: number; minute: number; second: number };
  };
  const dayIn = (ms: number) => {
    const { year, month, day } = fieldsIn(ms);
    return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  };
  /** How far the zone's clocks are ahead of UTC at instant `ms`. */
  const offsetAt = (ms: number) => {
    const { year, month, day, hour, minute, second } = fieldsIn(ms);
    return Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(ms / 1000) * 1000;
  };
  const dayStart = (day: string) => {
    const midnight = Date.parse(`${day}T00:00:00.000Z`);
    // The offset at midnight UTC can differ from the offset at the day's start when clocks change in between.
    let at = midnight - offsetAt(midnight - offsetAt(midnight));
    // A day whose midnight the clocks skip starts at the first hour that exists.
    while (dayIn(at) < day) at += HOUR_MS;
    while (dayIn(at - 1) === day) at -= HOUR_MS;
    return at;
  };
  return { zone, dayIn, dayStart };
}
