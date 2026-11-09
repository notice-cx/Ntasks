/**
 * The server the suite checks, as a target file describes it: its address,
 * the levels it claims, the bindings it offers, the projects the checks
 * write in, and the senders the checks act as. `target.schema.json` holds
 * the file's rules and what each field means.
 */
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';

export const LEVELS = ['core', 'human', 'delivery', 'live'] as const;
export type Level = (typeof LEVELS)[number];

export const BINDINGS = ['mcp', 'http'] as const;
export type BindingName = (typeof BINDINGS)[number];

/** A sender is the headers that sign its requests in. */
export interface SenderConfig {
  readonly headers: Readonly<Record<string, string>>;
}

export type SenderRole = 'agent' | 'otherAgent' | 'service' | 'person';

export interface Target {
  readonly url: string;
  readonly levels: readonly Level[];
  readonly bindings: Partial<Readonly<Record<BindingName, { readonly path: string }>>>;
  readonly workspace?: string;
  readonly projects: { readonly main: string; readonly readOnly?: string; readonly hidden?: string };
  readonly senders: {
    readonly agent: SenderConfig;
    readonly otherAgent: SenderConfig;
    readonly service?: SenderConfig;
    readonly person?: SenderConfig;
  };
  readonly repository?: string;
  readonly knownGaps?: Readonly<Record<string, string>>;
}

const schema = JSON.parse(readFileSync(new URL('../target.schema.json', import.meta.url), 'utf8')) as object;
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

/** The target `value` describes, or an error naming each rule of the schema it breaks. */
export function checkTarget(value: unknown): Target {
  if (!validate(value)) {
    const problems = (validate.errors ?? []).map((error) => {
      const where = error.instancePath || 'the target';
      const extra = (error.params as { additionalProperty?: string }).additionalProperty;
      return extra === undefined
        ? `${where} ${error.message}`
        : `${where} has ${extra}, which the schema does not name`;
    });
    throw new Error(`The target file breaks target.schema.json: ${problems.join('; ')}`);
  }
  return value as Target;
}

/**
 * The address of `path` on the target. A path that would resolve to another
 * origin is refused, so a sender's headers are only ever sent to the target.
 */
export function addressOf(target: Target, path: string): URL {
  const origin = new URL(target.url).origin;
  const address = new URL(path, origin);
  if (address.origin !== origin) throw new Error(`${path} resolves to ${address.origin}, not the target's ${origin}`);
  return address;
}

export function readTarget(path: string): Target {
  return checkTarget(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}
