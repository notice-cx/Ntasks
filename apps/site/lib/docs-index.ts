import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The docs' sidebar is docs/index.md: each `## ` heading there is a group,
// and each `- [Title](page.md)` line under it a page, in order. A page in
// docs/ that index.md does not list is still built, and goes in a last group
// so it can be found.

export interface SidebarGroup {
  text: string;
  items: { text: string; link: string }[];
}

export const UNLISTED_GROUP = 'More';

/** The first `# ` heading of a page. */
export function pageTitle(markdown: string): string | undefined {
  return /^# (.+)$/m.exec(markdown)?.[1]?.trim();
}

/** The first paragraph under a page's title, as plain text, for its description. */
export function pageSummary(markdown: string): string | undefined {
  const lines = markdown.split('\n');
  const title = lines.findIndex((line) => line.startsWith('# '));
  if (title === -1) return undefined;
  const start = lines.findIndex((line, i) => i > title && line.trim() !== '');
  if (start === -1) return undefined;
  const first = lines[start] ?? '';
  if (/^\s*(<|```|\||#|-|\d+\.|>)/.test(first)) return undefined;
  const end = lines.findIndex((line, i) => i > start && line.trim() === '');
  const text = lines
    .slice(start, end === -1 ? undefined : end)
    .join(' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Emphasis marks go; an underscore inside a name such as AUTH_SECRET stays.
    .replace(/[`*]|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || undefined;
}

export interface IndexPage {
  text: string;
  file: string;
  /** The words after the link, such as "the problems Ntasks solves, with their sources." */
  description: string;
}

/** The groups and pages docs/index.md lists. */
export function readIndex(markdown: string): { text: string; files: IndexPage[] }[] {
  const groups: { text: string; files: IndexPage[] }[] = [];
  let page: IndexPage | undefined;
  for (const line of markdown.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    const item = /^[-*] \[([^\]]+)\]\(([^)#\s]+\.md)\):?\s*(.*)$/.exec(line);
    if (heading?.[1]) {
      groups.push({ text: heading[1].trim(), files: [] });
      page = undefined;
    } else if (item?.[1] && item[2]) {
      page = { text: item[1], file: item[2], description: item[3]?.trim() ?? '' };
      groups.at(-1)?.files.push(page);
    } else if (page && /^\s+\S/.test(line)) {
      page.description = `${page.description} ${line.trim()}`.trim();
    } else {
      page = undefined;
    }
  }
  return groups.filter((group) => group.files.length > 0);
}

/** A page's address in the sidebar: its file name without `.md`, under the docs' base. */
function link(file: string): string {
  return `/${file.replace(/\.md$/, '')}`;
}

/** The sidebar for the docs in `docsDir`. */
export function docsSidebar(docsDir: string): SidebarGroup[] {
  const read = (file: string) => readFileSync(join(docsDir, file), 'utf8');
  const groups = readIndex(read('index.md'));
  const listed = new Set(groups.flatMap((group) => group.files.map((page) => page.file)));
  const unlisted = readdirSync(docsDir)
    .filter((file) => file.endsWith('.md') && file !== 'index.md' && !listed.has(file))
    .sort()
    .map((file) => ({ text: pageTitle(read(file)) ?? file, file, description: pageSummary(read(file)) ?? '' }));
  if (unlisted.length > 0) groups.push({ text: UNLISTED_GROUP, files: unlisted });
  return groups.map((group) => ({
    text: group.text,
    items: group.files.map((page) => ({ text: page.text, link: link(page.file) })),
  }));
}
