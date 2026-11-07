const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatInt(n: number): string {
  return INT.format(n);
}

/** A count that may be missing a project's tasks: `at least 12`. */
export function countLabel(count: number, partial = false): string {
  return partial ? `at least ${formatInt(count)}` : formatInt(count);
}

/** How long ago `iso` was, in milliseconds; null for a missing or unreadable time. */
export function ageMs(nowMs: number, iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.max(0, nowMs - at);
}

/** An age as its largest whole unit: `45s`, `12m`, `3h`, `9d`. */
export function formatAge(ms: number | null): string {
  if (ms === null) return 'unknown';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** An estimate in whole minutes as hours and minutes: `45m`, `2h`, `1h 30m`. */
export function formatMinutes(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${formatInt(hours)}h` : `${formatInt(hours)}h ${rest}m`;
}

/** A custom field's key as a name, until the page reads the field's own: `story_points` is Story points. */
export function fieldKeyName(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words === '' ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

/** A custom field's value in words: yes or no, a list joined by commas, anything else as it is. */
export function fieldValueText(value: string | number | boolean | readonly string[]): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const DAY_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** A calendar day `YYYY-MM-DD` as `Nov 6`, with the year when it is not this year's. */
export function calendarDay(day: string, nowMs: number): string {
  const [year, month, date] = day.split('-').map(Number);
  if (year === undefined || month === undefined || date === undefined) return day;
  const at = new Date(year, month - 1, date);
  if (Number.isNaN(at.getTime())) return day;
  return at.getFullYear() === new Date(nowMs).getFullYear() ? DAY.format(at) : DAY_YEAR.format(at);
}

/** The local calendar day of `ms`, `addDays` later, as `YYYY-MM-DD`. */
export function localDay(ms: number, addDays = 0): string {
  const at = new Date(ms);
  at.setDate(at.getDate() + addDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
