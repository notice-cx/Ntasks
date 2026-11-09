/**
 * The ntasks command. README.md beside src describes it for the people who
 * run it.
 *
 *   ntasks deploy [--name <name>] [--account <id or name>] [--dry-run]
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { deploy, Stop } from './deploy.ts';
import { IncompleteRelease, readRelease } from './release.ts';
import { Wrangler, WranglerError, type Io, type WranglerCommand } from './wrangler.ts';

export const DEFAULT_NAME = 'ntasks';

const USAGE = `Usage: npx ntasks deploy [--name <name>] [--account <id or name>] [--dry-run]

Deploys the Ntasks release this package holds to your Cloudflare account, or
updates the deployment there. npx ntasks@<version> deploy deploys that release.

  --name <name>        The Worker's name, which its D1 database shares. Default: ntasks.
  --account <account>  The Cloudflare account, by id or name, when your login reaches several.
  --dry-run            Print what the deploy would do, and change nothing.
  --version            Print the Ntasks release this package holds.
  --help               Print this help.`;

/** A Worker's name is the first label of its workers.dev address. */
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export interface Deps {
  /** The folder that holds the release: the package's own. */
  readonly packageDir: string;
  readonly wrangler: WranglerCommand;
  readonly env: NodeJS.ProcessEnv;
  readonly io: Io;
  /** Where wrangler's login and deploy output goes; left out, the terminal. */
  readonly terminal?: Io;
  readonly makeSecret?: () => string;
}

class UsageError extends Error {}

function parse(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        name: { type: 'string' },
        account: { type: 'string' },
        'dry-run': { type: 'boolean' },
        version: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * The environment wrangler runs with. AUTH_SECRET is left out, because wrangler
 * lets an environment variable override a value in the secrets file; the
 * output-file settings are left out, because the deploy sets its own.
 */
function wranglerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const {
    AUTH_SECRET: _secret,
    WRANGLER_OUTPUT_FILE_PATH: _path,
    WRANGLER_OUTPUT_FILE_DIRECTORY: _directory,
    ...rest
  } = env;
  return rest;
}

/** Runs the command and answers its exit code. */
export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  const { io } = deps;
  let workDir: string | undefined;
  try {
    const { values, positionals } = parse(argv);
    if (values.help) {
      io.out(USAGE);
      return 0;
    }
    const release = await readRelease(deps.packageDir);
    if (values.version) {
      io.out(release.version);
      return 0;
    }
    const [command, ...extra] = positionals;
    if (command !== 'deploy' || extra.length > 0) {
      throw new UsageError(
        command === undefined ? 'Name a command.' : `Unknown command: ${[command, ...extra].join(' ')}`,
      );
    }
    const name = values.name ?? DEFAULT_NAME;
    if (!WORKER_NAME.test(name)) {
      throw new UsageError(
        `--name ${name}: a name is lowercase letters, digits and hyphens, at most 63, starting and ending with a letter or digit.`,
      );
    }
    workDir = await mkdtemp(path.join(tmpdir(), 'ntasks-deploy-'));
    const wrangler = new Wrangler({
      command: deps.wrangler,
      cwd: workDir,
      env: wranglerEnv(deps.env),
      terminal: deps.terminal,
    });
    await deploy(
      { name, account: values.account, dryRun: values['dry-run'] ?? false },
      {
        release,
        wrangler,
        io,
        workDir,
        accountFromEnv: deps.env['CLOUDFLARE_ACCOUNT_ID'],
        makeSecret: deps.makeSecret,
      },
    );
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    if (error instanceof Stop || error instanceof IncompleteRelease) {
      io.err(error.message);
      return 1;
    }
    if (error instanceof WranglerError) {
      io.err([error.message, error.output.stdout.trim(), error.output.stderr.trim()].filter(Boolean).join('\n'));
      return 1;
    }
    throw error;
  } finally {
    // The folder holds the generated AUTH_SECRET on a first deploy.
    if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
  }
}
