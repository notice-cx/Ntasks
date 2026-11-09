/**
 * `ntasks deploy`: deploys the release this package holds to a Cloudflare
 * account, or updates the deployment there. It keeps no state of its own: it
 * finds the Worker and its D1 database in the account by name, and reads the
 * deployed release from the tag each deploy gives the Worker's version.
 */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { databaseBinding, writeDeployConfig, type Release } from './release.ts';
import { parseJson, WranglerError, type Io, type Wrangler } from './wrangler.ts';

export interface DeployRequest {
  /** The Worker's name and its D1 database's name. */
  readonly name: string;
  /** The Cloudflare account, by id or name. */
  readonly account?: string | undefined;
  readonly dryRun: boolean;
}

export interface DeployContext {
  readonly release: Release;
  readonly wrangler: Wrangler;
  readonly io: Io;
  /** A folder of this run's own, for the files wrangler reads: the configuration and, on a first deploy, the secret. */
  readonly workDir: string;
  /** CLOUDFLARE_ACCOUNT_ID from the environment, the account wrangler would use. */
  readonly accountFromEnv?: string | undefined;
  readonly makeSecret?: () => string;
}

/** A refusal or a stop the person can act on, printed without a stack. */
export class Stop extends Error {}

interface Account {
  readonly id: string;
  readonly name: string;
}

interface Database {
  readonly uuid: string;
  readonly name: string;
}

/** The Worker as Cloudflare shows it: absent, or present with the release its current version was deployed from, when that release is known. */
type WorkerState = { readonly exists: false } | { readonly exists: true; readonly release: string | undefined };

/** The table wrangler records applied D1 migrations in. */
const MIGRATIONS_TABLE = 'd1_migrations';

/** Cloudflare's error code for a Worker that does not exist in the account. */
const WORKER_NOT_FOUND = '[code: 10007]';

/** Each deploy tags the Worker's version with the release, as `v` and its number. */
export function releaseTag(version: string): string {
  return `v${version}`;
}

function releaseOfTag(tag: unknown): string | undefined {
  if (typeof tag !== 'string') return undefined;
  return /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(tag)?.[1];
}

/** Orders two release numbers: negative when a is older, positive when newer. A pre-release comes before its release. */
export function compareReleases(a: string, b: string): number {
  const [coreA = '', preA] = a.split('-', 2);
  const [coreB = '', preB] = b.split('-', 2);
  const numbersA = coreA.split('.').map(Number);
  const numbersB = coreB.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (numbersA[index] ?? 0) - (numbersB[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA < preB ? -1 : 1;
}

/** A value for AUTH_SECRET as `openssl rand -base64 32` makes one: 44 characters. */
export function makeAuthSecret(): string {
  return randomBytes(32).toString('base64');
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asAccounts(value: unknown): Account[] {
  const accounts = isRecord(value) && Array.isArray(value['accounts']) ? value['accounts'] : [];
  return accounts.filter(
    (account): account is Account =>
      isRecord(account) && typeof account['id'] === 'string' && typeof account['name'] === 'string',
  );
}

/** The accounts the login reaches, or undefined when wrangler is not logged in. */
async function whoami(wrangler: Wrangler): Promise<Account[] | undefined> {
  const args = ['whoami', '--json'];
  const output = await wrangler.capture(args);
  if (output.code === 0) return asAccounts(parseJson(output.stdout));
  if (/"loggedIn"\s*:\s*false/u.test(output.stdout + output.stderr)) return undefined;
  throw new WranglerError(args, output);
}

async function signIn(context: DeployContext): Promise<Account[]> {
  const known = await whoami(context.wrangler);
  if (known) return known;
  context.io.out('Sign in to Cloudflare in the browser window that opens.');
  const code = await context.wrangler.attach(['login']);
  const accounts = code === 0 ? await whoami(context.wrangler) : undefined;
  if (!accounts) throw new Stop('The Cloudflare login did not finish, so nothing was deployed. Run the command again.');
  return accounts;
}

function accountLine(account: Account): string {
  return `  ${account.name} (${account.id})`;
}

function chooseAccount(accounts: readonly Account[], wanted: string | undefined, fromEnv: string | undefined): Account {
  if (wanted !== undefined) {
    const chosen = accounts.find((account) => account.id === wanted || account.name === wanted);
    if (chosen) return chosen;
    throw new Stop(
      [
        `Your Cloudflare login reaches no account named or numbered ${wanted}. It reaches:`,
        ...accounts.map(accountLine),
      ].join('\n'),
    );
  }
  if (fromEnv !== undefined && fromEnv !== '') {
    return accounts.find((account) => account.id === fromEnv) ?? { id: fromEnv, name: fromEnv };
  }
  const [only, ...others] = accounts;
  if (only && others.length === 0) return only;
  if (!only) throw new Stop('Your Cloudflare login reaches no account.');
  throw new Stop(
    [
      `Your Cloudflare login reaches ${accounts.length} accounts. Choose one with --account and its id or name:`,
      ...accounts.map(accountLine),
    ].join('\n'),
  );
}

async function findDatabase(wrangler: Wrangler, name: string): Promise<Database | undefined> {
  const listed = await wrangler.json(['d1', 'list', '--json']);
  if (!Array.isArray(listed)) return undefined;
  return listed.find(
    (database): database is Database =>
      isRecord(database) && database['name'] === name && typeof database['uuid'] === 'string',
  );
}

async function findWorker(wrangler: Wrangler, name: string): Promise<WorkerState> {
  const args = ['deployments', 'status', '--name', name, '--json'];
  const output = await wrangler.capture(args);
  const text = output.stdout + output.stderr;
  if (output.code !== 0) {
    if (text.includes(WORKER_NOT_FOUND)) return { exists: false };
    if (text.includes('has no deployments')) return { exists: true, release: undefined };
    throw new WranglerError(args, output);
  }
  const deployment = parseJson(output.stdout);
  const versions = isRecord(deployment) && Array.isArray(deployment['versions']) ? deployment['versions'] : [];
  // The version that serves the most traffic; a deploy gives one version all of it.
  const [current] = versions
    .filter((version): version is { version_id: string; percentage: number } => isRecord(version))
    .sort((a, b) => b.percentage - a.percentage);
  if (!current) return { exists: true, release: undefined };
  const version = await wrangler.json(['versions', 'view', current.version_id, '--name', name, '--json']);
  const annotations = isRecord(version) && isRecord(version['annotations']) ? version['annotations'] : {};
  return { exists: true, release: releaseOfTag(annotations['workers/tag']) };
}

async function appliedMigrations(wrangler: Wrangler, binding: string, configFile: string): Promise<string[]> {
  const args = [
    'd1',
    'execute',
    binding,
    '--remote',
    '--json',
    '--command',
    `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`,
    '--config',
    configFile,
  ];
  const output = await wrangler.capture(args);
  if (output.code !== 0) {
    // A database that never had a migration applied has no table to record them in.
    if ((output.stdout + output.stderr).includes(`no such table: ${MIGRATIONS_TABLE}`)) return [];
    throw new WranglerError(args, output);
  }
  const results = parseJson(output.stdout);
  if (!Array.isArray(results)) return [];
  return results.flatMap((result: unknown) =>
    isRecord(result) && Array.isArray(result['results'])
      ? result['results'].flatMap((row: unknown) =>
          isRecord(row) && typeof row['name'] === 'string' ? [row['name']] : [],
        )
      : [],
  );
}

/** The addresses the deploy reached, from the entry wrangler writes to WRANGLER_OUTPUT_FILE_PATH. */
async function deployedAddresses(outputFile: string): Promise<string[]> {
  let text = '';
  try {
    text = await readFile(outputFile, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => parseJson(line))
    .filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry['type'] === 'deploy')
    .flatMap((entry) => (Array.isArray(entry['targets']) ? entry['targets'] : []))
    .filter((target): target is string => typeof target === 'string' && target.startsWith('https://'));
}

/** The setup page's steps. Each address ends its line, so a terminal's link takes nothing after it. */
function setupLines(address: string | undefined, secret: string): string[] {
  return [
    'Next, set up sign-in with GitHub:',
    address ? `1. Open ${address}/sign-in` : '1. Open /sign-in at the Worker’s address.',
    `2. Enter this AUTH_SECRET:  ${secret}`,
    '3. Choose Create the GitHub App.',
    '',
    'Keep a copy of AUTH_SECRET. This command does not show it again, and Cloudflare does not show a secret once it is set.',
  ];
}

export async function deploy(request: DeployRequest, context: DeployContext): Promise<void> {
  const { release, io, workDir } = context;
  const { name } = request;
  const { version } = release;
  const binding = databaseBinding(release);

  const account = chooseAccount(await signIn(context), request.account, context.accountFromEnv);
  const wrangler = context.wrangler.withEnv({ CLOUDFLARE_ACCOUNT_ID: account.id });

  const database = await findDatabase(wrangler, name);
  const worker = await findWorker(wrangler, name);
  if (worker.exists && !database) {
    throw new Stop(
      `The account has a Worker named ${name} but no D1 database of that name, so that Worker is not an Ntasks deployment. Nothing was changed. Choose another name with --name.`,
    );
  }
  const applied = database
    ? await appliedMigrations(
        wrangler,
        binding,
        await writeDeployConfig(release, { name, databaseId: database.uuid }, workDir),
      )
    : [];
  const pending = release.migrations.filter((migration) => !applied.includes(migration));

  const where = `the Worker ${name} on the Cloudflare account ${account.name}`;
  const from = worker.exists ? worker.release : undefined;
  if (!worker.exists) {
    io.out(`Deploy Ntasks ${version} as a new Worker, ${name}, on the Cloudflare account ${account.name}.`);
  } else if (from === version) io.out(`Deploy Ntasks ${version} again to ${where}.`);
  else if (from === undefined) {
    io.out(
      `Update ${where} to Ntasks ${version}. Its current version was not deployed by npx ntasks, so its release is unknown.`,
    );
  } else {
    io.out(`Update ${where} from Ntasks ${from} to ${version}.`);
    if (compareReleases(version, from) < 0) io.out(`${version} is older than the deployed ${from}.`);
  }
  io.out('');
  if (!database) io.out(`- Create the D1 database ${name}.`);
  io.out(
    pending.length === 0
      ? '- The D1 database has every migration of this release.'
      : `- Apply ${plural(pending.length, 'D1 migration', 'D1 migrations')}: ${pending.join(', ')}`,
  );
  io.out(
    worker.exists
      ? '- Deploy the Worker. Its secrets stay as they are.'
      : '- Make an AUTH_SECRET and deploy the Worker with it.',
  );
  io.out('');
  if (request.dryRun) {
    io.out('--dry-run: nothing was changed.');
    return;
  }

  let databaseId = database?.uuid;
  if (databaseId === undefined) {
    io.out(`Creating the D1 database ${name}…`);
    await wrangler.run(['d1', 'create', name]);
    databaseId = (await findDatabase(wrangler, name))?.uuid;
    if (databaseId === undefined)
      throw new Stop(`wrangler created the D1 database ${name}, but the account does not list it.`);
  }
  const configFile = await writeDeployConfig(release, { name, databaseId }, workDir);
  if (pending.length > 0) {
    io.out(`Applying ${plural(pending.length, 'D1 migration', 'D1 migrations')}…`);
    await wrangler.run(['d1', 'migrations', 'apply', binding, '--remote', '--config', configFile]);
  }

  const args = [
    'deploy',
    '--config',
    configFile,
    '--tag',
    releaseTag(version),
    '--message',
    `Ntasks ${version}, deployed with npx ntasks deploy`,
  ];
  // A new Worker gets its required secret with its first version; wrangler
  // refuses to deploy one without it. A later deploy keeps the secrets.
  const secret = worker.exists ? undefined : (context.makeSecret ?? makeAuthSecret)();
  if (secret !== undefined) {
    const secretsFile = path.join(workDir, 'secrets.json');
    await writeFile(secretsFile, JSON.stringify({ AUTH_SECRET: secret }), { mode: 0o600 });
    args.push('--secrets-file', secretsFile);
  }
  const outputFile = path.join(workDir, 'wrangler-output.json');
  io.out(`Deploying Ntasks ${version}…`);
  const code = await wrangler.withEnv({ WRANGLER_OUTPUT_FILE_PATH: outputFile }).attach(args);
  if (code !== 0) {
    // A deploy can stop after Cloudflare created the Worker with its secret,
    // as when the account has no workers.dev subdomain yet. The next run then
    // updates that Worker and never shows the secret, so show it now.
    if (secret !== undefined && (await findWorker(wrangler, name)).exists) {
      io.err(
        [
          `The deploy stopped after it created the Worker ${name} with an AUTH_SECRET. Run the command again to finish the deploy.`,
          '',
          ...setupLines(undefined, secret),
        ].join('\n'),
      );
    }
    throw new Stop(`The deploy stopped with exit code ${code}. Wrangler's output above shows why.`);
  }

  const [address] = await deployedAddresses(outputFile);
  io.out('');
  if (secret !== undefined) io.out(`Deployed Ntasks ${version}.`);
  else if (from === undefined || from === version) io.out(`Deployed Ntasks ${version} to the Worker ${name}.`);
  else io.out(`Updated the Worker ${name} from Ntasks ${from} to ${version}.`);
  io.out(
    address
      ? `Address: ${address}`
      : 'The Worker’s address is on the Workers & Pages page of the Cloudflare dashboard.',
  );
  if (secret !== undefined) {
    io.out('');
    for (const line of setupLines(address, secret)) io.out(line);
  }
}
