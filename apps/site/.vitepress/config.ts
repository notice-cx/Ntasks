import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import { docsSidebar, pageSummary } from '../lib/docs-index.ts';
import { docsMarkdownOptions } from '../lib/markdown.ts';
import { BRANCH, DESCRIPTION, DOCS_BASE, REPOSITORY, SITE_ORIGIN } from '../lib/site.ts';
import { iconHead, socialHead } from '../lib/social.ts';
import { docsSchema } from '../lib/discovery.ts';

// The docs: the repository's docs/ folder, rendered in place and served
// under /docs/ beside the landing page, which vite.config.ts builds into the
// same dist/.
const docsDir = fileURLToPath(new URL('../../../docs/', import.meta.url));

export default defineConfig({
  title: 'Ntasks',
  titleTemplate: ':title · Ntasks docs',
  description: DESCRIPTION,
  lang: 'en-US',
  base: DOCS_BASE,
  srcDir: '../../docs',
  outDir: 'dist/docs',
  cleanUrls: true,
  // A dead link to another page fails the build; scripts/check-links.ts
  // then checks every link's heading as well. Links to localhost are the
  // addresses of a local run.
  ignoreDeadLinks: 'localhostLinks',
  sitemap: {
    hostname: `${SITE_ORIGIN}${DOCS_BASE}`,
    // The landing page is outside the docs' base, and has no page of its own here.
    transformItems: (items) => [{ url: `${SITE_ORIGIN}/` }, ...items],
  },
  head: [
    // The landing page's build writes the icons at these paths.
    ...iconHead,
    ['meta', { property: 'og:site_name', content: 'Ntasks' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ...socialHead,
  ],
  transformPageData(pageData) {
    const source = readFileSync(`${docsDir}${pageData.relativePath}`, 'utf8');
    pageData.description ||= pageSummary(source) ?? DESCRIPTION;
    if (pageData.relativePath === 'index.md') {
      pageData.frontmatter.titleTemplate = false;
      pageData.frontmatter.pageClass = 'docs-index';
      pageData.frontmatter.outline = false;
      pageData.frontmatter.editLink = false;
      pageData.frontmatter.prev = false;
      pageData.frontmatter.next = false;
    }
  },
  transformHead({ pageData }) {
    if (pageData.isNotFound) return [['meta', { name: 'robots', content: 'noindex' }]];
    const path = pageData.relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '');
    const url = `${SITE_ORIGIN}${DOCS_BASE}${path}`;
    return [
      ['link', { rel: 'canonical', href: url }],
      ['meta', { property: 'og:title', content: pageData.title || 'Ntasks docs' }],
      ['meta', { property: 'og:description', content: pageData.description }],
      ['meta', { property: 'og:url', content: url }],
      ['meta', { name: 'twitter:title', content: pageData.title || 'Ntasks docs' }],
      ['meta', { name: 'twitter:description', content: pageData.description }],
      docsSchema(pageData.title || 'Ntasks docs', pageData.description, url),
    ];
  },
  vite: {
    plugins: [
      {
        // A page compiled from docs/ imports Vue, which resolves only from
        // this package: docs/ has no node_modules. VitePress points the
        // browser's bundle at Vue itself, and an alias here would override
        // that, so this resolves Vue for the server-side render only.
        name: 'ntasks-docs-vue',
        enforce: 'pre',
        resolveId(id, importer, options) {
          if (!options?.ssr || !importer?.startsWith(docsDir)) return null;
          if (id !== 'vue' && id !== 'vue/server-renderer') return null;
          return fileURLToPath(import.meta.resolve(id));
        },
      },
    ],
  },
  markdown: docsMarkdownOptions,
  themeConfig: {
    // The theme draws the mark before the title. The title links to the
    // landing page, which is outside the docs' base; `target` keeps the docs'
    // router from treating it as a docs page.
    logoLink: { link: '/', target: '_self' },
    nav: [
      { text: 'Docs', link: '/', activeMatch: '^/docs/' },
      { text: 'Get started', link: '/deploy' },
    ],
    sidebar: docsSidebar(docsDir),
    socialLinks: [{ icon: 'github', link: REPOSITORY, ariaLabel: 'Ntasks on GitHub' }],
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    editLink: { pattern: `${REPOSITORY}/edit/${BRANCH}/docs/:path`, text: 'Edit this page on GitHub' },
    externalLinkIcon: true,
    footer: {
      message: `Ntasks is open source under the <a href="${REPOSITORY}/blob/${BRANCH}/LICENSE">AGPL-3.0 licence</a>.`,
      copyright: 'Copyright © 2026 Reindex Ventures LLC',
    },
  },
});
