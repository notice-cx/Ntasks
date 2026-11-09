/**
 * `pnpm --filter @ntasks/ui run check:host`, after `pnpm build`: packs the
 * package as npm would publish it and installs the tarball, from the file and
 * not a registry, into an empty Vite and React project made from host/. The
 * project then typechecks against the package's declarations, builds with
 * its stylesheet and fonts, and renders the board from invented tasks. Its
 * other dependencies are the versions this package builds and tests with.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  devDependencies: Record<string, string>;
};

const RUNTIME = ['react', 'react-dom', 'react-router-dom'];
const TOOLS = [
  '@testing-library/dom',
  '@testing-library/react',
  '@types/react',
  '@types/react-dom',
  '@vitejs/plugin-react',
  'jsdom',
  'typescript',
  'vite',
  'vitest',
];

function pinned(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    names.map((name) => {
      const version = manifest.devDependencies[name];
      if (version === undefined) throw new Error(`packages/ui/package.json pins no version of ${name}.`);
      return [name, version];
    }),
  );
}

function run(cwd: string, command: string, args: readonly string[]): void {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

const work = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'ntasks-ui-host-'));
try {
  run(root, 'pnpm', ['pack', '--pack-destination', work]);
  const tarball = readdirSync(work).find((name) => name.endsWith('.tgz'));
  if (!tarball) throw new Error('pnpm pack wrote no tarball.');
  const project = path.join(work, 'host');
  cpSync(path.join(root, 'host'), project, { recursive: true });
  writeFileSync(
    path.join(project, 'package.json'),
    `${JSON.stringify(
      {
        name: 'ntasks-ui-host',
        private: true,
        type: 'module',
        dependencies: { '@ntasks/ui': `file:../${tarball}`, ...pinned(RUNTIME) },
        devDependencies: pinned(TOOLS),
      },
      null,
      2,
    )}\n`,
  );
  // Outside the repository's workspace, with no lockfile of its own.
  run(project, 'pnpm', ['install', '--ignore-workspace', '--no-lockfile', '--prefer-offline']);
  run(project, 'pnpm', ['exec', 'tsc', '-p', '.']);
  run(project, 'pnpm', ['exec', 'vite', 'build']);
  run(project, 'pnpm', ['exec', 'vitest', 'run']);
} finally {
  rmSync(work, { recursive: true, force: true });
}
