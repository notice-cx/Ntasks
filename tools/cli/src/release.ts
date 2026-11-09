/**
 * The Ntasks release this package holds, as scripts/build.ts lays it out:
 *
 *   package.json   its version
 *   wrangler.json  the Worker's Wrangler configuration, paths relative to the package
 *   worker/        the bundled Worker, deployed as it is
 *   assets/        the web app's build, the Worker's static files
 *   migrations/    the D1 migrations
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CONFIG_FILE = 'wrangler.json';

interface D1Binding {
  readonly binding: string;
  readonly database_name: string;
  readonly migrations_dir: string;
  readonly [setting: string]: unknown;
}

/** The settings of wrangler.json this package reads or rewrites; wrangler reads the rest. */
export interface PackagedConfig {
  readonly name: string;
  readonly main: string;
  readonly base_dir: string;
  readonly assets: { readonly directory: string; readonly [setting: string]: unknown };
  readonly d1_databases: readonly [D1Binding];
  readonly [setting: string]: unknown;
}

export interface Release {
  readonly dir: string;
  readonly version: string;
  readonly config: PackagedConfig;
  /** The D1 migration files, in the order wrangler applies them. */
  readonly migrations: readonly string[];
}

/** What a deploy targets: the Worker's name, which the D1 database shares, and the database once it exists. */
export interface Target {
  readonly name: string;
  readonly databaseId: string;
}

export class IncompleteRelease extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPackagedConfig(value: unknown): value is PackagedConfig {
  if (!isRecord(value) || !isRecord(value['assets']) || !Array.isArray(value['d1_databases'])) return false;
  const [database, ...others] = value['d1_databases'] as unknown[];
  return (
    typeof value['main'] === 'string' &&
    typeof value['base_dir'] === 'string' &&
    typeof value['assets']['directory'] === 'string' &&
    others.length === 0 &&
    isRecord(database) &&
    typeof database['binding'] === 'string' &&
    typeof database['migrations_dir'] === 'string'
  );
}

export async function readRelease(dir: string): Promise<Release> {
  let manifest: unknown;
  let config: unknown;
  try {
    manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    config = JSON.parse(await readFile(path.join(dir, CONFIG_FILE), 'utf8'));
  } catch {
    throw new IncompleteRelease(
      `${dir} holds no built Ntasks release. In a checkout of the Ntasks repository, \`pnpm build\` builds one in tools/cli/dist.`,
    );
  }
  if (!isRecord(manifest) || typeof manifest['version'] !== 'string' || !isPackagedConfig(config)) {
    throw new IncompleteRelease(
      `${path.join(dir, CONFIG_FILE)} is not the Wrangler configuration of an Ntasks release.`,
    );
  }
  const migrationsDir = path.resolve(dir, config.d1_databases[0].migrations_dir);
  const migrations = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  return { dir, version: manifest['version'], config, migrations };
}

/** The binding commands name the D1 database by, so they find it from the configuration. */
export function databaseBinding(release: Release): string {
  return release.config.d1_databases[0].binding;
}

/**
 * The configuration wrangler deploys with: the target's names and database,
 * and every path made absolute, since the file is written outside the
 * package's folder.
 */
export function deployConfig(release: Release, target: Target): PackagedConfig {
  const { config, dir } = release;
  const [database] = config.d1_databases;
  return {
    ...config,
    name: target.name,
    main: path.resolve(dir, config.main),
    base_dir: path.resolve(dir, config.base_dir),
    assets: { ...config.assets, directory: path.resolve(dir, config.assets.directory) },
    d1_databases: [
      {
        ...database,
        database_name: target.name,
        database_id: target.databaseId,
        migrations_dir: path.resolve(dir, database.migrations_dir),
      },
    ],
  };
}

/** Writes deployConfig into the folder and answers the file's path. */
export async function writeDeployConfig(release: Release, target: Target, folder: string): Promise<string> {
  const file = path.join(folder, CONFIG_FILE);
  await writeFile(file, `${JSON.stringify(deployConfig(release, target), null, 2)}\n`);
  return file;
}
