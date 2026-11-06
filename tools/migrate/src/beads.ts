/**
 * The export file: what `export` reads from a Beads hub on Dolt, and the only
 * input `import` and `verify` take. Rows are kept as the Dolt SQL client
 * printed them, so the file holds the hub's data as Beads stored it and every
 * decision about it is made, and can be checked, in the import.
 */
import type { Json } from '@ntasks/domain';
import { isJsonObject } from './json.ts';

export const EXPORT_FORMAT = 'ntasks-beads-export-v2';

/**
 * A row as the Dolt SQL client prints it with `--result-format=json`: a
 * column whose value is NULL is left out, a DATETIME is text such as
 * `2026-11-06 15:42:48`, and a JSON column is the JSON value itself.
 */
export type BeadsRow = { readonly [column: string]: Json };

/** The tables `export` reads in full. Every other table is only counted. */
export const READ_TABLES = ['issues', 'labels', 'dependencies', 'comments', 'events'] as const;
export type ReadTable = (typeof READ_TABLES)[number];

/** The tables whose Dolt history `export` reads: their changes, commit by commit. */
export const HISTORY_TABLES = ['issues', 'labels', 'dependencies'] as const;
export type HistoryTable = (typeof HISTORY_TABLES)[number];

export interface BeadsProject {
  /** The Dolt database that holds the project. */
  readonly database: string;
  /** The project's key and name in Ntasks, from the hub file. */
  readonly key: string;
  readonly name: string;
  /** The project's id in Ntasks: the hub file's, which is the NoticeOS project id, or else the database's `_project_id`. */
  readonly id: string;
  /** The database's `_project_id` metadata value: Beads' own id for the project. */
  readonly beadsProjectId: string;
  /** The database's `issue_prefix` setting. */
  readonly prefix: string;
  /** Every base table of the database and how many rows it holds. */
  readonly tables: readonly { readonly name: string; readonly rows: number }[];
  /** `dolt_branches`: every branch and its head. */
  readonly branches: readonly BeadsRow[];
  /** `dolt_log`: the commits of the branch the server reads, newest first. */
  readonly commits: readonly BeadsRow[];
  /** The current rows of the tables in READ_TABLES; an empty list for a table the database lacks. */
  readonly rows: { readonly [table in ReadTable]: readonly BeadsRow[] };
  /** `dolt_diff_<table>`: every change to the table, one row per changed row and commit. */
  readonly diffs: { readonly [table in HistoryTable]: readonly BeadsRow[] };
}

export interface BeadsExport {
  readonly format: typeof EXPORT_FORMAT;
  readonly exportedAt: string;
  /** DOLT_VERSION() of the server that was read. */
  readonly doltVersion: string;
  readonly projects: readonly BeadsProject[];
}

function rows(value: unknown, where: string): readonly BeadsRow[] {
  if (!Array.isArray(value) || !value.every(isJsonObject)) throw new Error(`${where} must be a list of rows.`);
  return value as readonly BeadsRow[];
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} must be text.`);
  return value;
}

/** Reads an export file's JSON, checking its shape. Its content is checked by the import. */
export function readExport(json: string): BeadsExport {
  const value: unknown = JSON.parse(json);
  if (!isJsonObject(value) || value.format !== EXPORT_FORMAT)
    throw new Error(`The file is not an export in the ${EXPORT_FORMAT} format.`);
  if (!Array.isArray(value.projects)) throw new Error('projects must be a list.');
  const projects = value.projects.map((entry: unknown, index): BeadsProject => {
    const where = `projects[${index}]`;
    if (!isJsonObject(entry)) throw new Error(`${where} must be an object.`);
    const table = (group: 'rows' | 'diffs', name: string) => {
      const holder = entry[group];
      if (!isJsonObject(holder)) throw new Error(`${where}.${group} must be an object.`);
      return rows(holder[name], `${where}.${group}.${name}`);
    };
    const tables = rows(entry.tables, `${where}.tables`).map((row, at) => {
      if (typeof row.name !== 'string' || typeof row.rows !== 'number')
        throw new Error(`${where}.tables[${at}] needs a name and a row count.`);
      return { name: row.name, rows: row.rows };
    });
    return {
      database: text(entry.database, `${where}.database`),
      key: text(entry.key, `${where}.key`),
      name: text(entry.name, `${where}.name`),
      id: text(entry.id, `${where}.id`),
      beadsProjectId: text(entry.beadsProjectId, `${where}.beadsProjectId`),
      prefix: text(entry.prefix, `${where}.prefix`),
      tables,
      branches: rows(entry.branches, `${where}.branches`),
      commits: rows(entry.commits, `${where}.commits`),
      rows: {
        issues: table('rows', 'issues'),
        labels: table('rows', 'labels'),
        dependencies: table('rows', 'dependencies'),
        comments: table('rows', 'comments'),
        events: table('rows', 'events'),
      },
      diffs: {
        issues: table('diffs', 'issues'),
        labels: table('diffs', 'labels'),
        dependencies: table('diffs', 'dependencies'),
      },
    };
  });
  return {
    format: EXPORT_FORMAT,
    exportedAt: text(value.exportedAt, 'exportedAt'),
    doltVersion: text(value.doltVersion, 'doltVersion'),
    projects,
  };
}

/** Text, or null for a value that is missing, NULL or empty. */
export function textOf(value: Json | undefined): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number') return String(value);
  return null;
}

const DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/u;

/**
 * A Dolt time as UTC ISO 8601 with milliseconds, the form Ntasks stores.
 * Dolt prints a DATETIME without a zone; Beads writes them in UTC. The zero
 * dates MySQL and Go use for "no time" read as null. Undefined means the
 * value is not a time.
 */
export function timeOf(value: Json | undefined): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const match = DATETIME.exec(value);
  if (match === null) return undefined;
  const [, date, clock, fraction, zone] = match;
  if (date === '0000-00-00' || (date === '0001-01-01' && clock === '00:00:00' && !Number(fraction ?? 0))) return null;
  const millis = (fraction ?? '').padEnd(3, '0').slice(0, 3);
  const offset =
    zone === undefined ? 'Z' : zone === 'Z' || zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const parsed = new Date(`${date}T${clock}.${millis}${offset}`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  const iso = parsed.toISOString();
  // A date such as February 30 rolls over in Date; refuse it instead.
  if (zone === undefined && iso.slice(0, 19) !== `${date}T${clock}`) return undefined;
  return iso;
}

/**
 * Whether a stored value holds nothing: missing, NULL, empty text, the number
 * zero, false, or an empty JSON list or object. Text is empty only when it has
 * no characters: "0" or "[]" in a text column is something someone wrote.
 */
export function isEmpty(value: Json | undefined): boolean {
  if (value === undefined || value === null || value === '' || value === 0 || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}
