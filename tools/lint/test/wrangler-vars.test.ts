// Run by `node --test`. The `vars` of a wrangler configuration are plain text
// in the repository, so a variable there must not hold a secret. Secrets are
// set with `wrangler secret put`, by the Deploy to Cloudflare button, or in
// `.dev.vars` for local runs, and a Worker reads them from `env` like any
// variable.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const root = join(import.meta.dirname, '../../..');

function parseJsonc(text: string): unknown {
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', text);
  assert.equal(parsed.error, undefined, 'the configuration parses');
  return parsed.config as unknown;
}

// The names of the variables that sound like a secret, in every `vars` object
// of a configuration: the top-level one, and each environment's.
function secretVars(text: string): string[] {
  const config = parseJsonc(text);

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
  walk(config, '');
  return found;
}

// The names a dotenv file sets, in the order it sets them.
function dotenvNames(text: string): string[] {
  return text
    .split('\n')
    .map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line)?.[1])
    .filter((name) => name !== undefined);
}

test('a wrangler configuration of this repository names no secret in its vars', async () => {
  const paths = [join(root, 'wrangler.jsonc')];
  for (const entry of await readdir(join(root, 'workers'), { withFileTypes: true })) {
    if (entry.isDirectory()) paths.push(join(root, 'workers', entry.name, 'wrangler.jsonc'));
  }
  const configs: string[] = [];
  for (const path of paths) {
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

// The Deploy to Cloudflare button asks for each secret .dev.vars.example
// names, with the description package.json gives it under
// cloudflare.bindings. `wrangler deploy` refuses a Worker that lacks a
// secret secrets.required lists, so one the button does not ask for fails
// the first deploy.
test('the Deploy to Cloudflare button asks for every secret wrangler.jsonc requires, and no other', async () => {
  const config = parseJsonc(await readFile(join(root, 'wrangler.jsonc'), 'utf8')) as {
    secrets?: { required?: string[] };
  };
  const required = [...(config.secrets?.required ?? [])].sort();
  assert.ok(required.length > 0, 'wrangler.jsonc lists the secrets the Worker requires');

  const prompted = dotenvNames(await readFile(join(root, '.dev.vars.example'), 'utf8'));
  assert.deepEqual([...prompted].sort(), required, '.dev.vars.example names the required secrets');

  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    cloudflare?: { bindings?: Record<string, { description?: string }> };
  };
  const described = Object.entries(manifest.cloudflare?.bindings ?? {})
    .filter(([, binding]) => (binding.description ?? '').length > 0)
    .map(([name]) => name)
    .sort();
  assert.deepEqual(described, required, 'package.json describes each required secret');
});

test('the dotenv reader finds each name a line sets, and skips comments and blank lines', () => {
  const text = '# A comment\nFIRST=\n\n  SECOND = value # a note\n#THIRD=x\nURL=https://example.com/?a=b\n';
  assert.deepEqual(dotenvNames(text), ['FIRST', 'SECOND', 'URL']);
});
