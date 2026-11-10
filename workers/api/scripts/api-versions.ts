// Lists the HTTP API's versions for the Worker. Each file in ../api-versions/
// is one version, and the version the Worker answers is how many there are
// (docs/api.md#versions). The Worker's bundler cannot list a folder, so this
// writes the names, in order, to src/api-versions.generated.json, which git
// ignores: two pull requests that each add a version then add one file each
// and edit no line in common. Installing, every build, dev run and deploy,
// and the tests run it first.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A version's file name: the UTC time it was written, then what it adds, such as `2026-11-10T0137Z-stalled-tasks.json`. */
const FILE_NAME = /^\d{4}-\d{2}-\d{2}T\d{4}Z-[a-z0-9]+(?:-[a-z0-9]+)*\.json$/u;

export const VERSIONS_DIR = fileURLToPath(new URL('../api-versions/', import.meta.url));
export const GENERATED_FILE = fileURLToPath(new URL('../src/api-versions.generated.json', import.meta.url));

/**
 * The versions in `dir`, oldest first: each file's name without `.json`, in
 * name order, which is the order of the times the names start with. Version
 * N is the Nth. A file named any other way is refused, since it would sort
 * where its name puts it; hidden files, such as the .DS_Store that macOS
 * writes, are passed over.
 */
export function apiVersionsIn(dir: string = VERSIONS_DIR): string[] {
  const files = readdirSync(dir)
    .filter((file) => !file.startsWith('.'))
    .sort();
  const misnamed = files.filter((file) => !FILE_NAME.test(file));
  if (misnamed.length > 0) {
    throw new Error(
      `${dir} holds files not named as a version, <UTC time as YYYY-MM-DDTHHMMZ>-<what it adds>.json: ${misnamed.join(', ')}`,
    );
  }
  return files.map((file) => file.slice(0, -'.json'.length));
}

/** Writes the versions in `dir` to `into`, leaving the file untouched when it already holds them. */
export function writeApiVersions(dir: string = VERSIONS_DIR, into: string = GENERATED_FILE): readonly string[] {
  const versions = apiVersionsIn(dir);
  const text = `${JSON.stringify(versions, null, 2)}\n`;
  if (!existsSync(into) || readFileSync(into, 'utf8') !== text) writeFileSync(into, text);
  return versions;
}

// Node gives this module's real path but keeps the path it was started with
// as given, which can run through a symbolic link: compare the real paths.
const started = process.argv[1];
if (started !== undefined && existsSync(started) && realpathSync(started) === fileURLToPath(import.meta.url)) {
  writeApiVersions();
}
