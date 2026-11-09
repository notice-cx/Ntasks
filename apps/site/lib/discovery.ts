import type { HeadConfig } from 'vitepress';
import { readIndex } from './docs-index.ts';
import { DESCRIPTION, DOCS_BASE, REPOSITORY, SITE_ORIGIN } from './site.ts';

/** Escaping < keeps page titles from ending an inline JSON-LD script. */
export function jsonLd(value: object): HeadConfig {
  return ['script', { type: 'application/ld+json' }, JSON.stringify(value).replaceAll('<', '\\u003c')];
}

export const landingSchema = jsonLd({
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `${SITE_ORIGIN}/#website`,
      name: 'Ntasks',
      url: `${SITE_ORIGIN}/`,
      description: DESCRIPTION,
      inLanguage: 'en',
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_ORIGIN}/#software`,
      name: 'Ntasks',
      url: `${SITE_ORIGIN}/`,
      description: DESCRIPTION,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Web',
      runtimePlatform: 'Cloudflare Workers',
      license: `${REPOSITORY}/blob/main/LICENSE`,
      image: `${SITE_ORIGIN}/social.jpg`,
      softwareHelp: { '@type': 'CreativeWork', name: 'Ntasks documentation', url: `${SITE_ORIGIN}${DOCS_BASE}` },
      featureList: [
        'Shared tasks for people and AI agents',
        'Task claims and dependencies',
        'Decisions and approvals',
        'Completion evidence',
      ],
    },
  ],
});

export function docsSchema(title: string, description: string, url: string): HeadConfig {
  const items = [
    { '@type': 'ListItem', position: 1, name: 'Ntasks', item: `${SITE_ORIGIN}/` },
    { '@type': 'ListItem', position: 2, name: 'Docs', item: `${SITE_ORIGIN}${DOCS_BASE}` },
  ];
  if (url !== `${SITE_ORIGIN}${DOCS_BASE}`) items.push({ '@type': 'ListItem', position: 3, name: title, item: url });
  return jsonLd({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: title,
    description,
    url,
    inLanguage: 'en',
    isPartOf: { '@id': `${SITE_ORIGIN}/#website` },
    about: { '@id': `${SITE_ORIGIN}/#software` },
    breadcrumb: { '@type': 'BreadcrumbList', itemListElement: items },
  });
}

/** A compact documentation directory, generated from the sidebar's source. */
export function llmsText(index: string): string {
  return [
    '# Ntasks',
    '',
    `> ${DESCRIPTION}`,
    '',
    `- [Website](${SITE_ORIGIN}/)`,
    `- [Source code](${REPOSITORY})`,
    `- [Documentation](${SITE_ORIGIN}${DOCS_BASE})`,
    ...readIndex(index).flatMap((group) => [
      '',
      `## ${group.text}`,
      '',
      ...group.files.map(
        (page) => `- [${page.text}](${SITE_ORIGIN}${DOCS_BASE}${page.file.replace(/\.md$/, '')}): ${page.description}`,
      ),
    ]),
    '',
  ].join('\n');
}
