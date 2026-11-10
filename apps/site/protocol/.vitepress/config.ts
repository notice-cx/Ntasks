import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import { pageSummary } from '../../lib/docs-index.ts';
import { BRANCH, REPOSITORY, SITE_ORIGIN } from '../../lib/site.ts';
import { iconHead } from '../../lib/social.ts';
import { SCHEMAS_PATH, SPEC_BASE, specMarkdownOptions } from '../../lib/spec.ts';

// The Shared Work Protocol: the repository's spec/ folder, rendered in place
// and served under /spec/ beside the landing page and the docs, with the
// schemas copied to the address their `$id`s name.
const specDir = fileURLToPath(new URL('../../../../spec/', import.meta.url));
const DESCRIPTION =
  'The Shared Work Protocol: an open contract for the record people and AI agents share when they work together, with its schemas, MCP profile, HTTP binding and conformance suite.';

export default defineConfig({
  title: 'Shared Work Protocol',
  titleTemplate: ':title · Shared Work Protocol',
  description: DESCRIPTION,
  lang: 'en-US',
  base: SPEC_BASE,
  srcDir: '../../../spec',
  // The schemas and samples are JSON, and the tests code: GitHub shows them.
  srcExclude: ['examples/**', 'schemas/**', 'test/**', 'node_modules/**'],
  rewrites: { 'README.md': 'index.md', 'conformance/README.md': 'conformance/index.md' },
  outDir: '../dist/spec',
  cleanUrls: true,
  ignoreDeadLinks: 'localhostLinks',
  head: [
    ...iconHead,
    ['meta', { property: 'og:site_name', content: 'Shared Work Protocol' }],
    ['meta', { property: 'og:type', content: 'website' }],
  ],
  transformPageData(pageData) {
    const source = readFileSync(`${specDir}${pageData.filePath}`, 'utf8');
    pageData.description ||= pageSummary(source) ?? DESCRIPTION;
    // A page whose title already names the protocol takes no suffix naming it again.
    if (pageData.title.includes('Shared Work Protocol')) pageData.titleTemplate = false;
  },
  transformHead({ pageData }) {
    if (pageData.isNotFound) return [['meta', { name: 'robots', content: 'noindex' }]];
    const path = pageData.relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '');
    const url = `${SITE_ORIGIN}${SPEC_BASE}${path}`;
    return [
      ['link', { rel: 'canonical', href: url }],
      ['meta', { property: 'og:title', content: pageData.title || 'Shared Work Protocol' }],
      ['meta', { property: 'og:description', content: pageData.description }],
      ['meta', { property: 'og:url', content: url }],
    ];
  },
  buildEnd(site) {
    const schemas = join(specDir, 'schemas');
    const served = join(site.outDir, SCHEMAS_PATH.slice(SPEC_BASE.length));
    mkdirSync(served, { recursive: true });
    for (const file of readdirSync(schemas).filter((name) => name.endsWith('.schema.json')))
      copyFileSync(join(schemas, file), join(served, file));
  },
  vite: {
    plugins: [
      {
        // As for the docs (../../.vitepress/config.ts): a page compiled from
        // spec/ imports Vue, which resolves only from this package.
        name: 'ntasks-spec-vue',
        enforce: 'pre',
        resolveId(id, importer, options) {
          if (!options?.ssr || !importer?.startsWith(specDir)) return null;
          if (id !== 'vue' && id !== 'vue/server-renderer') return null;
          return fileURLToPath(import.meta.resolve(id));
        },
      },
    ],
  },
  markdown: specMarkdownOptions,
  themeConfig: {
    logoLink: { link: '/', target: '_self' },
    nav: [
      { text: 'Spec', link: '/', activeMatch: '^/spec/' },
      { text: 'Ntasks docs', link: `${SITE_ORIGIN}/docs/`, target: '_self' },
    ],
    sidebar: [
      {
        text: 'Shared Work Protocol',
        items: [
          { text: 'Overview and implementations', link: '/' },
          { text: 'The protocol', link: '/protocol' },
          { text: 'The MCP tool profile', link: '/mcp-profile' },
          { text: 'The HTTP binding', link: '/http-binding' },
          { text: 'The conformance suite', link: '/conformance/' },
          { text: 'Appendix A: tests', link: '/tests' },
          { text: 'Appendix B: open questions', link: '/open-questions' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: `${REPOSITORY}/tree/${BRANCH}/spec`, ariaLabel: 'The spec on GitHub' }],
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    editLink: { pattern: `${REPOSITORY}/edit/${BRANCH}/spec/:path`, text: 'Edit this page on GitHub' },
    externalLinkIcon: true,
    footer: {
      message: `The text is licensed <a href="${REPOSITORY}/blob/${BRANCH}/spec/LICENSE-CC-BY-4.0">CC BY 4.0</a>; the schemas, samples and suite <a href="${REPOSITORY}/blob/${BRANCH}/spec/LICENSE-APACHE-2.0">Apache-2.0</a>.`,
      copyright: 'Copyright © 2026 Reindex Ventures LLC',
    },
  },
});
