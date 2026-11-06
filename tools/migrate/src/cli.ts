/**
 * The migration commands. tools/migrate/README.md describes each one, what
 * it reads and what it writes.
 *
 *   node tools/migrate/src/cli.ts export --hub <hub.json> --describe
 *   node tools/migrate/src/cli.ts export --hub <hub.json> --out <export.json>
 *   node tools/migrate/src/cli.ts import --from <export.json> --persist-to <folder> [--check]
 *   node tools/migrate/src/cli.ts verify --from <export.json> --persist-to <folder>
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readExport, type BeadsExport } from './beads.ts';
import { localD1, type Database, type LocalD1 } from './d1.ts';
import { doltClient } from './dolt-client.ts';
import { describeExport, exportHub, readHubFile } from './export.ts';
import { planImport, type ImportPlan, type Refusal } from './plan.ts';
import { importStatements, oversizedStatements } from './sql.ts';
import { verify } from './verify.ts';

/** D1's largest database on the Workers Paid plan (developers.cloudflare.com/d1/platform/limits). */
export const D1_DATABASE_LIMIT = 500 * 1000 * 1000;

export const DEFAULT_CONFIG = fileURLToPath(new URL('../../../workers/api/wrangler.jsonc', import.meta.url));

export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** The database a command writes or reads; wrangler's local D1 unless a test supplies another. */
  readonly database?: (target: LocalD1) => Database;
}

const USAGE = `Usage:
  cli.ts export --hub <hub.json> --describe
  cli.ts export --hub <hub.json> --out <export.json>
  cli.ts import --from <export.json> --persist-to <folder> [--database ntasks] [--config <wrangler.jsonc>] [--check]
  cli.ts verify --from <export.json> --persist-to <folder> [--database ntasks] [--config <wrangler.jsonc>]`;

class UsageError extends Error {}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function sizeLine(bytes: number | null): string {
  if (bytes === null) return 'Database size: unknown.';
  const share = ((bytes / D1_DATABASE_LIMIT) * 100).toFixed(1);
  return `Database size: ${megabytes(bytes)}, ${share}% of D1's 500 MB limit for one database.`;
}

function printRefusals(refusals: readonly Refusal[], io: Io) {
  const subjects = new Set(refusals.map((refusal) => refusal.subject));
  io.err(
    `Refused: ${count(refusals.length)} problems in ${count(subjects.size)} tasks or projects. Nothing was written.`,
  );
  for (const refusal of refusals) io.err(`- ${refusal.subject}: ${refusal.reason}`);
}

function planSummary(plan: ImportPlan): string {
  return [
    `${count(plan.projects.length)} projects`,
    `${count(plan.tasks.length)} tasks`,
    `${count(plan.events.length)} history events`,
    `${count(plan.comments.length)} comments`,
    `${count(plan.edges.length)} links`,
    `${count(plan.labels.length)} labels`,
  ].join(', ');
}

function option(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = values[name];
  if (typeof value !== 'string' || value === '') throw new UsageError(`--${name} is required.`);
  return value;
}

async function loadExport(file: string): Promise<BeadsExport> {
  return readExport(await readFile(file, 'utf8'));
}

function target(values: Record<string, string | boolean | undefined>): LocalD1 {
  return {
    database: typeof values.database === 'string' ? values.database : 'ntasks',
    persistTo: path.resolve(option(values, 'persist-to')),
    config: path.resolve(typeof values.config === 'string' ? values.config : DEFAULT_CONFIG),
  };
}

async function runExport(values: Record<string, string | boolean | undefined>, io: Io): Promise<number> {
  const hub = readHubFile(await readFile(option(values, 'hub'), 'utf8'));
  if (values.describe === true) {
    io.out(describeExport(hub));
    return 0;
  }
  const out = option(values, 'out');
  if (existsSync(out)) {
    io.err(`Refused: ${out} already exists. The export never writes over a file.`);
    return 1;
  }
  const client = await doltClient(hub);
  let data: BeadsExport;
  try {
    data = await exportHub(hub, client.read);
  } finally {
    await client.close();
  }
  // The export holds the hub's task data: private to its owner, and never written over.
  await writeFile(out, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: 'wx' });
  for (const project of data.projects) {
    io.out(
      `${project.key} (${project.database}): ${count(project.rows.issues.length)} tasks, ${count(project.rows.comments.length)} comments, ` +
        `${count(project.commits.length)} commits, ${count(project.diffs.issues.length)} task changes.`,
    );
  }
  io.out(`Wrote ${out}. It holds task data: keep it private.`);
  return 0;
}

async function runImport(values: Record<string, string | boolean | undefined>, io: Io): Promise<number> {
  const data = await loadExport(option(values, 'from'));
  const { plan, refusals } = planImport(data);
  if (plan === null) {
    printRefusals(refusals, io);
    return 1;
  }
  const statements = importStatements(plan);
  const oversized = oversizedStatements(statements);
  if (values.check === true) {
    io.out(`The export imports: ${planSummary(plan)}. Nothing was written.`);
    if (oversized > 0)
      io.out(`${count(oversized)} statements are longer than D1 accepts from a remote client (100 KB).`);
    return 0;
  }
  const where = target(values);
  const db = (io.database ?? localD1)(where);
  await db.migrate();
  const [row] = await db.all('SELECT (SELECT COUNT(*) FROM projects) + (SELECT COUNT(*) FROM tasks) AS n');
  if (Number(row?.n) !== 0) {
    io.err(
      `Refused: ${db.description} already holds projects or tasks. The import writes only into an empty database.`,
    );
    return 1;
  }
  await db.run(statements);
  io.out(`Imported ${planSummary(plan)} into ${db.description}.`);
  io.out(sizeLine(await db.size()));
  if (oversized > 0) io.out(`${count(oversized)} statements are longer than D1 accepts from a remote client (100 KB).`);
  io.out('Next: run verify with the same --from and --persist-to.');
  return 0;
}

async function runVerify(values: Record<string, string | boolean | undefined>, io: Io): Promise<number> {
  const data = await loadExport(option(values, 'from'));
  const { plan, refusals } = planImport(data);
  if (plan === null) {
    io.err('The export does not import, so there is nothing to verify.');
    printRefusals(refusals, io);
    return 1;
  }
  const db = (io.database ?? localD1)(target(values));
  const report = await verify(data, plan, db);
  const totals = report.totals;
  io.out(`Verified ${db.description} against ${String(values.from)}.`);
  io.out(
    `D1 holds ${count(totals.projects)} projects, ${count(totals.tasks)} tasks, ${count(totals.events)} history events, ` +
      `${count(totals.comments)} comments, ${count(totals.links)} links and ${count(totals.labels)} labels; ` +
      `${count(report.approvals)} approvals, ${count(report.decisions)} decisions and ${count(report.frozenCards)} frozen cards among them.`,
  );
  io.out('Tasks per project and status (export / D1):');
  for (const entry of report.counts)
    io.out(`  ${entry.project}  ${entry.status}: ${count(entry.expected)} / ${count(entry.actual)}`);
  io.out(sizeLine(await db.size()));
  if (report.differences.length === 0) {
    io.out('0 differences.');
    return 0;
  }
  io.err(`${count(report.differences.length)} differences:`);
  for (const difference of report.differences) io.err(`- ${difference.subject}: ${difference.difference}`);
  return 1;
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  try {
    const [command, ...rest] = argv;
    const { values } = parseArgs({
      args: rest,
      options: {
        hub: { type: 'string' },
        out: { type: 'string' },
        describe: { type: 'boolean' },
        from: { type: 'string' },
        'persist-to': { type: 'string' },
        database: { type: 'string' },
        config: { type: 'string' },
        check: { type: 'boolean' },
      },
      strict: true,
    });
    if (command === 'export') return await runExport(values, io);
    if (command === 'import') return await runImport(values, io);
    if (command === 'verify') return await runVerify(values, io);
    throw new UsageError(command === undefined ? 'Name a command.' : `Unknown command ${command}.`);
  } catch (error) {
    if (error instanceof UsageError || (error as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      io.err(`${(error as Error).message}\n${USAGE}`);
      return 2;
    }
    io.err((error as Error).message);
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
