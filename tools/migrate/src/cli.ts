/**
 * The migration commands. tools/migrate/README.md describes each one, what
 * it reads and what it writes.
 *
 *   node tools/migrate/src/cli.ts export --hub <hub.json> --describe
 *   node tools/migrate/src/cli.ts export --hub <hub.json> --out <export.json>
 *   node tools/migrate/src/cli.ts import --from <export.json> --check
 *   node tools/migrate/src/cli.ts import --from <export.json> --store <new-file.sqlite>
 *   node tools/migrate/src/cli.ts verify --from <export.json> --store <file.sqlite>
 *   node tools/migrate/src/cli.ts backup --api <https://address> --token-file <file> --out <backup.json>
 *   node tools/migrate/src/cli.ts restore --from <backup.json> --store <new-file.sqlite>
 *   node tools/migrate/src/cli.ts load --api <https://address> --token-file <file> --from <export.json | backup.json>
 *   node tools/migrate/src/cli.ts verify --from <backup.json> --store <file.sqlite>
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BACKUP_FORMAT, type BackupFile } from '@ntasks/domain';
import {
  backupFrom,
  backupSummary,
  backupUrl,
  checkMigrations,
  downloadBackup,
  restoreBackup,
  rowCounts,
} from './backup.ts';
import { exportFrom, type BeadsExport } from './beads.ts';
import { doltClient } from './dolt-client.ts';
import { describeExport, exportHub, readHubFile } from './export.ts';
import { isJsonObject } from './json.ts';
import { checkReadable, copyAsBackup, loadIntoStore, verifyLoaded } from './load.ts';
import { openLocalStore, storeMigrations, type LocalStore } from './local-store.ts';
import { planImport, type ImportPlan, type Refusal } from './plan.ts';
import { verify, verifyBackup, type Difference } from './verify.ts';

/** The free plan's limits an import or a backup meets (docs/architecture.md): data that Durable Objects store, in all, and rows the task store writes and reads in a day. */
export const FREE_PLAN = Object.freeze({
  storedBytes: 5 * 1000 ** 3,
  rowsWrittenPerDay: 100_000,
  rowsReadPerDay: 5_000_000,
});

export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** What the commands reach outside the machine: only `backup` uses it. */
export interface Network {
  readonly fetch: typeof fetch;
}

const USAGE = `Usage:
  cli.ts export --hub <hub.json> --describe
  cli.ts export --hub <hub.json> --out <export.json>
  cli.ts import --from <export.json> --check
  cli.ts import --from <export.json> --store <new-file.sqlite>
  cli.ts verify --from <export.json> --store <file.sqlite>
  cli.ts backup --api <https://address> --token-file <file> --out <backup.json>
  cli.ts restore --from <backup.json> --store <new-file.sqlite>
  cli.ts load --api <https://address> --token-file <file> --from <export.json | backup.json>
  cli.ts verify --from <backup.json> --store <file.sqlite>`;

class UsageError extends Error {}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function share(part: number, whole: number): string {
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/** What a store holding the import costs against the free plan's limits. */
function costLines(store: LocalStore): string[] {
  const bytes = store.size();
  const written = store.rowsWrittenAtMost();
  return [
    `Size: ${(bytes / 1_000_000).toFixed(1)} MB, ${share(bytes, FREE_PLAN.storedBytes)} of the 5 GB the free plan stores.`,
    `Rows written to load it: at most ${count(written)}, ${share(written, FREE_PLAN.rowsWrittenPerDay)} of the 100,000 the free plan writes in a day.`,
  ];
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
    `${count(plan.task_events.length)} history events`,
    `${count(plan.task_comments.length)} comments`,
    `${count(plan.task_edges.length)} links`,
    `${count(plan.task_external_links?.length ?? 0)} external links`,
    `${count(plan.task_labels.length)} labels`,
  ].join(', ');
}

function option(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = values[name];
  if (typeof value !== 'string' || value === '') throw new UsageError(`--${name} is required.`);
  return value;
}

/** An export or a backup file, by its format. */
async function loadFile(
  file: string,
): Promise<{ kind: 'export'; data: BeadsExport } | { kind: 'backup'; data: BackupFile }> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (isJsonObject(value) && value.format === BACKUP_FORMAT) return { kind: 'backup', data: backupFrom(value) };
  return { kind: 'export', data: exportFrom(value) };
}

async function loadExport(file: string): Promise<BeadsExport> {
  const loaded = await loadFile(file);
  if (loaded.kind !== 'export') throw new UsageError(`${file} is a backup: load it with restore.`);
  return loaded.data;
}

function printDifferences(differences: readonly Difference[], io: Io): number {
  if (differences.length === 0) {
    io.out('0 differences.');
    return 0;
  }
  io.err(`${count(differences.length)} differences:`);
  for (const difference of differences) io.err(`- ${difference.subject}: ${difference.difference}`);
  return 1;
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
  const check = values.check === true;
  const file = check ? ':memory:' : option(values, 'store');
  if (check && values.store !== undefined) throw new UsageError('Give --check or --store, not both.');
  const { plan, refusals, leftOut } = planImport(data);
  if (plan === null) {
    printRefusals(refusals, io);
    return 1;
  }
  const store = await openLocalStore(check ? file : path.resolve(file), { create: true });
  try {
    store.load(plan);
    if (check) {
      io.out(`The export imports: ${planSummary(plan)}. Nothing was written.`);
    } else {
      io.out(`Imported ${planSummary(plan)} into ${store.description}.`);
    }
    for (const line of costLines(store)) io.out(line);
    if (leftOut.length > 0) {
      io.out(`Left out by the owner's choice (${count(leftOut.length)}):`);
      for (const entry of leftOut) io.out(`- ${entry.subject}: ${entry.what}`);
    }
    if (!check) io.out('Next: run verify with the same --from and --store.');
    return 0;
  } finally {
    store.close();
  }
}

async function runVerify(values: Record<string, string | boolean | undefined>, io: Io): Promise<number> {
  const loaded = await loadFile(option(values, 'from'));
  const file = path.resolve(option(values, 'store'));
  if (loaded.kind === 'backup') {
    const store = await openLocalStore(file, { create: false });
    try {
      return await checkBackup(loaded.data, store, String(values.from), io);
    } finally {
      store.close();
    }
  }
  const data = loaded.data;
  const { plan, refusals } = planImport(data);
  if (plan === null) {
    io.err('The export does not import, so there is nothing to verify.');
    printRefusals(refusals, io);
    return 1;
  }
  const store = await openLocalStore(file, { create: false });
  try {
    const report = await verify(data, plan, (table) => store.read(table));
    const totals = report.totals;
    io.out(`Verified ${store.description} against ${String(values.from)}.`);
    io.out(
      `The store holds ${count(totals.projects)} projects, ${count(totals.tasks)} tasks, ${count(totals.events)} history events, ` +
        `${count(totals.comments)} comments, ${count(totals.links)} links, ${count(totals.externalLinks)} external links and ${count(totals.labels)} labels; ` +
        `${count(report.approvals)} approvals, ${count(report.decisions)} decisions and ${count(report.frozenCards)} frozen cards among them.`,
    );
    io.out('Tasks per project and status (export / store):');
    for (const entry of report.counts)
      io.out(`  ${entry.project}  ${entry.status}: ${count(entry.expected)} / ${count(entry.actual)}`);
    for (const line of costLines(store)) io.out(line);
    return printDifferences(report.differences, io);
  } finally {
    store.close();
  }
}

/** Compares a store copy with the backup it was restored from, and prints the result. */
async function checkBackup(backup: BackupFile, store: LocalStore, from: string, io: Io): Promise<number> {
  const report = await verifyBackup(backup, (table) => store.read(table));
  io.out(`Verified ${store.description} against the backup ${from}, taken at ${backup.takenAt}.`);
  io.out(`The store holds ${backupSummary(report.rows)}.`);
  io.out('Tasks per project and status (backup / store):');
  for (const entry of report.counts)
    io.out(`  ${entry.project}  ${entry.status}: ${count(entry.expected)} / ${count(entry.actual)}`);
  for (const line of costLines(store)) io.out(line);
  return printDifferences(report.differences, io);
}

/** The credential in --token-file, without the final line break. */
async function tokenFrom(values: Record<string, string | boolean | undefined>): Promise<string> {
  const token = (await readFile(option(values, 'token-file'), 'utf8')).replace(/\r?\n$/u, '');
  if (token === '') throw new UsageError('The token file is empty.');
  return token;
}

/**
 * Loads an export or a backup into the deployed, empty store at --api: into a
 * local copy first, verified there; then page by page into the store,
 * committed in one transaction; then read back and verified against the file.
 */
async function runLoad(
  values: Record<string, string | boolean | undefined>,
  io: Io,
  network: Network,
): Promise<number> {
  const api = option(values, 'api');
  const from = option(values, 'from');
  backupUrl(api);
  const token = await tokenFrom(values);
  const loaded = await loadFile(from);
  const copy = await openLocalStore(':memory:', { create: true });
  try {
    let plan: ImportPlan | null = null;
    if (loaded.kind === 'export') {
      const planned = planImport(loaded.data);
      if (planned.plan === null) {
        printRefusals(planned.refusals, io);
        return 1;
      }
      plan = planned.plan;
      copy.load(plan);
      const report = await verify(loaded.data, plan, (table) => copy.read(table));
      if (report.differences.length > 0) {
        io.err('The import does not verify in a local copy, so nothing was sent.');
        return printDifferences(report.differences, io);
      }
    } else {
      checkMigrations(loaded.data, storeMigrations());
      restoreBackup(loaded.data, copy);
      const report = await verifyBackup(loaded.data, (table) => copy.read(table));
      if (report.differences.length > 0) {
        io.err('The backup does not verify in a local copy, so nothing was sent.');
        return printDifferences(report.differences, io);
      }
    }
    const rows = copyAsBackup(copy, new Date().toISOString());
    io.out(`Checked in a local copy of the store: ${backupSummary(rowCounts(rows.tables))}.`);
    const target = { api, token, fetch: network.fetch };
    await checkReadable(target);
    const result = await loadIntoStore(rows, target);
    io.out(
      `Loaded ${count(result.rows)} rows into ${api} in ${count(result.pages)} pages, written in one transaction: ` +
        `${count(result.rowsWritten)} rows written as Cloudflare counts them.`,
    );
    let read: Awaited<ReturnType<typeof verifyLoaded>>;
    try {
      read = await verifyLoaded(rows, target);
    } catch (error) {
      io.err(
        `The load landed: the store at ${api} now holds the ${count(result.rows)} rows sent, so loading again is refused. ` +
          `Reading it back to verify them failed: ${(error as Error).message}`,
      );
      io.err(
        `Verify it when the store can be read: back it up with backup --api ${api} --token-file <file> --out <file>, ` +
          `restore that file into a new store copy with restore, then run verify --from ${from} --store <that copy>.`,
      );
      return 1;
    }
    const { report, stored } = read;
    io.out(`Read the store back through its backup route: ${backupSummary(report.rows)}.`);
    io.out('Tasks per project and status (file / store):');
    for (const entry of report.counts)
      io.out(`  ${entry.project}  ${entry.status}: ${count(entry.expected)} / ${count(entry.actual)}`);
    // The store against the file itself: the export, through the import's verifier, or the backup, row by row.
    const differences =
      loaded.kind === 'export'
        ? (await verify(loaded.data, plan!, (table) => stored.tables[table])).differences
        : (await verifyBackup(loaded.data, (table) => stored.tables[table])).differences;
    return printDifferences([...report.differences, ...differences], io);
  } finally {
    copy.close();
  }
}

async function runBackup(
  values: Record<string, string | boolean | undefined>,
  io: Io,
  network: Network,
): Promise<number> {
  const api = option(values, 'api');
  const out = option(values, 'out');
  backupUrl(api);
  const token = await tokenFrom(values);
  if (existsSync(out)) {
    io.err(`Refused: ${out} already exists. The backup never writes over a file.`);
    return 1;
  }
  const { file, pages } = await downloadBackup({
    api,
    token,
    fetch: network.fetch,
    onRestart: (attempt) => io.err(`The store was written to during attempt ${attempt}; starting again.`),
  });
  // The backup holds every task: private to its owner, and never written over.
  await writeFile(out, `${JSON.stringify(file)}\n`, { mode: 0o600, flag: 'wx' });
  const rows = Object.values(file.tables).reduce((sum, list) => sum + list.length, 0);
  io.out(
    `Backed up ${backupSummary(rowCounts(file.tables))}, as the store stood at ${file.takenAt}, in ${count(pages)} pages.`,
  );
  io.out(
    `The store read about ${count(rows)} rows for it, ${share(rows, FREE_PLAN.rowsReadPerDay)} of the 5,000,000 it may read in a day.`,
  );
  io.out(`Wrote ${out}. It holds task data: keep it private.`);
  io.out('Next: check it with restore --from <backup.json> --store <new-file.sqlite>.');
  return 0;
}

async function runRestore(values: Record<string, string | boolean | undefined>, io: Io): Promise<number> {
  const from = option(values, 'from');
  const loaded = await loadFile(from);
  if (loaded.kind !== 'backup') throw new UsageError(`${from} is not a backup: import an export with import.`);
  // Checked before the store file is made, so a refused restore leaves nothing behind.
  checkMigrations(loaded.data, storeMigrations());
  const store = await openLocalStore(path.resolve(option(values, 'store')), { create: true });
  try {
    restoreBackup(loaded.data, store);
    io.out(`Restored ${backupSummary(rowCounts(loaded.data.tables))} into ${store.description}.`);
    return await checkBackup(loaded.data, store, from, io);
  } finally {
    store.close();
  }
}

export async function main(
  argv: readonly string[],
  io: Io,
  network: Network = { fetch: globalThis.fetch },
): Promise<number> {
  try {
    const [command, ...rest] = argv;
    const { values } = parseArgs({
      args: rest,
      options: {
        hub: { type: 'string' },
        out: { type: 'string' },
        describe: { type: 'boolean' },
        from: { type: 'string' },
        store: { type: 'string' },
        check: { type: 'boolean' },
        api: { type: 'string' },
        'token-file': { type: 'string' },
      },
      strict: true,
    });
    if (command === 'export') return await runExport(values, io);
    if (command === 'import') return await runImport(values, io);
    if (command === 'verify') return await runVerify(values, io);
    if (command === 'backup') return await runBackup(values, io, network);
    if (command === 'restore') return await runRestore(values, io);
    if (command === 'load') return await runLoad(values, io, network);
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
