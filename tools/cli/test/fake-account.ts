// The Cloudflare account fake-wrangler.ts keeps, and the release folders the
// tests deploy.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.ts';
import { fakeRegistry } from './fake-registry.ts';

/** A binding of a Worker version, as Cloudflare lists it. */
export type FakeBinding =
  { name: string; type: 'd1'; id: string } | { name: string; type: 'durable_object_namespace'; class_name: string };

/** The bindings an Ntasks Worker's version has, with its D1 binding to this database. */
export function ntasksBindings(databaseId: string): FakeBinding[] {
  return [
    { name: 'DB', type: 'd1', id: databaseId },
    { name: 'TASK_STORE', type: 'durable_object_namespace', class_name: 'TaskStore' },
  ];
}

export interface FakeAccountState {
  loggedIn: boolean;
  subdomain: string;
  accounts: { id: string; name: string }[];
  /** applied is null while the database has no d1_migrations table. */
  databases: { accountId: string; uuid: string; name: string; applied: string[] | null }[];
  workers: {
    accountId: string;
    name: string;
    secrets: Record<string, string>;
    versions: { id: string; tag: string | null; message: string | null; bindings: FakeBinding[] }[];
    deployed: string | null;
  }[];
  /** The deploy creates the Worker's version, then stops, as when the account has no workers.dev subdomain. */
  failDeployAfterUpload?: boolean;
  /** After a deploy, reading the Worker's deployments fails, as when the network drops. */
  failLookupAfterDeploy?: boolean;
  calls: { args: string[]; account: string | null; cwd: string }[];
}

const FAKE_WRANGLER = fileURLToPath(new URL('./fake-wrangler.ts', import.meta.url));

export const EXAMPLE_ACCOUNT = { id: '0123456789abcdef0123456789abcdef', name: 'Example' };

export function emptyAccount(overrides: Partial<FakeAccountState> = {}): FakeAccountState {
  return {
    loggedIn: true,
    subdomain: 'example',
    accounts: [EXAMPLE_ACCOUNT],
    databases: [],
    workers: [],
    calls: [],
    ...overrides,
  };
}

/**
 * A release folder laid out as scripts/build.ts lays out the package, with
 * these D1 migrations. It is a new temporary folder, or `dir` when given.
 */
export async function release(version: string, migrations: readonly string[], dir?: string): Promise<string> {
  if (dir === undefined) dir = await mkdtemp(path.join(tmpdir(), 'ntasks-cli-release-'));
  else await mkdir(dir, { recursive: true });
  await mkdir(path.join(dir, 'worker'));
  await mkdir(path.join(dir, 'assets'));
  await mkdir(path.join(dir, 'migrations'));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'ntasks', version }));
  await writeFile(path.join(dir, 'worker', 'index.js'), 'export default { fetch() { return new Response("ok"); } };\n');
  await writeFile(path.join(dir, 'assets', 'index.html'), '<!doctype html><title>Ntasks</title>\n');
  for (const migration of migrations) {
    await writeFile(path.join(dir, 'migrations', migration), 'CREATE TABLE example (id TEXT);\n');
  }
  await writeFile(
    path.join(dir, 'wrangler.json'),
    JSON.stringify({
      name: 'ntasks',
      main: 'worker/index.js',
      base_dir: 'worker',
      no_bundle: true,
      find_additional_modules: true,
      compatibility_date: '2026-11-06',
      assets: { directory: 'assets', not_found_handling: 'single-page-application' },
      secrets: { required: ['AUTH_SECRET'] },
      durable_objects: { bindings: [{ name: 'TASK_STORE', class_name: 'TaskStore' }] },
      d1_databases: [{ binding: 'DB', database_name: 'ntasks', migrations_dir: 'migrations' }],
    }),
  );
  return dir;
}

export interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly before: FakeAccountState;
  readonly after: FakeAccountState;
}

export interface RunOptions {
  /** The npm registry the command reads the latest release from. Left out, a stand-in whose latest is the release's own. */
  readonly registry?: string;
  /** Answers the command's questions, as the person would in a terminal. Left out, there is no terminal. */
  readonly ask?: (question: string) => Promise<string>;
}

/** Runs the ntasks command against the account, with wrangler's terminal output kept apart from the command's own. */
export async function runCli(
  argv: readonly string[],
  releaseDir: string,
  account: FakeAccountState,
  options: RunOptions = {},
): Promise<Run> {
  const folder = await mkdtemp(path.join(tmpdir(), 'ntasks-cli-account-'));
  const stateFile = path.join(folder, 'account.json');
  await writeFile(stateFile, JSON.stringify(account));
  const out: string[] = [];
  const err: string[] = [];
  const ignore = () => undefined;
  const { version } = JSON.parse(await readFile(path.join(releaseDir, 'package.json'), 'utf8')) as { version: string };
  const ownRegistry = options.registry === undefined ? await fakeRegistry(version) : undefined;
  const code = await main(argv, {
    packageDir: releaseDir,
    wrangler: { program: process.execPath, args: [FAKE_WRANGLER] },
    // A secret in the caller's environment must not reach wrangler, which
    // would upload it in place of the secrets file's value.
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: folder,
      FAKE_CLOUDFLARE_STATE: stateFile,
      AUTH_SECRET: 'from-the-environment',
      npm_config_registry: options.registry ?? ownRegistry?.url,
    },
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    terminal: { out: ignore, err: ignore },
    ask: options.ask,
  }).finally(() => ownRegistry?.close());
  const after = JSON.parse(await readFile(stateFile, 'utf8')) as FakeAccountState;
  return { code, out: out.join('\n'), err: err.join('\n'), before: account, after };
}

/** The wrangler commands that change the account. */
export function writes(state: FakeAccountState): string[][] {
  const reads = ['whoami', 'login', 'd1 list', 'd1 execute', 'deployments status', 'versions view'];
  return state.calls.map((call) => call.args).filter((args) => !reads.some((read) => args.join(' ').startsWith(read)));
}
