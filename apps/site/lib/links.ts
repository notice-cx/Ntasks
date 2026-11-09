import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { githubSlug } from './slug.ts';

// Checks every link and image in the built site: a page or file on the site
// must exist, as Cloudflare would serve it, and a #heading must exist on its
// page. A link to a file in this repository on GitHub must name a file or
// folder the checkout has, and a #heading in a Markdown file must exist there
// too. Other sites are not fetched.

export interface LinkCheckOptions {
  /** The built site, served at the root of SITE_ORIGIN. */
  distDir: string;
  /** The repository checkout that GitHub links point into. */
  repoDir: string;
  siteOrigin: string;
  repository: string;
  branch: string;
}

export interface DeadLink {
  /** The page, from the site's root, such as docs/agents.html. */
  page: string;
  href: string;
  reason: string;
}

/** Every HTML file under `dir`, as a path with forward slashes from `dir`. */
function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.html'))
    .map((file) => file.split(sep).join('/'));
}

/** An attribute value with the HTML entities a build writes in it turned back into characters. */
function decode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** The ids and anchor names a page defines: the targets a `#fragment` link can reach. */
function ids(html: string): Set<string> {
  return new Set([...html.matchAll(/\s(?:id|name)="([^"]+)"/g)].map((match) => decode(match[1] ?? '')));
}

/** The file Cloudflare's static assets serve for a path, with `auto-trailing-slash` handling. */
function served(distDir: string, path: string): string | undefined {
  const file = join(distDir, path);
  if (path.endsWith('/')) return existsSync(join(file, 'index.html')) ? join(file, 'index.html') : undefined;
  if (existsSync(file) && statSync(file).isFile()) return file;
  if (existsSync(`${file}.html`)) return `${file}.html`;
  if (existsSync(join(file, 'index.html'))) return join(file, 'index.html');
  return undefined;
}

/** The ids GitHub gives the headings of a Markdown file. */
function markdownHeadings(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const slugs = new Set<string>();
  // The open code block's fence. As in CommonMark, a backtick fence whose
  // info string holds a backtick opens nothing, and only a run of the same
  // character, at least as long, with nothing after it, closes the block.
  let fence: { char: string; length: number } | undefined;
  for (const line of markdown.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const run = marker?.[1] ?? '';
    const opens = marker && !(run.startsWith('`') && marker[2]?.includes('`'));
    if (opens && !fence) {
      fence = { char: run.charAt(0), length: run.length };
      continue;
    }
    if (marker && fence && run.charAt(0) === fence.char && run.length >= fence.length && !marker[2]?.trim()) {
      fence = undefined;
      continue;
    }
    const heading = fence ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading?.[1]) continue;
    const text = heading[1].replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '');
    const slug = githubSlug(text);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    slugs.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return slugs;
}

/** The links and images in the built site that lead nowhere, each with the page it is on and why. */
export function checkLinks(options: LinkCheckOptions): DeadLink[] {
  const dead: DeadLink[] = [];
  const pageIds = new Map<string, Set<string>>();
  const idsOf = (file: string) => {
    let found = pageIds.get(file);
    if (!found) {
      found = file.endsWith('.html') ? ids(readFileSync(file, 'utf8')) : new Set();
      pageIds.set(file, found);
    }
    return found;
  };
  const githubFile = new RegExp(
    `^${options.repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:blob|tree|edit)/${options.branch}/([^#?]*)(?:#(.*))?$`,
  );

  for (const page of htmlFiles(options.distDir)) {
    const html = readFileSync(join(options.distDir, page), 'utf8');
    const pagePath = `/${page}`;
    const targets = [
      ...[...html.matchAll(/<a\b[^>]*?\shref="([^"]*)"/g)].map((match) => ({ href: match[1] ?? '', image: false })),
      ...[...html.matchAll(/<(?:img|source)\b[^>]*?\s(?:src|srcset)="([^"]*)"/g)].map((match) => ({
        href: match[1] ?? '',
        image: true,
      })),
      ...[...html.matchAll(/<meta\b[^>]*>/g)].flatMap(([tag]) => {
        if (!/\b(?:property|name)="(?:og:image|twitter:image)"/.test(tag)) return [];
        const href = /\bcontent="([^"]*)"/.exec(tag)?.[1];
        return href ? [{ href, image: true }] : [];
      }),
      ...[...html.matchAll(/<link\b[^>]*>/g)].flatMap(([tag]) => {
        if (!/\brel="(?:icon|apple-touch-icon)"/.test(tag)) return [];
        const href = /\bhref="([^"]*)"/.exec(tag)?.[1];
        return href ? [{ href, image: true }] : [];
      }),
    ];
    for (const { href: raw, image } of targets) {
      const href = decode(raw);
      const report = (reason: string) => dead.push({ page, href, reason });
      if (href === '' || /^(mailto|tel|javascript|data):/i.test(href)) continue;

      const onGitHub = githubFile.exec(href);
      if (onGitHub) {
        const path = decodeURIComponent(onGitHub[1] ?? '').replace(/\/$/, '');
        const file = join(options.repoDir, path);
        if (!existsSync(file)) {
          report(`${path} is not in the repository`);
        } else if (
          onGitHub[2] &&
          path.endsWith('.md') &&
          !markdownHeadings(readFileSync(file, 'utf8')).has(onGitHub[2])
        ) {
          report(`${path} has no heading #${onGitHub[2]}`);
        }
        continue;
      }

      let url: URL;
      try {
        url = new URL(href, `${options.siteOrigin}${pagePath}`);
      } catch {
        report('not a valid address');
        continue;
      }
      if (url.origin !== options.siteOrigin) continue;

      const target = served(options.distDir, decodeURIComponent(url.pathname));
      if (!target) {
        report(image ? 'the image is not in the build' : 'no page or file at this address');
        continue;
      }
      const hash = decodeURIComponent(url.hash.slice(1));
      if (hash && !idsOf(target).has(hash)) {
        report(`${relative(options.distDir, target).split(sep).join(posix.sep)} has no #${hash}`);
      }
    }
  }
  return dead;
}
