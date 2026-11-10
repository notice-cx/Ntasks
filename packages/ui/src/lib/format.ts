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

const DURATION = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/i;

/**
 * An estimate as a person types it, in whole minutes: `90` and `90m` are
 * minutes, `2h` and `1.5h` hours, `1h 30m` and `1:30` both. Null for
 * anything else, and for more than `max` minutes.
 */
export function parseMinutes(text: string, max: number): number | null {
  // `formatMinutes` groups thousands of hours, so what a fact shows reads back.
  const words = text.trim().replace(/,/g, '');
  if (words === '') return null;
  let minutes: number | null = null;
  const clock = /^(\d+):([0-5]\d)$/.exec(words);
  if (/^\d+$/.test(words)) minutes = Number(words);
  else if (clock) minutes = Number(clock[1]) * 60 + Number(clock[2]);
  else {
    const parts = DURATION.exec(words);
    if (parts && (parts[1] !== undefined || parts[2] !== undefined))
      minutes = Number(parts[1] ?? 0) * 60 + Number(parts[2] ?? 0);
  }
  if (minutes === null || !Number.isFinite(minutes)) return null;
  const whole = Math.round(minutes);
  return whole <= max ? whole : null;
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
