/**
 * Builds the npm package ntasks in tools/cli/dist, as src/release.ts reads
 * it: the Worker bundled by wrangler from the root wrangler.jsonc, the web
 * app's build, the D1 migrations, the compiled command, and the package's
 * package.json, README, licence and third-party licences. Then it checks the
 * package: the files `npm pack` would publish, and a `wrangler deploy
 * --dry-run` of the configuration and bundle the command deploys.
 *
 * `pnpm build` at the repository root runs it after the web app's build.
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { CONFIG_FILE, readRelease, writeDeployConfig } from '../src/release.ts';
import { packagedWrangler } from '../src/wrangler.ts';

const cliDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.resolve(cliDir, '../..');
const dist = path.join(cliDir, 'dist');
const webBuild = path.join(root, 'apps/web/dist');
const migrationsDir = path.join(root, 'workers/api/migrations');
const require = createRequire(import.meta.url);

type Json = Record<string, unknown>;

function run(program: string, args: readonly string[], options: SpawnSyncOptions = {}): string {
  const result = spawnSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} stopped with exit code ${result.status}\n${String(result.stdout)}`);
  }
  return String(result.stdout);
}

function wrangler(args: readonly string[], cwd: string): string {
  const { program, args: before } = packagedWrangler();
  return run(program, [...before, ...args], { cwd });
}

async function readJson(file: string): Promise<Json> {
  return JSON.parse(await readFile(file, 'utf8')) as Json;
}

/** The root wrangler.jsonc, which has comments; TypeScript's reader takes them. */
async function rootConfig(): Promise<Json> {
  const file = path.join(root, 'wrangler.jsonc');
  const { config, error } = ts.parseConfigFileTextToJson(file, await readFile(file, 'utf8'));
  if (error || typeof config !== 'object' || config === null) throw new Error(`${file} is not valid JSONC`);
  return config as Json;
}

/**
 * The root configuration, pointed at the package's files. The Worker is
 * deployed as it was bundled here; its task-store schema files are text
 * modules beside index.js that the bundle imports.
 */
function packagedConfig(source: Json): Json {
  const { $schema: _schema, ...settings } = source;
  const databases = source['d1_databases'];
  if (!Array.isArray(databases) || databases.length !== 1) throw new Error('wrangler.jsonc names one D1 database');
  return {
    ...settings,
    main: 'worker/index.js',
    base_dir: 'worker',
    no_bundle: true,
    find_additional_modules: true,
    rules: [{ type: 'Text', globs: ['**/*.sql'], fallthrough: false }],
    assets: { ...(source['assets'] as Json), directory: 'assets' },
    d1_databases: [{ ...(databases[0] as Json), migrations_dir: 'migrations' }],
  };
}

/** A package's licence files: LICENSE, LICENCE, COPYING or NOTICE, with any extension. */
async function licenceTexts(dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((file) => /^(licen[cs]e|copying|notice)([.-].*)?$/iu.test(file)).sort();
  return Promise.all(files.map(async (file) => (await readFile(path.join(dir, file), 'utf8')).trim()));
}

interface ListedPackage {
  readonly name: string;
  readonly versions: readonly string[];
  readonly paths: readonly string[];
  readonly license: string;
}

/**
 * THIRD_PARTY_LICENSES.md: the production dependencies of the Worker and the
 * web app, whose code the bundle and the web build include, each with its
 * licence text, and the Beads code that packages/domain adapts.
 */
async function thirdPartyLicences(): Promise<string> {
  const listed = JSON.parse(
    run('pnpm', ['licenses', 'list', '--prod', '--json', '--filter', '@ntasks/api', '--filter', '@ntasks/web'], {
      cwd: root,
    }),
  ) as Record<string, ListedPackage[]>;
  const packages = Object.values(listed)
    .flat()
    .filter((entry) => !entry.name.startsWith('@ntasks/'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const sections = [
    '# Third-party licences',
    '',
    'The Worker in `worker/` and the web app in `assets/` include code from the software below, which keeps its own licence. Ntasks itself is licensed under AGPL-3.0-only, in `LICENSE`.',
    '',
    '## Beads',
    '',
    'The task model in the Worker adapts code from [Beads](https://github.com/gastownhall/beads).',
    '',
    '```text',
    (await readFile(path.join(root, 'licenses/beads-LICENSE.txt'), 'utf8')).trim(),
    '```',
  ];
  for (const entry of packages) {
    for (const [index, version] of entry.versions.entries()) {
      const dir = entry.paths[index] ?? entry.paths[0] ?? '';
      sections.push('', `## ${entry.name} ${version}`, '', `Licence: ${entry.license}`);
      for (const text of await licenceTexts(dir)) sections.push('', '```text', text, '```');
    }
  }
  return `${sections.join('\n')}\n`;
}

async function packageManifest(): Promise<Json> {
  const rootManifest = await readJson(path.join(root, 'package.json'));
  const cliManifest = await readJson(path.join(cliDir, 'package.json'));
  const wranglerManifest = await readJson(require.resolve('wrangler/package.json'));
  const dependencies = cliManifest['dependencies'] as Json;
  return {
    name: 'ntasks',
    version: cliManifest['version'],
    description:
      'Deploy Ntasks, the task list you share with your AI agents, to your own Cloudflare account, and update it: npx ntasks deploy.',
    keywords: ['ntasks', 'tasks', 'ai-agents', 'mcp', 'cloudflare-workers'],
    license: rootManifest['license'],
    homepage: rootManifest['homepage'],
    repository: { ...(rootManifest['repository'] as Json), directory: 'tools/cli' },
    bugs: rootManifest['bugs'],
    type: 'module',
    bin: { ntasks: 'lib/bin.js' },
    files: ['lib', 'worker', 'assets', 'migrations', CONFIG_FILE, 'THIRD_PARTY_LICENSES.md'],
    // The command runs the wrangler it depends on, so it needs the Node.js
    // that wrangler needs.
    engines: wranglerManifest['engines'],
    dependencies: { wrangler: dependencies['wrangler'] },
  };
}

/** The files `npm pack` would publish, checked against the ones the command reads. */
async function checkPackedFiles(): Promise<number> {
  const [packed] = JSON.parse(run('npm', ['pack', '--dry-run', '--json'], { cwd: dist })) as {
    files: { path: string }[];
  }[];
  const files = new Set(packed?.files.map((file) => file.path));
  const migrations = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql'));
  const expected = [
    'package.json',
    'README.md',
    'LICENSE',
    'THIRD_PARTY_LICENSES.md',
    CONFIG_FILE,
    'lib/bin.js',
    'lib/cli.js',
    'lib/deploy.js',
    'lib/release.js',
    'lib/wrangler.js',
    'worker/index.js',
    'assets/index.html',
    ...migrations.map((file) => `migrations/${file}`),
  ];
  const missing = expected.filter((file) => !files.has(file));
  if (missing.length > 0) throw new Error(`npm pack leaves out ${missing.join(', ')}`);
  const sql = [...files].filter((file) => file.startsWith('worker/') && file.endsWith('.sql'));
  if (sql.length === 0) throw new Error('npm pack holds none of the task store schema files the bundle imports');
  return files.size;
}

/** Deploys the package as the command does, with --dry-run, so wrangler checks the configuration and the bundle. */
async function checkDeployConfig(): Promise<void> {
  const release = await readRelease(dist);
  const folder = await mkdtemp(path.join(tmpdir(), 'ntasks-package-check-'));
  try {
    const config = await writeDeployConfig(
      release,
      { name: 'ntasks', databaseId: '00000000-0000-4000-8000-000000000000' },
      folder,
    );
    wrangler(['deploy', '--dry-run', '--config', config, '--outdir', path.join(folder, 'out')], folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

if (!existsSync(path.join(webBuild, 'index.html'))) {
  throw new Error(`${webBuild} has no web app build; run \`pnpm build\` from the repository root`);
}
await rm(dist, { recursive: true, force: true });
await mkdir(dist);

wrangler(
  ['deploy', '--dry-run', '--config', path.join(root, 'wrangler.jsonc'), '--outdir', path.join(dist, 'worker')],
  root,
);
// wrangler writes a README.md beside the bundle; the package has its own.
await rm(path.join(dist, 'worker/README.md'), { force: true });
if (!existsSync(path.join(dist, 'worker/index.js'))) throw new Error('wrangler wrote no worker/index.js');

await cp(webBuild, path.join(dist, 'assets'), { recursive: true });
await mkdir(path.join(dist, 'migrations'));
for (const file of await readdir(migrationsDir)) {
  if (file.endsWith('.sql')) await copyFile(path.join(migrationsDir, file), path.join(dist, 'migrations', file));
}
run(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(cliDir, 'tsconfig.build.json')]);

await writeFile(path.join(dist, CONFIG_FILE), `${JSON.stringify(packagedConfig(await rootConfig()), null, 2)}\n`);
await writeFile(path.join(dist, 'package.json'), `${JSON.stringify(await packageManifest(), null, 2)}\n`);
await copyFile(path.join(cliDir, 'README.md'), path.join(dist, 'README.md'));
await copyFile(path.join(root, 'LICENSE'), path.join(dist, 'LICENSE'));
await writeFile(path.join(dist, 'THIRD_PARTY_LICENSES.md'), await thirdPartyLicences());

const count = await checkPackedFiles();
await checkDeployConfig();
process.stdout.write(
  `Built the ntasks package in ${path.relative(root, dist)}: ${count} files, checked with npm pack and wrangler deploy --dry-run.\n`,
);
