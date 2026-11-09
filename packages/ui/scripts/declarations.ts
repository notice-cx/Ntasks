/**
 * Writes the package's type declarations to dist/types, after `vite build`.
 * tsc writes them with the source's own import names; this rewrites the one
 * a host cannot resolve, `@ntasks/domain`, the task model the build bundles,
 * to the copy of its declarations in dist/types/domain. It drops the
 * stylesheet's import, which a host imports as `@ntasks/ui/styles.css`.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist', 'types');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

/** The import path from the declaration file `from` to `target`, a module in dist/types. */
function relative(from: string, target: string): string {
  const rel = path.relative(path.dirname(from), target).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

export function rewriteDeclaration(source: string, file: string, types: string): string {
  return source
    .replace(/^import '[^']+\.css';\n/gm, '')
    .replace(/(['"])@ntasks\/domain\1/g, (_match, quote: string) => {
      return `${quote}${relative(file, path.join(types, 'domain', 'index'))}${quote}`;
    });
}

function declarations(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.d.ts'))
    .map((name) => path.join(dir, name));
}

if (import.meta.main) {
  const emitted = mkdtempSync(path.join(os.tmpdir(), 'ntasks-ui-types-'));
  try {
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--outDir', emitted], {
      cwd: root,
      stdio: 'inherit',
    });
    rmSync(out, { recursive: true, force: true });
    cpSync(path.join(emitted, 'ui', 'src'), out, { recursive: true });
    cpSync(path.join(emitted, 'domain', 'src'), path.join(out, 'domain'), { recursive: true });
    for (const file of declarations(out)) {
      writeFileSync(file, rewriteDeclaration(readFileSync(file, 'utf8'), file, out));
    }
  } finally {
    rmSync(emitted, { recursive: true, force: true });
  }
}
