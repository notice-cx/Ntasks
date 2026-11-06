/**
 * The export: reads a Beads hub on Dolt with read-only SELECT queries and
 * returns the export file's content. It never writes to the hub and never
 * runs Beads itself; `describeExport` lists every query it sends.
 */
import {
  EXPORT_FORMAT,
  HISTORY_TABLES,
  READ_TABLES,
  textOf,
  type BeadsExport,
  type BeadsProject,
  type BeadsRow,
  type HistoryTable,
  type ReadTable,
} from './beads.ts';
import { isJsonObject } from './json.ts';

/** One project of the hub, as the hub file names it. */
export interface HubProject {
  /** The Dolt database that holds the project. */
  readonly database: string;
  /** The project's key and name in Ntasks. */
  readonly key: string;
  readonly name: string;
  /** When given, the export refuses a database whose `_project_id` differs. */
  readonly id?: string;
  /** When given, the export refuses a database whose `issue_prefix` differs. */
  readonly prefix?: string;
}

/**
 * The hub file: how to reach the hub and which databases to read. It names
 * no password, only the file that holds one.
 */
export interface HubFile {
  /** The SQL client command: each query is added as its last argument, and it prints Dolt's JSON result format. */
  readonly client: readonly string[];
  /** A file holding the SQL user's password, given to the client as DOLT_CLI_PASSWORD. */
  readonly passwordFile?: string;
  /** More variables for the client, such as DOCKER_CONTEXT. */
  readonly env?: Readonly<Record<string, string>>;
  readonly projects: readonly HubProject[];
}

export type Query = (sql: string) => Promise<BeadsRow[]>;

const DATABASE = /^[A-Za-z0-9_]{1,64}$/u;
const TABLE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

function quote(name: string, pattern: RegExp): string {
  if (!pattern.test(name)) throw new Error(`"${name}" is not a name the export reads.`);
  return `\`${name}\``;
}

export function readHubFile(json: string): HubFile {
  const value: unknown = JSON.parse(json);
  if (!isJsonObject(value)) throw new Error('The hub file must be a JSON object.');
  const client = value.client;
  if (!Array.isArray(client) || client.length === 0 || !client.every((part) => typeof part === 'string')) {
    throw new Error('client must be the SQL client command, as a list of its program and arguments.');
  }
  if (value.passwordFile !== undefined && typeof value.passwordFile !== 'string')
    throw new Error('passwordFile must be a path.');
  const env = value.env;
  if (env !== undefined && (!isJsonObject(env) || !Object.values(env).every((entry) => typeof entry === 'string'))) {
    throw new Error('env must map names to text.');
  }
  if (!Array.isArray(value.projects) || value.projects.length === 0)
    throw new Error('projects must list at least one project.');
  const projects = value.projects.map((entry, index): HubProject => {
    if (!isJsonObject(entry)) throw new Error(`projects[${index}] must be an object.`);
    const { database, key, name, id, prefix } = entry;
    if (typeof database !== 'string' || !DATABASE.test(database))
      throw new Error(`projects[${index}].database must be a database name.`);
    if (typeof key !== 'string' || typeof name !== 'string')
      throw new Error(`projects[${index}] needs a key and a name.`);
    if ((id !== undefined && typeof id !== 'string') || (prefix !== undefined && typeof prefix !== 'string')) {
      throw new Error(`projects[${index}].id and .prefix must be text.`);
    }
    return { database, key, name, ...(id === undefined ? {} : { id }), ...(prefix === undefined ? {} : { prefix }) };
  });
  return {
    client: client as string[],
    ...(value.passwordFile === undefined ? {} : { passwordFile: value.passwordFile }),
    ...(env === undefined ? {} : { env: env as Record<string, string> }),
    projects,
  };
}

/** The queries the export sends for one database. */
export function databaseQueries(database: string) {
  const db = quote(database, DATABASE);
  return {
    working: `USE ${db}; SELECT DOLT_HASHOF_DB('WORKING') AS working`,
    projectId: `SELECT value FROM ${db}.\`metadata\` WHERE \`key\` = '_project_id'`,
    prefix: `SELECT value FROM ${db}.\`config\` WHERE \`key\` = 'issue_prefix'`,
    tables: `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${database}' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
    count: (table: string) => `SELECT COUNT(*) AS count FROM ${db}.${quote(table, TABLE)}`,
    branches: `SELECT name, hash FROM ${db}.dolt_branches ORDER BY name`,
    commits: `SELECT * FROM ${db}.dolt_log`,
    rows: (table: ReadTable) => `SELECT * FROM ${db}.\`${table}\``,
    diff: (table: HistoryTable) => `SELECT * FROM ${db}.\`dolt_diff_${table}\``,
  };
}

export const VERSION_QUERY = 'SELECT DOLT_VERSION() AS version';

/** Every query the export sends, in order, for review before it runs. */
export function describeExport(hub: HubFile): string {
  const lines = ['The export sends only these read-only queries, in this order:', '', `  ${VERSION_QUERY}`];
  for (const project of hub.projects) {
    const q = databaseQueries(project.database);
    lines.push(
      '',
      `Database ${project.database} (project ${project.key}):`,
      `  ${q.working}`,
      `  ${q.projectId}`,
      `  ${q.prefix}`,
      `  ${q.tables}`,
      `  ${q.count('TABLE')}   (once for each table the previous query lists)`,
      `  ${q.branches}`,
      `  ${q.commits}`,
      ...READ_TABLES.map((table) => `  ${q.rows(table)}   (if the table exists)`),
      ...HISTORY_TABLES.map((table) => `  ${q.diff(table)}   (if ${table} exists)`),
      `  ${q.working}   (again: the export refuses if the database changed meanwhile)`,
    );
  }
  lines.push('', `Each runs as: ${hub.client.join(' ')} '<query>'`);
  return lines.join('\n');
}

function single(rows: readonly BeadsRow[], what: string): string {
  const value = rows.length === 1 ? textOf(rows[0]!.value ?? rows[0]!.working ?? rows[0]!.version) : null;
  if (value === null) throw new Error(`The hub returned no ${what}.`);
  return value;
}

async function exportProject(project: HubProject, query: Query): Promise<BeadsProject> {
  const q = databaseQueries(project.database);
  const workingBefore = single(await query(q.working), `working set hash for ${project.database}`);
  const id = single(await query(q.projectId), `project id in ${project.database}`);
  const prefix = single(await query(q.prefix), `prefix in ${project.database}`);
  if (project.id !== undefined && project.id !== id)
    throw new Error(`${project.database} holds project ${id}, not ${project.id} as the hub file says.`);
  if (project.prefix !== undefined && project.prefix !== prefix)
    throw new Error(`${project.database} uses the prefix ${prefix}, not ${project.prefix} as the hub file says.`);
  const names = (await query(q.tables))
    .map((row) => textOf(row.name) ?? '')
    .filter((name) => !name.startsWith('dolt_'));
  const tables: { name: string; rows: number }[] = [];
  for (const name of names) {
    const [row] = await query(q.count(name));
    const count = Number(row?.count);
    if (!Number.isSafeInteger(count)) throw new Error(`The hub returned no row count for ${project.database}.${name}.`);
    tables.push({ name, rows: count });
  }
  const branches = await query(q.branches);
  const commits = await query(q.commits);
  const rows = {} as Record<ReadTable, BeadsRow[]>;
  for (const table of READ_TABLES) rows[table] = names.includes(table) ? await query(q.rows(table)) : [];
  const diffs = {} as Record<HistoryTable, BeadsRow[]>;
  for (const table of HISTORY_TABLES) diffs[table] = names.includes(table) ? await query(q.diff(table)) : [];
  const workingAfter = single(await query(q.working), `working set hash for ${project.database}`);
  if (workingAfter !== workingBefore) {
    throw new Error(
      `${project.database} changed while the export read it, so the export is not one consistent copy. Run it again, or stop writers first.`,
    );
  }
  return {
    database: project.database,
    key: project.key,
    name: project.name,
    id,
    prefix,
    tables,
    branches,
    commits,
    rows,
    diffs,
  };
}

export async function exportHub(hub: HubFile, query: Query, now: () => Date = () => new Date()): Promise<BeadsExport> {
  const doltVersion = single(await query(VERSION_QUERY), 'Dolt version');
  const projects: BeadsProject[] = [];
  for (const project of hub.projects) projects.push(await exportProject(project, query));
  return { format: EXPORT_FORMAT, exportedAt: now().toISOString(), doltVersion, projects };
}
