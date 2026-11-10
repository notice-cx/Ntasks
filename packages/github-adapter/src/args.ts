/**
 * Checking a tool call's arguments against the tool's own list: a missing,
 * malformed or unknown argument is refused by name, an unknown one with the
 * name it most likely means (protocol.md EXT-3).
 */
import { Refused } from './refused.ts';

export type Args = Readonly<Record<string, unknown>>;

export interface ArgSpec {
  /** A JSON Schema for the tools list. */
  readonly schema: Record<string, unknown>;
  /** Checks a present value; answers the rule it breaks, or null. */
  readonly check: (value: unknown) => string | null;
}

const ONE_LINE = /^[^\r\n\t]*$/u;

export const text = (max: number, oneLine = false): ArgSpec => ({
  schema: { type: 'string', maxLength: max },
  check: (value) =>
    typeof value !== 'string' || value.length > max || (oneLine && !ONE_LINE.test(value))
      ? `${oneLine ? 'one line of ' : ''}at most ${max} characters`
      : null,
});

export const nonEmpty = (max: number, oneLine = false): ArgSpec => ({
  schema: { type: 'string', minLength: 1, maxLength: max },
  check: (value) =>
    typeof value !== 'string' || value.trim() === '' || value.length > max || (oneLine && !ONE_LINE.test(value))
      ? `${oneLine ? 'one line of ' : ''}1 to ${max} characters`
      : null,
});

export const integer = (min: number, max: number): ArgSpec => ({
  schema: { type: 'integer', minimum: min, maximum: max },
  check: (value) =>
    Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? null : `${min}–${max}`,
});

export const bool: ArgSpec = {
  schema: { type: 'boolean' },
  check: (value) => (typeof value === 'boolean' ? null : 'true or false'),
};

export const oneOf = (values: readonly string[]): ArgSpec => ({
  schema: { enum: values },
  check: (value) => (typeof value === 'string' && values.includes(value) ? null : `one of ${values.join(', ')}`),
});

export const list = (item: ArgSpec, max: number): ArgSpec => ({
  schema: { type: 'array', items: item.schema, maxItems: max },
  check: (value) => {
    if (!Array.isArray(value) || value.length > max) return `a list of at most ${max}`;
    for (const entry of value) {
      const problem = item.check(entry);
      if (problem !== null) return `each ${problem}`;
    }
    return null;
  },
});

export const object: ArgSpec = {
  schema: { type: 'object' },
  check: (value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? null : 'a JSON object'),
};

export const TASK_ID = /^[a-z0-9]{1,32}-[a-z0-9.]{1,32}$/u;
export const taskId: ArgSpec = {
  schema: { type: 'string', pattern: TASK_ID.source },
  check: (value) => (typeof value === 'string' && TASK_ID.test(value) ? null : 'a task id such as abc-12'),
};

export const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
export const COMMON: Readonly<Record<string, ArgSpec>> = {
  workspace: nonEmpty(128, true),
  model: nonEmpty(128, true),
  idempotency_key: {
    schema: { type: 'string', pattern: KEY.source },
    check: (value) =>
      typeof value === 'string' && KEY.test(value)
        ? null
        : '8 to 128 letters, digits, dots, underscores, colons or hyphens',
  },
  detail: oneOf(['full']),
};

/** Levenshtein distance, for naming the argument a misspelt one most likely means. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** The arguments, checked against `specs`; `required` must be present. */
export function checkArgs(
  args: unknown,
  specs: Readonly<Record<string, ArgSpec>>,
  required: readonly string[] = [],
): Args {
  if (typeof args !== 'object' || args === null || Array.isArray(args))
    throw new Refused('invalid', 'invalid arguments: the arguments are a JSON object');
  const all = { ...COMMON, ...specs };
  for (const name of Object.keys(args)) {
    if (all[name] !== undefined) continue;
    const likely = Object.keys(all).sort((a, b) => distance(name, a) - distance(name, b))[0];
    throw new Refused('invalid', `invalid arguments: unknown argument ${name}; this tool takes ${likely}`);
  }
  for (const name of required)
    if ((args as Args)[name] === undefined) throw new Refused('invalid', `invalid arguments: ${name} (required)`);
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const problem = all[name]!.check(value);
    if (problem !== null) throw new Refused('invalid', `invalid arguments: ${name} (${problem})`);
  }
  return args as Args;
}

/** The tool's input schema, for the tools list. */
export function schemaOf(specs: Readonly<Record<string, ArgSpec>>, required: readonly string[] = []) {
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries({ ...COMMON, ...specs }).map(([name, spec]) => [name, spec.schema])),
    required,
    additionalProperties: false,
  };
}
