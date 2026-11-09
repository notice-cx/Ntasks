import { posix } from 'node:path';
import type { MarkdownOptions, MarkdownRenderer } from 'vitepress';
import { BRANCH, REPOSITORY } from './site.ts';
import { githubSlug } from './slug.ts';

// The Markdown in docs/ is written to read well on GitHub. These rules render
// the same files on the site without changing them.

export interface DocsMarkdownOptions {
  /** The repository's GitHub address, such as https://github.com/notice-cx/Ntasks. */
  repository: string;
  /** The branch a link to a file outside docs/ opens. */
  branch: string;
  /** The docs folder's path from the repository root. */
  docsDir: string;
}

/**
 * A relative link that leaves the docs folder, such as `../SECURITY.md` or
 * `../workers/api/src/`, has no page on the site, so it opens that file or
 * folder on GitHub. Any other link is the site's, and is returned unchanged
 * as `undefined`.
 */
export function linkLeavingDocs(href: string, page: string, options: DocsMarkdownOptions): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:|^[#/]/i.test(href)) return undefined;
  const cut = href.indexOf('#');
  const target = cut === -1 ? href : href.slice(0, cut);
  const hash = cut === -1 ? '' : href.slice(cut);
  const docsDir = options.docsDir.replace(/\/$/, '');
  const repoPath = posix.normalize(posix.join(docsDir, posix.dirname(page), target));
  if (repoPath === docsDir || repoPath.startsWith(`${docsDir}/`) || repoPath.startsWith('../')) return undefined;
  const kind = target.endsWith('/') ? 'tree' : 'blob';
  return `${options.repository}/${kind}/${options.branch}/${repoPath.replace(/\/$/, '')}${hash}`;
}

// A <picture> whose dark source applies while the system prefers dark. The
// site has its own light and dark switch, so each picture becomes two images
// and the stylesheet shows the one for the site's theme.
const PICTURE =
  /<picture>\s*<source\s+media="\(prefers-color-scheme:\s*dark\)"\s+srcset="([^"]+)"\s*\/?>\s*(<img\b[^>]*>)\s*<\/picture>/g;

// An image path with no scheme, no leading slash and no leading dot, such as
// `images/board-light.webp`. Vue bundles an image only when its path starts
// with a dot, so these gain a leading `./`.
const RELATIVE_SOURCE = /(<(?:img|source)\b[^>]*?\s(?:src|srcset)=")(?![a-z][a-z0-9+.-]*:|[/.#])/gi;

/** An `<img>` tag with `name` added to its classes, keeping any it has. */
function withClass(img: string, name: string): string {
  if (/\sclass="/.test(img)) return img.replace(/\sclass="/, ` class="${name} `);
  return img.replace(/^<img\b/, `<img class="${name}"`);
}

function withSource(img: string, source: string): string {
  return img.replace(/\ssrc="[^"]*"/, ` src="${source}"`);
}

/** An `<img>` tag that loads when it nears the screen, unless it already says how to load. */
function lazy(img: string): string {
  return /\sloading="/.test(img) ? img : img.replace(/^<img\b/, '<img loading="lazy"');
}

/** Rewrites the images in a piece of the docs' raw HTML for the site. */
export function themeImages(html: string): string {
  return html
    .replace(
      PICTURE,
      (_match, dark: string, img: string) =>
        lazy(withClass(img, 'only-light')) + lazy(withClass(withSource(img, dark), 'only-dark')),
    )
    .replace(RELATIVE_SOURCE, '$1./');
}

/** The markdown-it plugin that applies these rules, and draws a `mermaid` code block as a diagram. */
export function docsMarkdown(md: MarkdownRenderer, options: DocsMarkdownOptions): void {
  md.core.ruler.push('ntasks-docs', (state) => {
    const page = (state.env as { relativePath?: string }).relativePath ?? '';
    for (const block of state.tokens) {
      for (const token of [block, ...(block.children ?? [])]) {
        if (token.type === 'link_open') {
          const href = token.attrGet('href');
          const leaving = href ? linkLeavingDocs(href, page, options) : undefined;
          if (leaving) token.attrSet('href', leaving);
        } else if (token.type === 'html_block' || token.type === 'html_inline') {
          token.content = themeImages(token.content);
        }
      }
    }
  });

  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, renderOptions, env, self) => {
    const token = tokens[idx];
    if (token?.info.trim() === 'mermaid') {
      return `<MermaidDiagram code="${encodeURIComponent(token.content)}" />\n`;
    }
    return fence ? fence(tokens, idx, renderOptions, env, self) : self.renderToken(tokens, idx, renderOptions);
  };
}

/** VitePress's Markdown options for the docs. */
export const docsMarkdownOptions: MarkdownOptions = {
  anchor: { slugify: githubSlug },
  config(md) {
    docsMarkdown(md, { repository: REPOSITORY, branch: BRANCH, docsDir: 'docs' });
  },
};
