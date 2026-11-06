/**
 * The export: reads a Beads hub on Dolt with read-only SELECT queries and
 * returns the export file's content. It never writes to the hub and never
 * runs Beads itself; `describeExport` lists every query it sends.
 *
 * Everything it keeps is read in one read-only transaction, so it is one
 * snapshot of the hub. Around that, it compares each database's branch head
 * and working set before and after, and refuses if any of them changed, so
 * the snapshots of different databases belong together too. Tables Dolt is
 * told to ignore, such as Beads' audit log, are part of the working set.
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
import { stepSql } from './dolt-client.ts';
import { isJsonObject } from './json.ts';

/** One project of the hub, as the hub file names it. */
export interface HubProject {
  /** The Dolt database that holds the project. */
  readonly database: string;
  /** The project's key and name in Ntasks. */
  readonly key: string;
  readonly name: string;
  /** The project's id in Ntasks. Give the NoticeOS project id, so the ids agents use keep
   * working; left out, it is the database's own `_project_id`. */
  readonly id?: string;
  /** When given, the export refuses a database whose `_project_id` differs. */
  readonly beadsProjectId?: string;
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

/**
 * Sends queries to the hub and returns each one's rows, in order. The queries
 * of one call run in one read-only transaction, so they read one snapshot of
 * the hub however it changes meanwhile.
 */
export type Reader = (queries: readonly string[]) => Promise<BeadsRow[][]>;

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
    const { database, key, name, id, beadsProjectId, prefix } = entry;
    if (typeof database !== 'string' || !DATABASE.test(database))
      throw new Error(`projects[${index}].database must be a database name.`);
    if (typeof key !== 'string' || typeof name !== 'string')
      throw new Error(`projects[${index}] needs a key and a name.`);
    for (const [field, value] of [
      ['id', id],
      ['beadsProjectId', beadsProjectId],
      ['prefix', prefix],
    ] as const) {
      if (value !== undefined && typeof value !== 'string')
        throw new Error(`projects[${index}].${field} must be text.`);
    }
    return {
      database,
      key,
      name,
      ...(typeof id === 'string' ? { id } : {}),
      ...(typeof beadsProjectId === 'string' ? { beadsProjectId } : {}),
      ...(typeof prefix === 'string' ? { prefix } : {}),
    };
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
    /** The branch head and the working set: a commit changes the first, any write the second. */
    state: `USE ${db}; SELECT DOLT_HASHOF('HEAD') AS head, DOLT_HASHOF_DB('WORKING') AS working`,
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
  const all = hub.projects.map((project) => ({ project, q: databaseQueries(project.database) }));
  const lines = [
    'The export sends only these read-only queries. Each step runs as one read-only transaction,',
    'which it ends with ROLLBACK.',
    '',
    `1. ${VERSION_QUERY}`,
    '',
    "2. Each database's branch head and working set:",
    ...all.map(({ q }) => `   ${q.state}`),
    '',
    '3. For each database, what it holds (one step per database):',
    ...all.flatMap(({ q }) => [`   ${q.projectId}`, `   ${q.prefix}`, `   ${q.tables}`]),
    '',
    '4. One snapshot of every database:',
    ...all.map(({ q }) => `   ${q.count('TABLE')}   (for each table step 3 found)`),
    ...all.flatMap(({ q }) => [
      `   ${q.projectId}`,
      `   ${q.prefix}`,
      `   ${q.tables}`,
      `   ${q.branches}`,
      `   ${q.commits}`,
      ...READ_TABLES.map((table) => `   ${q.rows(table)}   (if the table exists)`),
      ...HISTORY_TABLES.map((table) => `   ${q.diff(table)}   (if ${table} exists)`),
    ]),
    '',
    '5. Step 2 again. The export refuses if any database changed meanwhile.',
    '',
    `Each step runs as: ${hub.client.join(' ')} '<the step's statements>'`,
    'with these statements around its queries, shown here for a step of two queries:',
    `   ${stepSql(['<query 1>', '<query 2>'], '<marker>')}`,
    '<marker> is a new random value for each step. The marker queries only print it back,',
    'so the export can tell which output answers which query.',
  ];
  return lines.join('\n');
}

function single(rows: readonly BeadsRow[] | undefined, what: string): string {
  const value = rows?.length === 1 ? textOf(rows[0]!.value ?? rows[0]!.version) : null;
  if (value === null || value === undefined) throw new Error(`The hub returned no ${what}.`);
  return value;
}

/** Each database's branch head and working set hash, read at one moment. */
async function statesOf(hub: HubFile, read: Reader): Promise<string[]> {
  const results = await read(hub.projects.map((project) => databaseQueries(project.database).state));
  return hub.projects.map((project, index) => {
    const rows = results[index] ?? [];
    const head = textOf(rows[0]?.head);
    const working = textOf(rows[0]?.working);
    if (rows.length !== 1 || head === null || working === null) {
      throw new Error(`The hub returned no branch head and working set hash for ${project.database}.`);
    }
    return `${head} ${working}`;
  });
}

function tableNames(rows: readonly BeadsRow[] | undefined): string[] {
  return (rows ?? []).map((row) => textOf(row.name) ?? '').filter((name) => !name.startsWith('dolt_'));
}

export async function exportHub(hub: HubFile, read: Reader, now: () => Date = () => new Date()): Promise<BeadsExport> {
  const [version] = await read([VERSION_QUERY]);
  const doltVersion = single(version, 'Dolt version');
  const before = await statesOf(hub, read);

  const found: { project: HubProject; beadsProjectId: string; prefix: string; names: string[] }[] = [];
  for (const project of hub.projects) {
    const q = databaseQueries(project.database);
    const [idRows, prefixRows, tableRows] = await read([q.projectId, q.prefix, q.tables]);
    const beadsProjectId = single(idRows, `project id in ${project.database}`);
    const prefix = single(prefixRows, `prefix in ${project.database}`);
    if (project.beadsProjectId !== undefined && project.beadsProjectId !== beadsProjectId)
      throw new Error(
        `${project.database} holds project ${beadsProjectId}, not ${project.beadsProjectId} as the hub file says.`,
      );
    if (project.prefix !== undefined && project.prefix !== prefix)
      throw new Error(`${project.database} uses the prefix ${prefix}, not ${project.prefix} as the hub file says.`);
    found.push({ project, beadsProjectId, prefix, names: tableNames(tableRows) });
  }

  // Counting every table first makes the transaction read every database at its start.
  const queries: string[] = [];
  for (const { project, names } of found)
    queries.push(...names.map((name) => databaseQueries(project.database).count(name)));
  for (const { project, names } of found) {
    const q = databaseQueries(project.database);
    queries.push(q.projectId, q.prefix, q.tables, q.branches, q.commits);
    queries.push(...READ_TABLES.filter((table) => names.includes(table)).map(q.rows));
    queries.push(...HISTORY_TABLES.filter((table) => names.includes(table)).map(q.diff));
  }
  const results = await read(queries);
  const answer = (sql: string): BeadsRow[] => results[queries.indexOf(sql)] ?? [];

  const projects = found.map(({ project, beadsProjectId, prefix, names }): BeadsProject => {
    const q = databaseQueries(project.database);
    // What step 3 found must hold in the snapshot too, or a change made and undone could pair it with other data.
    if (
      single(answer(q.projectId), `project id in ${project.database}`) !== beadsProjectId ||
      single(answer(q.prefix), `prefix in ${project.database}`) !== prefix ||
      tableNames(answer(q.tables)).join() !== names.join()
    ) {
      throw new Error(
        `The project id, prefix or tables of ${project.database} changed while the export read them. Run it again, or stop writers first.`,
      );
    }
    const tables = names.map((name) => {
      const count = Number(answer(q.count(name))[0]?.count);
      if (!Number.isSafeInteger(count))
        throw new Error(`The hub returned no row count for ${project.database}.${name}.`);
      return { name, rows: count };
    });
    const rows = {} as Record<ReadTable, BeadsRow[]>;
    for (const table of READ_TABLES) rows[table] = names.includes(table) ? answer(q.rows(table)) : [];
    const diffs = {} as Record<HistoryTable, BeadsRow[]>;
    for (const table of HISTORY_TABLES) diffs[table] = names.includes(table) ? answer(q.diff(table)) : [];
    return {
      database: project.database,
      key: project.key,
      name: project.name,
      id: project.id ?? beadsProjectId,
      beadsProjectId,
      prefix,
      tables,
      branches: answer(q.branches),
      commits: answer(q.commits),
      rows,
      diffs,
    };
  });

  const after = await statesOf(hub, read);
  hub.projects.forEach((project, index) => {
    if (after[index] !== before[index]) {
      throw new Error(
        `${project.database} changed while the export read it, so the export is not one consistent copy. Run it again, or stop writers first.`,
      );
    }
  });
  return { format: EXPORT_FORMAT, exportedAt: now().toISOString(), doltVersion, projects };
}
