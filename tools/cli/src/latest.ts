/**
 * The latest release of this package on the npm registry. npx looks for a
 * newer release only of a package in its own cache; a global or project
 * install it runs as it is, so such a copy reads the latest release itself
 * before it deploys.
 */
import path from 'node:path';

export const PACKAGE = 'ntasks';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

const TIMEOUT_MS = 5000;

const RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/** The registry npm uses: npm passes a configured one to the command it runs as npm_config_registry. */
export function registryOf(env: NodeJS.ProcessEnv): string {
  const configured = env['npm_config_registry'];
  return configured === undefined || configured === '' ? DEFAULT_REGISTRY : configured;
}

/** The number of the release the registry tags `latest`, or undefined when the registry cannot be read. */
export async function latestRelease(registry: string): Promise<string | undefined> {
  try {
    const base = registry.endsWith('/') ? registry : `${registry}/`;
    const response = await fetch(new URL(`-/package/${PACKAGE}/dist-tags`, base), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const tags: unknown = await response.json();
    const latest = typeof tags === 'object' && tags !== null ? (tags as Record<string, unknown>)['latest'] : undefined;
    return typeof latest === 'string' && RELEASE.test(latest) ? latest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the package sits in npx's own cache, `_npx` in npm's cache folder.
 * npx resolved such a copy just now, to the release the person named or the
 * latest one, so it needs no check.
 */
export function inNpxCache(packageDir: string): boolean {
  return path.resolve(packageDir).split(path.sep).includes('_npx');
}
