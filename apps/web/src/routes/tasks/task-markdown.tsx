/**
 * Task text, drawn from Markdown: a description, Done when, notes, design and
 * comments. It reads CommonMark with GitHub's additions (tables, task lists,
 * strikethrough, bare links), and a line break in the text is a line break on
 * the page, as in a GitHub comment, because agents write labelled lines one
 * under another.
 *
 * People and agents write this text, so the page trusts none of it:
 * - raw HTML in the text is dropped, never drawn;
 * - what the Markdown makes passes GitHub's sanitizer rules (`defaultSchema`),
 *   which remove scripts, event-handler attributes, inline styles and every
 *   address that is not http(s), mailto or relative;
 * - a link to another site opens in a new tab with no opener and no referrer;
 * - an image on another site is not loaded, so viewing a task tells that site
 *   nothing; it shows as a link to the image instead.
 *
 * A task id links to its page when its prefix is a project the page knows,
 * and a line `WHAT: …`, `WHY: …`, `WHERE: …`, `FIX: …` or `HOW: …` (the task
 * guide's labelled sections) leads with its label.
 */
import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';
import Markdown, { type Components, type ExtraProps } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified, type Plugin } from 'unified';
import type { Element, ElementContent, Root as HastRoot, Text } from 'hast';
import type { Nodes as MdastNodes, Root as MdastRoot } from 'mdast';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { CheckSquare, Image as ImageIcon, Square } from 'lucide-react';
import { Link } from 'react-router-dom';
import { eyebrowClass, inlineLinkClass } from '@/components/ui/chrome';
import { taskPath } from '@/lib/task-path';
import { cn } from '@/lib/utils';

/** The task id prefixes a text may link. */
const TaskPrefixes = createContext<ReadonlySet<string>>(new Set());
export const TaskPrefixesProvider = TaskPrefixes.Provider;

/** The languages a code block is highlighted in, named after its opening fence (```ts). A block in any other
 * language shows plain. A short list keeps the task page's download small. */
const LANGUAGES = { bash, css, diff, javascript, json, markdown, python, sql, typescript, xml, yaml };

const TASK_ID = /\b[a-z0-9]+-[a-z0-9]+(?:\.[0-9]+)*\b/g;
const LABELLED = /^(\s*)(WHAT|WHY|WHERE|FIX|HOW):\s*/;

// ---------------------------------------------------------------------------
// Checklists: counted and ticked from the same reading of the Markdown that
// draws them, so a box on the page is always the box a tick flips.

const checklistParser = unified().use(remarkParse).use(remarkGfm);

interface Checkbox {
  /** 0-based line the box's list item starts on. */
  line: number;
  /** Where in the text the list item starts. */
  offset: number;
  done: boolean;
}

function checkboxes(source: string): Checkbox[] {
  const found: Checkbox[] = [];
  const visit = (node: MdastNodes) => {
    if (node.type === 'listItem' && typeof node.checked === 'boolean' && node.position) {
      found.push({ line: node.position.start.line - 1, offset: node.position.start.offset ?? 0, done: node.checked });
    }
    if ('children' in node) for (const child of node.children) visit(child);
  };
  visit(checklistParser.parse(source) as MdastRoot);
  return found;
}

/** How many of a text's checkboxes are ticked. */
export function taskListItems(source: string): { done: number; total: number } {
  const boxes = checkboxes(source);
  return { done: boxes.filter((box) => box.done).length, total: boxes.length };
}

/** The text with the checkbox on line `line` (0-based) flipped, every other character as it was. */
export function toggleTaskListLine(source: string, line: number): string {
  const box = checkboxes(source).find((candidate) => candidate.line === line);
  if (!box) return source;
  const marker = /\[([ xX])\]/g;
  marker.lastIndex = box.offset;
  const match = marker.exec(source);
  if (!match || /[\r\n]/.test(source.slice(box.offset, match.index))) return source;
  const at = match.index + 1;
  return source.slice(0, at) + (match[1] === ' ' ? 'x' : ' ') + source.slice(at + 1);
}

// ---------------------------------------------------------------------------
// The page's own additions, made after the sanitizer has run, from text alone.

function text(value: string): Text {
  return { type: 'text', value };
}

/** Task ids in a text, as links to their pages; everything else as it was. */
function linkTaskIds(value: string, prefixes: ReadonlySet<string>): ElementContent[] {
  const out: ElementContent[] = [];
  let last = 0;
  for (const match of value.matchAll(TASK_ID)) {
    const id = match[0];
    if (!prefixes.has(id.slice(0, id.indexOf('-')))) continue;
    if (match.index > last) out.push(text(value.slice(last, match.index)));
    out.push({
      type: 'element',
      tagName: 'a',
      properties: { href: taskPath(id), dataTaskId: id },
      children: [text(id)],
    });
    last = match.index + id.length;
  }
  if (last === 0) return [text(value)];
  if (last < value.length) out.push(text(value.slice(last)));
  return out;
}

/** A paragraph line that opens with a section label leads with it. */
function labelLines(paragraph: Element): void {
  let lineStart = true;
  paragraph.children = paragraph.children.flatMap((child): ElementContent[] => {
    if (child.type === 'element' && child.tagName === 'br') {
      lineStart = true;
      return [child];
    }
    // A line break is drawn as <br> and then the newline itself, which is not yet the line's words.
    if (child.type === 'text' && child.value.trim() === '') return [child];
    const starts = lineStart;
    lineStart = false;
    if (!starts || child.type !== 'text') return [child];
    const label = LABELLED.exec(child.value);
    if (!label) return [child];
    return [
      text(label[1] ?? ''),
      {
        type: 'element',
        tagName: 'span',
        properties: { className: [eyebrowClass, 'me-2'], dataLabel: '' },
        children: [text(label[2]?.toLowerCase() ?? '')],
      },
      text(child.value.slice(label[0].length)),
    ];
  });
}

/**
 * Raw HTML reaches the page as `raw` pieces, which the sanitizer drops. A
 * `<script>` or `<style>` written inside a sentence arrives as three pieces:
 * its opening tag, its contents as ordinary text, and its closing tag. This
 * drops the contents with the tags, so no script's words are shown either.
 */
const rehypeDropScriptText: Plugin<[], HastRoot> = () => {
  const visit = (parent: HastRoot | Element) => {
    let inside: string | null = null;
    const kept: ElementContent[] = [];
    for (const child of parent.children as ElementContent[]) {
      if (child.type === 'raw') {
        const open = /^<(script|style)\b/i.exec(child.value);
        if (open && !new RegExp(`</${open[1]}\\s*>\\s*$`, 'i').test(child.value))
          inside = open[1]?.toLowerCase() ?? null;
        else if (inside !== null && new RegExp(`^</${inside}\\s*>`, 'i').test(child.value)) inside = null;
        continue;
      }
      if (inside !== null) continue;
      if (child.type === 'element') visit(child);
      kept.push(child);
    }
    parent.children = kept;
  };
  return (tree) => visit(tree);
};

const rehypeTaskText: Plugin<[{ prefixes: ReadonlySet<string> }], HastRoot> = ({ prefixes }) => {
  const visit = (parent: HastRoot | Element, plain: boolean) => {
    if (parent.type === 'element' && parent.tagName === 'p') labelLines(parent);
    const children: ElementContent[] = [];
    // Markdown makes no doctype, so a root's children are an element's kinds.
    for (const child of parent.children as ElementContent[]) {
      if (child.type === 'text') {
        children.push(...(plain ? [child] : linkTaskIds(child.value, prefixes)));
        continue;
      }
      if (child.type === 'element') visit(child, plain || ['a', 'code', 'pre'].includes(child.tagName));
      children.push(child);
    }
    parent.children = children;
  };
  return (tree) => visit(tree, false);
};

// ---------------------------------------------------------------------------
// How each element is drawn.

/** The address `href` points to, read against this page; null when it is not a web address. */
function resolved(href: string): URL | null {
  try {
    const url = new URL(href, window.location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function sameSite(url: URL | null): boolean {
  return url !== null && url.origin === window.location.origin;
}

function MarkdownLink({ href = '', children, node }: ComponentProps<'a'> & ExtraProps) {
  const className = cn(
    inlineLinkClass,
    'underline',
    node?.properties.dataTaskId !== undefined && 'font-mono text-[0.9em]',
  );
  // An address the sanitizer removed, such as a javascript: link, leaves the words alone.
  if (href === '') return <span>{children}</span>;
  const url = resolved(href);
  if (url !== null && sameSite(url) && !href.startsWith('#')) {
    return (
      <Link to={`${url.pathname}${url.search}${url.hash}`} className={className}>
        {children}
      </Link>
    );
  }
  if (url === null) {
    // mailto: or a fragment on this page: nothing to open in a new tab.
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}

function MarkdownImage({ src, alt }: ComponentProps<'img'> & ExtraProps) {
  const url = typeof src === 'string' ? resolved(src) : null;
  if (url === null) return alt ? <span>{alt}</span> : null;
  if (sameSite(url)) return <img src={url.href} alt={alt ?? ''} loading="lazy" className="max-w-full rounded-md" />;
  return (
    <a
      href={url.href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(inlineLinkClass, 'inline-flex items-center gap-1 underline')}
      data-image-link=""
    >
      <ImageIcon aria-hidden className="size-3.5 shrink-0" />
      {alt || url.host}
    </a>
  );
}

/** The list item a checkbox sits in: its 0-based line, and its words, which name the box. */
const ChecklistItem = createContext<{ line: number | null; label: string }>({ line: null, label: '' });

/** An element's words, leaving out any list nested in it. */
function wordsOf(node: Element | ElementContent): string {
  if (node.type === 'text') return node.value;
  if (node.type !== 'element' || node.tagName === 'ul' || node.tagName === 'ol') return '';
  return node.children.map(wordsOf).join('');
}

interface Toggle {
  onToggleTask: ((line: number) => void) | undefined;
  disabled: boolean;
}
const ChecklistToggle = createContext<Toggle>({ onToggleTask: undefined, disabled: false });

function ListItem({ node, className, children }: ComponentProps<'li'> & ExtraProps) {
  const start = node?.position?.start.line;
  const isTask = typeof className === 'string' && className.includes('task-list-item');
  if (!isTask || !node) return <li>{children}</li>;
  const item = { line: start === undefined ? null : start - 1, label: wordsOf(node).trim() };
  return (
    <ChecklistItem.Provider value={item}>
      <li className="relative list-none ps-6" data-checklist-item="">
        {children}
      </li>
    </ChecklistItem.Provider>
  );
}

function Checkbox({ type, checked }: ComponentProps<'input'> & ExtraProps) {
  const { line, label } = useContext(ChecklistItem);
  const { onToggleTask, disabled } = useContext(ChecklistToggle);
  if (type !== 'checkbox') return null;
  const done = checked === true;
  const Box = done ? CheckSquare : Square;
  const box = <Box aria-hidden className={cn('size-4 shrink-0', done ? 'text-foreground' : 'text-muted-foreground')} />;
  if (!onToggleTask || line === null) {
    return (
      <span
        role="checkbox"
        aria-checked={done}
        aria-disabled
        aria-label={label}
        className="absolute start-0 top-0.5 inline-flex"
        data-checkbox={done ? 'done' : 'open'}
      >
        {box}
      </span>
    );
  }
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={label}
      disabled={disabled}
      onClick={() => onToggleTask(line)}
      className="absolute start-0 top-0.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 max-sm:top-0 max-sm:min-h-11"
      data-checkbox={done ? 'done' : 'open'}
    >
      {box}
    </button>
  );
}

/** A Markdown heading sits under the page's own headings: # is drawn at level 3. */
function heading(level: 3 | 4 | 5 | 6, size: string) {
  const Tag = `h${level}` as const;
  return function Heading({ children }: { children?: ReactNode }) {
    return <Tag className={cn('m-0 font-semibold text-foreground', size)}>{children}</Tag>;
  };
}

const COMPONENTS: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  li: ListItem,
  input: Checkbox,
  h1: heading(3, 'text-base'),
  h2: heading(4, 'text-sm'),
  h3: heading(5, 'text-sm'),
  h4: heading(6, 'text-sm'),
  h5: heading(6, 'text-sm'),
  h6: heading(6, 'text-sm'),
  p: ({ children }) => <p className="m-0">{children}</p>,
  ul: ({ className, children }) =>
    typeof className === 'string' && className.includes('contains-task-list') ? (
      <ul className="m-0 flex list-none flex-col gap-1 p-0" data-checklist="">
        {children}
      </ul>
    ) : (
      <ul className="m-0 flex list-disc flex-col gap-1 ps-5">{children}</ul>
    ),
  ol: ({ start, children }) => (
    <ol start={start} className="m-0 flex list-decimal flex-col gap-1 ps-5">
      {children}
    </ol>
  ),
  blockquote: ({ children }) => (
    <blockquote className="m-0 flex flex-col gap-2 border-s-2 border-border ps-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre className="m-0 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs leading-relaxed">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto">
      {/* Words in a cell stay whole, so a wide table scrolls in its box instead of breaking them. */}
      <table className="w-full border-collapse text-left text-sm [overflow-wrap:break-word]">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th className="border border-border bg-muted px-2 py-1 font-medium" style={alignOnly(style)}>
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td className="border border-border px-2 py-1 align-top" style={alignOnly(style)}>
      {children}
    </td>
  ),
  hr: () => <hr className="m-0 border-border" />,
  del: ({ children }) => <del className="text-muted-foreground">{children}</del>,
};

/** A table column's alignment, which the Markdown sets as a style: the only style the page keeps from it. */
function alignOnly(style: ComponentProps<'td'>['style']): ComponentProps<'td'>['style'] {
  const align = style?.textAlign;
  return align === 'left' || align === 'center' || align === 'right' ? { textAlign: align } : undefined;
}

/**
 * Markdown as React elements. With `onToggleTask`, a checklist's boxes are
 * buttons that hand back the line they sit on.
 */
export function MarkdownText({
  source,
  onToggleTask,
  toggleDisabled = false,
  className,
}: {
  source: string;
  onToggleTask?: (line: number) => void;
  toggleDisabled?: boolean;
  className?: string;
}) {
  const prefixes = useContext(TaskPrefixes);
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-2 text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]',
        '[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em]',
        className,
      )}
      data-markdown=""
    >
      <ChecklistToggle.Provider value={{ onToggleTask, disabled: toggleDisabled }}>
        <Markdown
          skipHtml
          remarkPlugins={[remarkGfm, remarkBreaks]}
          rehypePlugins={[
            rehypeDropScriptText,
            [rehypeSanitize, defaultSchema],
            [rehypeTaskText, { prefixes }],
            [rehypeHighlight, { languages: LANGUAGES, detect: false }],
          ]}
          components={COMPONENTS}
        >
          {source}
        </Markdown>
      </ChecklistToggle.Provider>
    </div>
  );
}
