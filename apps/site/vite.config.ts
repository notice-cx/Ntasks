import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { docsList } from './lib/landing-docs.ts';
import { inlineMark } from './lib/mark.ts';
import { DOCS_BASE } from './lib/site.ts';

// The landing page, index.html, and the site's 404 page, built into dist/.
// VitePress then builds the docs into dist/docs/ (.vitepress/config.ts).

const repo = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(`${repo}${path}`);

// Files served at a fixed address, which the docs' pages link to as well.
const FIXED = {
  'favicon.svg': 'apps/web/public/brand/notice-icon.svg',
  'favicon-32.png': 'apps/web/public/brand/notice-icon-32.png',
  'apple-touch-icon.png': 'apps/web/public/brand/notice-icon-180.png',
  'social.webp': 'docs/images/hero-light.webp',
};

function landing(): Plugin {
  return {
    name: 'ntasks-landing',
    transformIndexHtml(html) {
      const mark = inlineMark(read('apps/web/public/brand/notice-icon.svg').toString(), 'mark');
      return html
        .replaceAll('<!--mark-->', mark)
        .replace('<!--docs-->', docsList(read('docs/index.md').toString(), DOCS_BASE));
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(FIXED)) {
        this.emitFile({ type: 'asset', fileName, source: read(source) });
      }
    },
  };
}

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: { input: { index: 'index.html', notFound: '404.html' } },
  },
  plugins: [landing()],
});
