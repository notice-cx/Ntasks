/**
 * The migration commands. tools/migrate/README.md describes each one, what
 * it reads and what it writes.
 *
 *   node tools/migrate/src/cli.ts export --hub <hub.json> --describe
 *   node tools/migrate/src/cli.ts export --hub <hub.json> --out <export.json>
 *   node tools/migrate/src/cli.ts import --from <export.json> --check
 *   node tools/migrate/src/cli.ts import --from <export.json> --store <new-file.sqlite>
 *   node tools/migrate/src/cli.ts verify --from <export.json> --store <file.sqlite>
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readExport, type BeadsExport } from './beads.ts';
import { doltClient } from './dolt-client.ts';
import { describeExport, exportHub, readHubFile } from './export.ts';
import { openLocalStore, type LocalStore } from './local-store.ts';
import { planImport, type ImportPlan, type Refusal } from './plan.ts';
import { verify } from './verify.ts';

/** The free plan's limits an import meets (docs/architecture.md): data that Durable Objects store, in all, and rows the task store writes in a day. */
export const FREE_PLAN = Object.freeze({ storedBytes: 5 * 1000 ** 3, rowsWrittenPerDay: 100_000 });

export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const USAGE = `Usage:
  cli.ts export --hub <hub.json> --describe
  cli.ts export --hub <hub.json> --out <export.json>
  cli.ts import --from <export.json> --check
  cli.ts import --from <export.json> --store <new-file.sqlite>
  cli.ts verify --from <export.json> --store <file.sqlite>`;

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
    `${count(plan.task_labels.length)} labels`,
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
  const data = await loadExport(option(values, 'from'));
  const file = path.resolve(option(values, 'store'));
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
        `${count(totals.comments)} comments, ${count(totals.links)} links and ${count(totals.labels)} labels; ` +
        `${count(report.approvals)} approvals, ${count(report.decisions)} decisions and ${count(report.frozenCards)} frozen cards among them.`,
    );
    io.out('Tasks per project and status (export / store):');
    for (const entry of report.counts)
      io.out(`  ${entry.project}  ${entry.status}: ${count(entry.expected)} / ${count(entry.actual)}`);
    for (const line of costLines(store)) io.out(line);
    if (report.differences.length === 0) {
      io.out('0 differences.');
      return 0;
    }
    io.err(`${count(report.differences.length)} differences:`);
    for (const difference of report.differences) io.err(`- ${difference.subject}: ${difference.difference}`);
    return 1;
  } finally {
    store.close();
  }
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
        store: { type: 'string' },
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
