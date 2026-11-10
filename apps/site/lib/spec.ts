import { posix } from 'node:path';
import type { MarkdownOptions } from 'vitepress';
import { docsMarkdown, linkLeavingDocs } from './markdown.ts';
import { BRANCH, REPOSITORY, SITE_ORIGIN, SPEC_BASE } from './site.ts';
import { githubSlug } from './slug.ts';

// The Shared Work Protocol, spec/ in the repository, rendered at /spec/ with
// the docs' look. The schemas are published under the address their `$id`s
// name, so a validator that fetches a schema by its id finds it.

export { SPEC_BASE };

/** The path each schema is served at: its `$id`, https://ntasks.notice.cx/spec/v0/schemas/<file>. */
export const SCHEMAS_PATH = `${SPEC_BASE}v0/schemas/`;

const SCHEMA = /^schemas\/([a-z-]+\.schema\.json)$/;

/**
 * Where a link in spec/ goes on the site: a schema to its published
 * address, a README to its folder's page, another page of spec/ stays as it
 * is (`undefined`), and any other file or folder, inside spec/ or out of it,
 * to GitHub.
 */
export function specLink(href: string, page: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:|^[#/]/i.test(href)) return undefined;
  const cut = href.indexOf('#');
  const target = cut === -1 ? href : href.slice(0, cut);
  const hash = cut === -1 ? '' : href.slice(cut);
  const repoPath = posix.normalize(posix.join('spec', posix.dirname(page), target));
  if (repoPath !== 'spec' && !repoPath.startsWith('spec/'))
    return linkLeavingDocs(href, page, { repository: REPOSITORY, branch: BRANCH, docsDir: 'spec' });
  const inSpec = repoPath.slice('spec/'.length);
  const schema = SCHEMA.exec(inSpec);
  if (schema) return `${SITE_ORIGIN}${SCHEMAS_PATH}${schema[1]}${hash}`;
  if (posix.basename(target) === 'README.md') return `${target.slice(0, -'README.md'.length) || './'}${hash}`;
  if (target.endsWith('.md')) return undefined;
  const kind = target === '' || target.endsWith('/') ? 'tree' : 'blob';
  return `${REPOSITORY}/${kind}/${BRANCH}/${repoPath.replace(/\/$/, '')}${hash}`;
}

/** VitePress's Markdown options for the spec. */
export const specMarkdownOptions: MarkdownOptions = {
  anchor: { slugify: githubSlug },
  config(md) {
    docsMarkdown(md, { repository: REPOSITORY, branch: BRANCH, docsDir: 'spec', link: specLink });
  },
};
