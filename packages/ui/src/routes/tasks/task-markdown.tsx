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
 * - an http or https address written inside code, a block or inline, is a
 *   link too, its words unchanged, so a block's Copy button copies them as
 *   written; no other scheme becomes a link;
 * - an image on another site is not loaded, so viewing a task tells that site
 *   nothing; it shows as a link to the image instead.
 *
 * A task id links to its page when its prefix is a project the page knows,
 * and a line `WHAT: …`, `WHY: …`, `WHERE: …`, `FIX: …` or `HOW: …` (the task
 * guide's labelled sections) leads with its label.
 */
import { createContext, useContext, useRef, type ComponentProps, type ReactNode } from 'react';
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
import { Check, Image as ImageIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { CopyButton } from '../../components/ui/copy-button';
import { LINK_CLASS as LINK } from '../../components/ui/linked-text';
import { usePaths, type AppPaths } from '../../lib/paths';
import { cn } from '../../lib/utils';
import { webAddresses } from '../../lib/web-links';
import { TaskPrefixes } from './task-prefixes';

export { TaskPrefixesProvider } from './task-prefixes';

/** The languages a code block is highlighted in, named after its opening fence (```ts). A block in any other
 * language shows plain. A short list keeps the task page's download small. */
const LANGUAGES = { bash, css, diff, javascript, json, markdown, python, sql, typescript, xml, yaml };

const TASK_ID = /\b[a-z0-9]+-[a-z0-9]+(?:\.[0-9]+)*\b/g;
const LABELLED = /^(\s*)(WHAT|WHY|WHERE|FIX|HOW):\s*/;

function scriptOrStyleAfter(raw: string, inside: string | null): string | null {
  const tag = inside ?? raw.match(/^<(script|style)\b/i)?.[1]?.toLowerCase();
  if (!tag) return null;
  // A Markdown HTML block can include more text on the closing tag's line.
  const closes = tag === 'script' ? /<\/script\s*>/i : /<\/style\s*>/i;
  return closes.test(raw) ? null : tag;
}

const markdownParser = unified().use(remarkParse).use(remarkGfm);

/** Readable text for a collapsed comment, including link labels and code. */
export function markdownPlainText(source: string): string {
  function words(node: MdastNodes): string {
    if ('children' in node) {
      const inline = node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell';
      let inside: string | null = null;
      const pieces: string[] = [];
      for (const child of node.children) {
        if (child.type === 'html') inside = scriptOrStyleAfter(child.value, inside);
        else if (inside === null) pieces.push(words(child));
      }
      return pieces.join(inline ? '' : ' ');
    }
    if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
    if (node.type === 'break') return ' ';
    return 'value' in node && node.type !== 'html' ? node.value : '';
  }
  return words(markdownParser.parse(source) as MdastRoot)
    .replace(/\s+/gu, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Checklists: counted and ticked from the same reading of the Markdown that
// draws them, so a box on the page is always the box a tick flips.

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
  visit(markdownParser.parse(source) as MdastRoot);
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
function linkTaskIds(value: string, prefixes: ReadonlySet<string>, taskPath: AppPaths['task']): ElementContent[] {
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

/** `WHAT` as `What`: the page sets nothing in capitals. */
function sentenceCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
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
        properties: { className: ['me-2', 'text-label', 'font-semibold', 'text-ink-3'], dataLabel: '' },
        children: [text(sentenceCase(label[2] ?? ''))],
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
        inside = scriptOrStyleAfter(child.value, inside);
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

const rehypeTaskText: Plugin<[{ prefixes: ReadonlySet<string>; taskPath: AppPaths['task'] }], HastRoot> = ({
  prefixes,
  taskPath,
}) => {
  const visit = (parent: HastRoot | Element, plain: boolean) => {
    if (parent.type === 'element' && parent.tagName === 'p') labelLines(parent);
    const children: ElementContent[] = [];
    // Markdown makes no doctype, so a root's children are an element's kinds.
    for (const child of parent.children as ElementContent[]) {
      if (child.type === 'text') {
        children.push(...(plain ? [child] : linkTaskIds(child.value, prefixes, taskPath)));
        continue;
      }
      if (child.type === 'element') visit(child, plain || ['a', 'code', 'pre'].includes(child.tagName));
      children.push(child);
    }
    parent.children = children;
  };
  return (tree) => visit(tree, false);
};

/**
 * Web addresses inside code, a block or inline, as links. It runs after the
 * highlighter has split a block into tokens, so an address that runs over
 * several tokens is linked piece by piece, each piece to the whole address.
 * Prose needs none of this: GitHub's Markdown already links a bare address.
 */
const rehypeLinkCode: Plugin<[], HastRoot> = () => {
  const linkCode = (code: Element) => {
    const pieces: { node: Text; start: number }[] = [];
    let length = 0;
    const collect = (parent: Element) => {
      for (const child of parent.children) {
        if (child.type === 'text') {
          pieces.push({ node: child, start: length });
          length += child.value.length;
        } else if (child.type === 'element' && child.tagName !== 'a') collect(child);
      }
    };
    collect(code);
    const whole = pieces.map((piece) => piece.node.value).join('');
    const addresses = webAddresses(whole);
    if (addresses.length === 0) return;
    const replaced = new Map<Text, ElementContent[]>();
    for (const { node, start } of pieces) {
      const end = start + node.value.length;
      const out: ElementContent[] = [];
      let at = start;
      for (const address of addresses) {
        if (address.end <= at || address.start >= end) continue;
        const from = Math.max(address.start, at);
        const to = Math.min(address.end, end);
        if (from > at) out.push(text(whole.slice(at, from)));
        out.push({
          type: 'element',
          tagName: 'a',
          properties: { href: address.href },
          children: [text(whole.slice(from, to))],
        });
        at = to;
      }
      if (out.length === 0) continue;
      if (at < end) out.push(text(whole.slice(at, end)));
      replaced.set(node, out);
    }
    const rebuild = (parent: Element) => {
      parent.children = parent.children.flatMap((child): ElementContent[] => {
        if (child.type === 'text') return replaced.get(child) ?? [child];
        if (child.type === 'element' && child.tagName !== 'a') rebuild(child);
        return [child];
      });
    };
    rebuild(code);
  };
  const visit = (parent: HastRoot | Element) => {
    // Markdown makes no doctype, so a root's children are an element's kinds.
    for (const child of parent.children as ElementContent[]) {
      if (child.type !== 'element' || child.tagName === 'a') continue;
      if (child.tagName === 'code') linkCode(child);
      else visit(child);
    }
  };
  return (tree) => visit(tree);
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
  const paths = usePaths();
  const className = cn(LINK, node?.properties.dataTaskId !== undefined && 'nums font-medium');
  // An address the sanitizer removed, such as a javascript: link, leaves the words alone.
  if (href === '') return <span>{children}</span>;
  const url = resolved(href);
  // A fragment points into this page, and mailto: opens the mail app: neither opens a tab.
  if (href.startsWith('#') || url === null) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }
  if (sameSite(url)) {
    const path = `${url.pathname}${url.search}${url.hash}`;
    return paths.isAppPage(url.pathname) ? (
      <Link to={path} className={className}>
        {children}
      </Link>
    ) : (
      <a href={path} className={className}>
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
      className={cn(LINK, 'inline-flex items-center gap-1')}
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
      <li className="relative list-none ps-7" data-checklist-item="">
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
  // A ticked box is filled in Accent, the colour of a selected control.
  const box = (
    <span
      aria-hidden
      className={cn(
        'grid size-[15px] place-items-center rounded-sm',
        done ? 'bg-accent text-on-accent' : 'bg-background inset-ring-[1.5px] inset-ring-border-strong',
      )}
    >
      {done ? <Check size={11} strokeWidth={3} /> : null}
    </span>
  );
  // The box sits on the first line of its words: centred in a 25 px line.
  const place = 'absolute start-0 top-[5px]';
  if (!onToggleTask || line === null) {
    return (
      <span
        role="checkbox"
        aria-checked={done}
        aria-disabled
        aria-label={label}
        className={cn(place, 'inline-flex')}
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
      className={cn(
        place,
        // A larger press area than the box, around it.
        '-m-1 rounded-sm p-1 outline-none focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45',
      )}
      data-checkbox={done ? 'done' : 'open'}
    >
      {box}
    </button>
  );
}

/**
 * A Markdown heading sits under the page's own headings in the document's
 * outline (# is drawn at level 3), but at a size of its own above the text:
 * # 18 px, ## 16 px, the rest 15 px in semibold.
 */
/**
 * A code block, with a Copy button in its corner that copies the block's
 * text as written, without the line break that ends every block. A pointer
 * shows the button on hover; it shows always on a device with a touch screen.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const block = useRef<HTMLPreElement>(null);
  return (
    <div className="group/code relative">
      <pre
        ref={block}
        className="m-0 overflow-x-auto rounded-lg bg-surface px-4 py-3.5 font-mono text-code text-ink inset-ring inset-ring-border"
      >
        {children}
      </pre>
      <CopyButton
        label="Copy the code"
        target={block}
        text={() => (block.current?.textContent ?? '').replace(/\n$/, '')}
        className="absolute top-2 right-2 bg-surface opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100 data-copied:opacity-100 any-pointer-coarse:opacity-100"
      />
    </div>
  );
}

function heading(level: 3 | 4 | 5 | 6, size: string) {
  const Tag = `h${level}` as const;
  return function Heading({ children }: { children?: ReactNode }) {
    return <Tag className={cn('m-0 font-semibold text-ink', size)}>{children}</Tag>;
  };
}

const COMPONENTS: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  li: ListItem,
  input: Checkbox,
  h1: heading(3, 'text-heading'),
  h2: heading(4, 'text-[16px] leading-6'),
  h3: heading(5, 'text-body'),
  h4: heading(6, 'text-body'),
  h5: heading(6, 'text-body'),
  h6: heading(6, 'text-body'),
  p: ({ children }) => <p className="m-0">{children}</p>,
  ul: ({ className, children }) =>
    typeof className === 'string' && className.includes('contains-task-list') ? (
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-checklist="">
        {children}
      </ul>
    ) : (
      <ul className="m-0 flex list-disc flex-col gap-0.5 ps-5.5 marker:text-ink-3">{children}</ul>
    ),
  ol: ({ start, children }) => (
    <ol start={start} className="m-0 flex list-decimal flex-col gap-0.5 ps-5.5 marker:text-ink-3">
      {children}
    </ol>
  ),
  blockquote: ({ children }) => (
    <blockquote className="m-0 flex flex-col gap-2 border-s-2 border-border-strong ps-3 text-ink-2">
      {children}
    </blockquote>
  ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto">
      {/* Words in a cell stay whole, so a wide table scrolls in its box instead of breaking them. */}
      <table className="w-full border-collapse text-left text-sm [overflow-wrap:break-word]">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th className="border border-border bg-surface px-2 py-1 font-semibold" style={alignOnly(style)}>
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td className="border border-border px-2 py-1 align-top" style={alignOnly(style)}>
      {children}
    </td>
  ),
  hr: () => <hr className="m-0 border-border" />,
  del: ({ children }) => <del className="text-ink-3">{children}</del>,
};

/** A table column's alignment, which the Markdown sets as a style: the only style the page keeps from it. */
function alignOnly(style: ComponentProps<'td'>['style']): ComponentProps<'td'>['style'] {
  const align = style?.textAlign;
  return align === 'left' || align === 'center' || align === 'right' ? { textAlign: align } : undefined;
}

/**
 * Markdown as React elements, at the body size (15/25) unless `className`
 * sets another. With `onToggleTask`, a checklist's boxes are buttons that
 * hand back the line they sit on.
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
  const paths = usePaths();
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-3.5 text-body text-ink [overflow-wrap:anywhere]',
        // A heading takes more room above it than below, so it reads with the text it heads.
        '[&>*+:is(h3,h4,h5,h6)]:mt-2 [&>:is(h3,h4,h5,h6)+*]:-mt-2',
        '[&_:not(pre)>code]:rounded-sm [&_:not(pre)>code]:bg-surface [&_:not(pre)>code]:px-1.25 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.87em] [&_:not(pre)>code]:inset-ring [&_:not(pre)>code]:inset-ring-border',
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
            [rehypeTaskText, { prefixes, taskPath: paths.task }],
            [rehypeHighlight, { languages: LANGUAGES, detect: false }],
            rehypeLinkCode,
          ]}
          components={COMPONENTS}
        >
          {source}
        </Markdown>
      </ChecklistToggle.Provider>
    </div>
  );
}
