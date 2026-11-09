/**
 * The font files the Worker's own pages (sign-in, agent approval) load, as a
 * Vite plugin: apps/web's build copies them, and this package's development
 * server serves them, for the pictures tools/screenshots draws of those
 * pages. The app's own fonts get hashed names
 * at each build, which a page the Worker writes cannot know, so the build
 * also copies each file those pages name to that exact address, from the
 * same pinned @fontsource package the app uses.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';
import { PAGE_FONT_FILES } from '../../workers/api/src/access/page-look.ts';

const require = createRequire(import.meta.url);

/** The package file a font address is copied from: the file of that name in Inter's package. */
export function fontSource(address: string): string {
  return require.resolve(`@fontsource-variable/inter/files/${path.posix.basename(address)}`);
}

export function serverFonts(): Plugin {
  return {
    name: 'ntasks-server-fonts',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const address = request.url?.split('?')[0] ?? '';
        if (!(PAGE_FONT_FILES as readonly string[]).includes(address)) return next();
        response.setHeader('content-type', 'font/woff2');
        response.end(readFileSync(fontSource(address)));
      });
    },
    generateBundle() {
      for (const address of PAGE_FONT_FILES) {
        this.emitFile({ type: 'asset', fileName: address.slice(1), source: readFileSync(fontSource(address)) });
      }
    },
  };
}
