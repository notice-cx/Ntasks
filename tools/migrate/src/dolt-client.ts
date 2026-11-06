/**
 * Runs the hub file's SQL client for one query and reads Dolt's JSON result
 * format: `{"rows": [...]}`, or `{}` for no rows. A statement before the last,
 * such as `USE`, prints its own line first, so the last line is the answer.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BeadsRow } from './beads.ts';
import type { HubFile, Query } from './export.ts';
import { isJsonObject } from './json.ts';

const OUTPUT_LIMIT = 1024 * 1024 * 1024;
const QUERY_TIMEOUT_MS = 10 * 60 * 1000;

export function parseDoltJson(stdout: string): BeadsRow[] {
  const line =
    stdout
      .trim()
      .split('\n')
      .filter((entry) => entry.trim() !== '')
      .at(-1) ?? '';
  const parsed: unknown = JSON.parse(line);
  if (!isJsonObject(parsed)) throw new Error('The SQL client did not print a JSON object.');
  if (Object.keys(parsed).length === 0) return [];
  const rows = parsed.rows;
  if (!Array.isArray(rows) || !rows.every(isJsonObject)) throw new Error('The SQL client printed no rows list.');
  return rows as BeadsRow[];
}

/**
 * A query function over the hub file's client. The client gets an empty,
 * private HOME of its own and only the variables it needs, so no ambient
 * Dolt or Beads setting reaches it; Dolt's usage reporting is off.
 */
export async function doltClient(
  hub: HubFile,
): Promise<{ readonly query: Query; readonly close: () => Promise<void> }> {
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
  const query: Query = (sql) =>
    new Promise((resolve, reject) => {
      execFile(
        program!,
        [...args, sql],
        { cwd: home, env, maxBuffer: OUTPUT_LIMIT, timeout: QUERY_TIMEOUT_MS, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`The SQL client failed on: ${sql}\n${(stderr || error.message).slice(0, 2000)}`));
            return;
          }
          try {
            resolve(parseDoltJson(stdout));
          } catch (cause) {
            reject(new Error(`The SQL client's answer to "${sql}" could not be read: ${(cause as Error).message}`));
          }
        },
      );
    });
  return { query, close: () => rm(home, { recursive: true, force: true }) };
}
