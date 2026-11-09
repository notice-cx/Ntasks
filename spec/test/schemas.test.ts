/**
 * The schemas compile, every sample in examples/<schema>/ validates against
 * its schema, and every sample in examples/<schema>/invalid/ does not. A
 * schema without a valid sample fails, so each object the protocol names is
 * shown at least once.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const SPEC = fileURLToPath(new URL('..', import.meta.url));
const SCHEMAS = join(SPEC, 'schemas');
const EXAMPLES = join(SPEC, 'examples');
const ID_BASE = 'https://ntasks.notice.cx/spec/v0/schemas/';

const jsonFiles = (folder: string): string[] =>
  existsSync(folder)
    ? readdirSync(folder)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : [];
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

const schemaFiles = jsonFiles(SCHEMAS);
// Strict about unknown keywords and formats, so a misspelt keyword fails
// rather than being ignored. Ajv's own checks beyond JSON Schema stay off: a
// conditional may name a property defined beside it, and a subschema may
// constrain a value without restating its type.
const ajv = new Ajv2020({
  strict: true,
  strictRequired: false,
  strictTypes: false,
  strictTuples: false,
  allErrors: true,
});
addFormats.default(ajv);
for (const file of schemaFiles) ajv.addSchema(readJson(join(SCHEMAS, file)) as object);

describe('the schemas', () => {
  it('each name its file under the v0 address and compile', () => {
    expect(schemaFiles.length).toBeGreaterThan(0);
    for (const file of schemaFiles) {
      const schema = readJson(join(SCHEMAS, file)) as { $id?: string };
      expect(schema.$id).toBe(`${ID_BASE}${file}`);
      expect(() => ajv.getSchema(schema.$id!)).not.toThrow();
    }
  });

  it('each have a sample folder, and every sample folder has a schema', () => {
    const named = schemaFiles.map((file) => file.replace(/\.schema\.json$/u, '')).sort();
    const folders = readdirSync(EXAMPLES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(folders).toEqual(named);
  });
});

for (const file of schemaFiles) {
  const name = file.replace(/\.schema\.json$/u, '');
  const validate = ajv.getSchema(`${ID_BASE}${file}`)!;
  const valid = jsonFiles(join(EXAMPLES, name));
  const invalid = jsonFiles(join(EXAMPLES, name, 'invalid'));

  describe(`${name} samples`, () => {
    it('include at least one valid object', () => {
      expect(valid.length).toBeGreaterThan(0);
    });

    it.each(valid)('validate: %s', (sample) => {
      const ok = validate(readJson(join(EXAMPLES, name, sample)));
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    });

    if (invalid.length > 0)
      it.each(invalid)('refuse: invalid/%s', (sample) => {
        expect(validate(readJson(join(EXAMPLES, name, 'invalid', sample)))).toBe(false);
      });
  });
}
