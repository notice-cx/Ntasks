import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath, type Plugin } from 'vite';
import { docsList } from './lib/landing-docs.ts';
import { inlineMark } from './lib/mark.ts';
import { DOCS_BASE } from './lib/site.ts';
import { headHtml, iconHead, socialHead } from './lib/social.ts';
import { withStatcounter } from './lib/statcounter.ts';
import { landingSchema, llmsText } from './lib/discovery.ts';

// The landing page, index.html, and the site's 404 page, built into dist/.
// VitePress then builds the docs into dist/docs/ (.vitepress/config.ts).

const repo = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(`${repo}${path}`);

/** The dev server's route to a file outside its root, followed by the file's absolute path. */
const FS_PREFIX = '/@fs/';

// Files served at a fixed address, which the docs' pages link to as well.
const FIXED = {
  'favicon.svg': 'apps/web/public/brand/notice-icon.svg',
  'favicon-32.png': 'apps/web/public/brand/notice-icon-32.png',
  'apple-touch-icon.png': 'apps/web/public/brand/notice-icon-180.png',
};

function landing(): Plugin {
  return {
    name: 'ntasks-landing',
    transformIndexHtml(html, { server }) {
      const mark = inlineMark(read('apps/web/public/brand/notice-icon.svg').toString(), 'mark');
      const page = withStatcounter(html)
        .replaceAll('<!--mark-->', mark)
        .replace('<!--social-head-->', headHtml([...socialHead, landingSchema]))
        .replace('<!--icons-->', headHtml(iconHead))
        .replace('<!--docs-->', docsList(read('docs/index.md').toString(), DOCS_BASE));
      // The build bundles each file a relative URL names, such as
      // ../../docs/images/. The dev server serves only this folder at /, so
      // there a URL that leaves it goes through Vite's /@fs/ file route.
      return server ? page.replaceAll('"../../', `"${FS_PREFIX}${normalizePath(repo).replace(/^\//u, '')}`) : page;
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'llms.txt', source: llmsText(read('docs/index.md').toString()) });
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
