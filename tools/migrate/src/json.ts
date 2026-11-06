import type { Json, JsonObject } from '@ntasks/domain';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}

/** JSON text with object keys sorted, so two equal values always give the same text. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null';
}

export function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Text of at most `max` characters, for quoting a stored value in a report. */
export function excerpt(value: Json | undefined, max = 60): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
