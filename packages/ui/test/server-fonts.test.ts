import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAGE_FONT_FILES } from '../../../workers/api/src/access/page-look.ts';
import { fontSource, serverFonts } from '../server-fonts.config.ts';

describe("the Worker's own pages", () => {
  it('get each font file they name copied by the build from the pinned package, at that address', () => {
    const emitted: { fileName?: string; source?: unknown }[] = [];
    const plugin = serverFonts();
    const generate = plugin.generateBundle as unknown as (this: { emitFile: (file: object) => void }) => void;
    generate.call({ emitFile: (file) => emitted.push(file) });
    expect(emitted.map((file) => `/${file.fileName}`)).toEqual([...PAGE_FONT_FILES]);
    for (const address of PAGE_FONT_FILES) {
      const source = fontSource(address);
      expect(source).toContain(`${path.sep}@fontsource-variable${path.sep}inter${path.sep}`);
      expect(emitted.find((file) => `/${file.fileName}` === address)?.source).toEqual(readFileSync(source));
    }
  });
});
