/**
 * Runs the hub file's SQL client for one step of the export: its queries in
 * one read-only transaction, which it then rolls back, so they read one
 * snapshot and cannot write. The client prints each statement's result as one
 * line of Dolt's JSON result format: `{"rows": [...]}`, or `{}` for no rows.
 * A marker query before each query, holding a random value, says which lines
 * answer it.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BeadsRow } from './beads.ts';
import type { HubFile, Reader } from './export.ts';
import { isJsonObject } from './json.ts';

const OUTPUT_LIMIT = 1024 * 1024 * 1024;
const STEP_TIMEOUT_MS = 10 * 60 * 1000;

/** One result line of Dolt's JSON result format. */
export function parseDoltJson(line: string): BeadsRow[] {
  const parsed: unknown = JSON.parse(line);
  if (!isJsonObject(parsed)) throw new Error('The SQL client did not print a JSON object.');
  if (Object.keys(parsed).length === 0) return [];
  const rows = parsed.rows;
  if (!Array.isArray(rows) || !rows.every(isJsonObject)) throw new Error('The SQL client printed no rows list.');
  return rows as BeadsRow[];
}

/** The statements of one step: its queries, each after a marker, in a read-only transaction. */
export function stepSql(queries: readonly string[], marker: string): string {
  const parts = ['START TRANSACTION READ ONLY'];
  queries.forEach((sql, index) => parts.push(`SELECT '${marker}:${index}' AS ntasks_query`, sql));
  parts.push(`SELECT '${marker}:end' AS ntasks_query`, 'ROLLBACK');
  return parts.join('; ');
}

/**
 * The answer to each query of a step, from the client's output. The lines
 * between one marker and the next answer that marker's query; a statement
 * such as `USE` may print an empty line or `{}` first, so the last line is
 * the answer.
 */
export function stepResults(stdout: string, marker: string, count: number): BeadsRow[][] {
  const tag = `"ntasks_query":"${marker}:`;
  const sections: string[][] = [];
  let current: string[] | null = null;
  for (const line of stdout.split('\n')) {
    if (line.includes(tag)) {
      current = [];
      sections.push(current);
    } else if (current !== null && line.trim() !== '') {
      current.push(line);
    }
  }
  // The last section follows the end marker and holds only ROLLBACK's output.
  if (sections.length !== count + 1)
    throw new Error(`The SQL client answered ${sections.length - 1} of ${count} queries.`);
  return sections.slice(0, count).map((lines, index) => {
    const last = lines.at(-1);
    if (last === undefined) throw new Error(`The SQL client printed nothing for query ${index + 1}.`);
    return parseDoltJson(last);
  });
}

/**
 * A reader over the hub file's client. The client gets an empty, private
 * HOME of its own and only the variables it needs, so no ambient Dolt or
 * Beads setting reaches it; Dolt's usage reporting is off.
 */
export async function doltClient(
  hub: HubFile,
): Promise<{ readonly read: Reader; readonly close: () => Promise<void> }> {
  const home = await mkdtemp(path.join(tmpdir(), 'ntasks-export-client-'));
  const password =
    hub.passwordFile === undefined ? undefined : (await readFile(hub.passwordFile, 'utf8')).replace(/\r?\n$/u, '');
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    DOLT_DISABLE_EVENT_FLUSH: '1',
    ...(password === undefined ? {} : { DOLT_CLI_PASSWORD: password }),
    ...hub.env,
  };
  const [program, ...args] = hub.client;
  const read: Reader = (queries) =>
    new Promise((resolve, reject) => {
      const marker = `ntasks-${randomUUID()}`;
      execFile(
        program!,
        [...args, stepSql(queries, marker)],
        { cwd: home, env, maxBuffer: OUTPUT_LIMIT, timeout: STEP_TIMEOUT_MS, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(`The SQL client failed on: ${queries.join('; ')}\n${(stderr || error.message).slice(0, 2000)}`),
            );
            return;
          }
          try {
            resolve(stepResults(stdout, marker, queries.length));
          } catch (cause) {
            reject(new Error(`The SQL client's answer could not be read: ${(cause as Error).message}`));
          }
        },
      );
    });
  return { read, close: () => rm(home, { recursive: true, force: true }) };
}
