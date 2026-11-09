import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import manifest from './package.json' with { type: 'json' };
import { scopeStyles } from './scope-styles.config.ts';

// The host installs these, so the build leaves them out and imports them by name.
const external = [...Object.keys(manifest.dependencies), ...Object.keys(manifest.peerDependencies)];

/** The typefaces, served with the app, never from a font service: Inter with its optical-size axis, and JetBrains Mono for code. */
export const FONTS = ['@fontsource-variable/inter/opsz.css', '@fontsource-variable/jetbrains-mono/wght.css'];

/**
 * The stylesheet imports the fonts from their packages rather than holding
 * them: a library build would inline every font file, and the host's build
 * copies them instead, so a page downloads only the scripts it shows.
 */
function importFonts(): Plugin {
  return {
    name: 'ntasks-import-fonts',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !file.fileName.endsWith('.css')) continue;
        file.source = `${FONTS.map((font) => `@import "${font}";\n`).join('')}${String(file.source)}`;
      }
    },
  };
}

/**
 * `vite build` writes the package to dist/: one module per entry, the code
 * each page loads when it is first opened, and one stylesheet. `vite --mode fixture` serves dev/, the app over invented tasks.
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), importFonts()],
  css: { postcss: { plugins: [scopeStyles()] } },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    lib: {
      entry: { index: 'src/index.ts', fixture: 'src/fixture.ts' },
      formats: ['es'],
      cssFileName: 'ntasks-ui',
    },
    cssCodeSplit: false,
    sourcemap: true,
    rolldownOptions: {
      external: (id) => external.some((name) => id === name || id.startsWith(`${name}/`)),
    },
  },
});
