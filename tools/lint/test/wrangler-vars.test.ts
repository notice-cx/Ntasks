// Run by `node --test`. The `vars` of a wrangler configuration are plain text
// in the repository, so a variable there must not hold a secret. Secrets are
// set with `wrangler secret put`, or in `.dev.vars` for local runs, and a
// Worker reads them from `env` like any variable.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const workers = join(import.meta.dirname, '../../../workers');

// The names of the variables that sound like a secret, in every `vars` object
// of a configuration: the top-level one, and each environment's.
function secretVars(text: string): string[] {
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', text);
  assert.equal(parsed.error, undefined, 'the configuration parses');

  const found: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'vars' && typeof child === 'object' && child !== null) {
        found.push(
          ...Object.keys(child)
            .filter((name) =>
              /secret|token|password|passcode|credential|api_?key|private_?key|signing_?key/iu.test(name),
            )
            .map((name) => `${path}vars.${name}`),
        );
      } else {
        walk(child, `${path}${key}.`);
      }
    }
  };
  walk(parsed.config as unknown, '');
  return found;
}

test('a wrangler configuration of this repository names no secret in its vars', async () => {
  const configs: string[] = [];
  for (const entry of await readdir(workers, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(workers, entry.name, 'wrangler.jsonc');
    const text = await readFile(path, 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    configs.push(path);
    assert.deepEqual(secretVars(text), [], `${path} puts a secret in vars`);
  }
  assert.ok(configs.length > 0, 'the Worker has a wrangler configuration');
});

test('the check finds a secret in any vars object, and leaves other variables alone', () => {
  const text = `{
    // Comments are allowed in a wrangler configuration.
    "vars": { "WORKSPACE_ID": "default", "API_TOKEN": "x", "clientSecret": "y" },
    "env": { "staging": { "vars": { "DB_PASSWORD": "z", "WORKSPACE_NAME": "Ntasks" } } }
  }`;
  assert.deepEqual(secretVars(text), ['vars.API_TOKEN', 'vars.clientSecret', 'env.staging.vars.DB_PASSWORD']);
});
