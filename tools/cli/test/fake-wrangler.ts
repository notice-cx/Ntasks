// A stand-in for wrangler 4.158 and the Cloudflare account behind it. It
// keeps the account in the JSON file FAKE_CLOUDFLARE_STATE names, answers the
// commands the deploy runs with the output wrangler prints for them, and
// records every call. It reads the configuration each command names, as
// wrangler does, so a wrong path or a missing database id fails here too.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FakeAccountState } from './fake-account.ts';

const stateFile = process.env['FAKE_CLOUDFLARE_STATE'];
if (!stateFile) throw new Error('FAKE_CLOUDFLARE_STATE is not set');
const state = JSON.parse(readFileSync(stateFile, 'utf8')) as FakeAccountState;
const argv = process.argv.slice(2);
state.calls.push({ args: argv, account: process.env['CLOUDFLARE_ACCOUNT_ID'] ?? null, cwd: process.cwd() });

const BOOLEAN_FLAGS = new Set(['--json', '--remote']);
const positionals: string[] = [];
const flags = new Map<string, string | true>();
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index] ?? '';
  if (!arg.startsWith('--')) positionals.push(arg);
  else if (BOOLEAN_FLAGS.has(arg)) flags.set(arg, true);
  else {
    flags.set(arg, argv[index + 1] ?? '');
    index += 1;
  }
}

function finish(code: number, stdout = '', stderr = ''): never {
  writeFileSync(stateFile!, JSON.stringify(state, null, 2));
  if (stdout) process.stdout.write(`${stdout}\n`);
  if (stderr) process.stderr.write(`${stderr}\n`);
  process.exit(code);
}

function flag(name: string): string {
  const value = flags.get(name);
  if (typeof value !== 'string') finish(1, '', `✘ [ERROR] Missing ${name}`);
  return value;
}

function requireLogin(): void {
  if (!state.loggedIn && !process.env['CLOUDFLARE_API_TOKEN']) {
    finish(1, '', '✘ [ERROR] Not logged in. Please run `wrangler login` to authenticate.');
  }
}

function accountId(): string {
  requireLogin();
  const fromEnv = process.env['CLOUDFLARE_ACCOUNT_ID'];
  if (fromEnv) {
    if (!state.accounts.some((account) => account.id === fromEnv)) finish(1, '', '✘ [ERROR] Unknown account');
    return fromEnv;
  }
  if (state.accounts.length === 1) return state.accounts[0]!.id;
  return finish(1, '', '✘ [ERROR] More than one account available but unable to select one in non-interactive mode.');
}

interface Config {
  name: string;
  main: string;
  base_dir: string;
  no_bundle?: boolean;
  assets: { directory: string };
  secrets?: { required?: string[] };
  durable_objects?: { bindings: { name: string; class_name: string }[] };
  d1_databases: { binding: string; database_name: string; database_id?: string; migrations_dir: string }[];
}

function config(): Config {
  const file = flag('--config');
  if (!path.isAbsolute(file)) finish(1, '', `✘ [ERROR] The test expects an absolute --config, got ${file}`);
  return JSON.parse(readFileSync(file, 'utf8')) as Config;
}

function databaseOf(cfg: Config, binding: string) {
  const entry = cfg.d1_databases.find((database) => database.binding === binding);
  const account = accountId();
  const database = state.databases.find((db) => db.accountId === account && db.uuid === entry?.database_id);
  if (!entry || !database)
    return finish(1, '', `✘ [ERROR] Couldn't find a D1 DB with the name or binding '${binding}'`);
  return { entry, database };
}

const command = positionals.slice(0, 2).join(' ');
switch (true) {
  case positionals[0] === 'whoami': {
    if (!state.loggedIn && !process.env['CLOUDFLARE_API_TOKEN']) finish(1, '{"loggedIn":false}');
    finish(
      0,
      JSON.stringify({
        loggedIn: true,
        authType: 'OAuth Token',
        email: 'person@example.com',
        accounts: state.accounts,
        tokenPermissions: ['account:read'],
      }),
    );
  }
  case positionals[0] === 'login': {
    state.loggedIn = true;
    finish(0, 'Successfully logged in.');
  }
  case command === 'd1 list': {
    const account = accountId();
    const listed = state.databases
      .filter((db) => db.accountId === account)
      .map((db) => ({ uuid: db.uuid, name: db.name, created_at: '2026-11-09T00:00:00.000Z', version: 'production' }));
    finish(0, JSON.stringify(listed, null, 2));
  }
  case command === 'd1 create': {
    const account = accountId();
    const name = positionals[2] ?? '';
    if (state.databases.some((db) => db.accountId === account && db.name === name)) {
      finish(1, '', `✘ [ERROR] A database with that name already exists [code: 7502]`);
    }
    state.databases.push({ accountId: account, uuid: randomUUID(), name, applied: null });
    finish(0, `✅ Successfully created DB '${name}'`);
  }
  case command === 'd1 execute': {
    if (flags.get('--remote') !== true || flags.get('--json') !== true)
      finish(1, '', '✘ [ERROR] Expected --remote --json');
    const { database } = databaseOf(config(), positionals[2] ?? '');
    if (flag('--command') !== 'SELECT name FROM d1_migrations ORDER BY id') finish(1, '', '✘ [ERROR] Unexpected query');
    if (database.applied === null) {
      finish(1, JSON.stringify({ error: { text: 'no such table: d1_migrations: SQLITE_ERROR' } }));
    }
    finish(0, JSON.stringify([{ results: database.applied.map((name) => ({ name })), success: true, meta: {} }]));
  }
  case command === 'd1 migrations' && positionals[2] === 'apply': {
    if (flags.get('--remote') !== true) finish(1, '', '✘ [ERROR] Expected --remote');
    const { entry, database } = databaseOf(config(), positionals[3] ?? '');
    const files = readdirSync(entry.migrations_dir)
      .filter((file) => file.endsWith('.sql'))
      .sort();
    database.applied ??= [];
    const pending = files.filter((file) => !database.applied!.includes(file));
    database.applied.push(...pending);
    finish(0, pending.length === 0 ? '✅ No migrations to apply!' : pending.map((file) => `✅ ${file}`).join('\n'));
  }
  case command === 'deployments status': {
    const account = accountId();
    const name = flag('--name');
    if (state.failLookupAfterDeploy && state.calls.some((call) => call.args[0] === 'deploy')) {
      finish(1, '', '✘ [ERROR] A request to the Cloudflare API failed: fetch failed');
    }
    const worker = state.workers.find((w) => w.accountId === account && w.name === name);
    if (!worker) {
      finish(
        1,
        '',
        `✘ [ERROR] A request to the Cloudflare API (/accounts/${account}/workers/scripts/${name}/deployments) failed.\n\n  This Worker does not exist on your account. [code: 10007]`,
      );
    }
    if (worker.deployed === null) finish(1, '', `✘ [ERROR] The Worker ${name} has no deployments.`);
    finish(
      0,
      JSON.stringify({
        id: randomUUID(),
        source: 'wrangler',
        strategy: 'percentage',
        author_email: 'person@example.com',
        created_on: '2026-11-09T00:00:00.000Z',
        annotations: { 'workers/triggered_by': 'deployment' },
        versions: [{ version_id: worker.deployed, percentage: 100 }],
      }),
    );
  }
  case command === 'versions view': {
    const account = accountId();
    const worker = state.workers.find((w) => w.accountId === account && w.name === flag('--name'));
    const version = worker?.versions.find((v) => v.id === positionals[2]);
    if (!version) finish(1, '', '✘ [ERROR] Version not found');
    const annotations: Record<string, string> = { 'workers/triggered_by': 'upload' };
    if (version.tag !== null) annotations['workers/tag'] = version.tag;
    if (version.message !== null) annotations['workers/message'] = version.message;
    finish(
      0,
      JSON.stringify({
        id: version.id,
        number: 1,
        metadata: {},
        annotations,
        resources: { bindings: version.bindings },
      }),
    );
  }
  case positionals[0] === 'deploy': {
    const account = accountId();
    const cfg = config();
    if (process.env['AUTH_SECRET'] !== undefined) {
      finish(1, '', '✘ [ERROR] AUTH_SECRET in the environment would override the secrets file');
    }
    if (cfg.no_bundle !== true || !existsSync(cfg.main) || !existsSync(cfg.assets.directory)) {
      finish(1, '', '✘ [ERROR] The configuration does not name a prebuilt Worker and its assets');
    }
    databaseOf(cfg, 'DB');
    const secretsFile = flags.get('--secrets-file');
    const secrets: Record<string, string> =
      typeof secretsFile === 'string' ? (JSON.parse(readFileSync(secretsFile, 'utf8')) as Record<string, string>) : {};
    let worker = state.workers.find((w) => w.accountId === account && w.name === cfg.name);
    const missing = (cfg.secrets?.required ?? []).filter((name) => !(name in secrets));
    if (!worker && missing.length > 0) {
      finish(1, '', `✘ [ERROR] The following required secrets have not been set: ${missing.join(', ')}`);
    }
    if (!worker) {
      worker = { accountId: account, name: cfg.name, secrets: {}, versions: [], deployed: null };
      state.workers.push(worker);
    }
    Object.assign(worker.secrets, secrets);
    const tag = flags.get('--tag');
    const message = flags.get('--message');
    const version = {
      id: randomUUID(),
      tag: typeof tag === 'string' ? tag : null,
      message: typeof message === 'string' ? message : null,
      bindings: [
        ...cfg.d1_databases.map((d1) => ({ name: d1.binding, type: 'd1' as const, id: d1.database_id ?? '' })),
        ...(cfg.durable_objects?.bindings ?? []).map((object) => ({
          name: object.name,
          type: 'durable_object_namespace' as const,
          class_name: object.class_name,
        })),
      ],
    };
    worker.versions.push(version);
    if (state.failDeployAfterUpload) finish(1, '', '✘ [ERROR] You need to register a workers.dev subdomain');
    worker.deployed = version.id;
    const output = process.env['WRANGLER_OUTPUT_FILE_PATH'];
    const address = `https://${cfg.name}.${state.subdomain}.workers.dev`;
    if (output) {
      appendFileSync(
        output,
        `${JSON.stringify({ type: 'deploy', version: 1, worker_name: cfg.name, version_id: version.id, targets: [address] })}\n`,
      );
    }
    finish(0, `Uploaded ${cfg.name}\nDeployed ${cfg.name} triggers\n  ${address}`);
  }
  default:
    finish(1, '', `✘ [ERROR] The stand-in does not know: wrangler ${argv.join(' ')}`);
}
