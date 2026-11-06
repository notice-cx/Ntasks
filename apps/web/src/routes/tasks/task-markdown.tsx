/**
 * The Markdown a task's description, Done when and comments are written in,
 * drawn as React elements. It emits no raw HTML, links only `http(s)` and
 * `mailto:` addresses, and links a task id to its page when the id's prefix
 * is one of the projects the page knows. A line `WHAT: …`, `WHY: …`,
 * `WHERE: …` or `FIX: …` (the task guide's labelled sections) leads with
 * its label.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CheckSquare, Square } from 'lucide-react';
import { eyebrowClass, inlineLinkClass } from '@/components/ui/chrome';
import { taskPath } from '@/lib/task-path';
import { cn } from '@/lib/utils';

/** The task id prefixes a text may link. */
const TaskPrefixes = createContext<ReadonlySet<string>>(new Set());
export const TaskPrefixesProvider = TaskPrefixes.Provider;

const CHECKBOX = /^(\s*)[-*+]\s+\[([ xX])\]\s?(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const LABELLED = /^(WHAT|WHY|WHERE|FIX|HOW):\s*(.*)$/;

/** How many of a text's checkboxes are ticked. */
export function taskListItems(source: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const line of source.split('\n')) {
    const match = CHECKBOX.exec(line);
    if (!match) continue;
    total += 1;
    if (match[2] !== ' ') done += 1;
  }
  return { done, total };
}

/** The text with the checkbox on line `line` (0-based) flipped. */
export function toggleTaskListLine(source: string, line: number): string {
  const lines = source.split('\n');
  const target = lines[line];
  if (target === undefined) return source;
  const match = CHECKBOX.exec(target);
  if (!match) return source;
  lines[line] = target.replace(/\[([ xX])\]/, match[2] === ' ' ? '[x]' : '[ ]');
  return lines.join('\n');
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'checklist'; items: { text: string; done: boolean; line: number }[] }
  | { kind: 'paragraph'; lines: string[] };

function blocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] ?? '';
    if (line.trim() === '') {
      at += 1;
      continue;
    }
    if (line.trimStart().startsWith('```')) {
      const body: string[] = [];
      at += 1;
      while (at < lines.length && !(lines[at] ?? '').trimStart().startsWith('```')) body.push(lines[at++] ?? '');
      at += 1;
      out.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
      at += 1;
      continue;
    }
    if (CHECKBOX.test(line)) {
      const items: { text: string; done: boolean; line: number }[] = [];
      while (at < lines.length) {
        const match = CHECKBOX.exec(lines[at] ?? '');
        if (!match) break;
        items.push({ text: match[3] ?? '', done: match[2] !== ' ', line: at });
        at += 1;
      }
      out.push({ kind: 'checklist', items });
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (at < lines.length && !CHECKBOX.test(lines[at] ?? '')) {
        const match = pattern.exec(lines[at] ?? '');
        if (!match) break;
        items.push(match[1] ?? '');
        at += 1;
      }
      out.push({ kind: 'list', ordered, items });
      continue;
    }
    if (line.startsWith('>')) {
      const quoted: string[] = [];
      while (at < lines.length && (lines[at] ?? '').startsWith('>'))
        quoted.push((lines[at++] ?? '').replace(/^>\s?/, ''));
      out.push({ kind: 'quote', lines: quoted });
      continue;
    }
    const paragraph: string[] = [];
    while (at < lines.length) {
      const next = lines[at] ?? '';
      if (
        next.trim() === '' ||
        HEADING.test(next) ||
        BULLET.test(next) ||
        NUMBERED.test(next) ||
        next.trimStart().startsWith('```') ||
        next.startsWith('>')
      )
        break;
      paragraph.push(next);
      at += 1;
    }
    out.push({ kind: 'paragraph', lines: paragraph });
  }
  return out;
}

const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(\b[a-z0-9]+-[a-z0-9]+(?:\.[0-9]+)*\b)|((?<![\w*])\*[^*\s][^*]*\*(?!\w))|((?<!\w)_[^_\s][^_]*_(?!\w))/g;

function safeHref(href: string): string | null {
  return /^(?:https?:\/\/|mailto:)/i.test(href) ? href : null;
}

function inline(text: string, prefixes: ReadonlySet<string>, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const whole = match[0];
    const id = `${key}-${n++}`;
    if (match[1]) {
      out.push(
        <code key={id} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {whole.slice(1, -1)}
        </code>,
      );
    } else if (match[2]) {
      out.push(
        <strong key={id} className="font-semibold">
          {whole.slice(2, -2)}
        </strong>,
      );
    } else if (match[3]) {
      const split = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(whole);
      const href = safeHref(split?.[2] ?? '');
      out.push(
        href ? (
          <a
            key={id}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className={cn(inlineLinkClass, 'underline')}
          >
            {split?.[1]}
          </a>
        ) : (
          (split?.[1] ?? whole)
        ),
      );
    } else if (match[4]) {
      out.push(
        <a
          key={id}
          href={whole}
          target="_blank"
          rel="noreferrer noopener"
          className={cn(inlineLinkClass, 'underline [overflow-wrap:anywhere]')}
        >
          {whole}
        </a>,
      );
    } else if (match[5]) {
      const prefix = whole.slice(0, whole.indexOf('-'));
      out.push(
        prefixes.has(prefix) ? (
          <Link key={id} to={taskPath(whole)} className={cn(inlineLinkClass, 'font-mono text-[0.9em] underline')}>
            {whole}
          </Link>
        ) : (
          whole
        ),
      );
    } else {
      out.push(<em key={id}>{whole.slice(1, -1)}</em>);
    }
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
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
        className,
      )}
      data-markdown=""
    >
      {blocks(source).map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case 'heading':
            return (
              <p key={key} className={cn('m-0 font-semibold', block.level === 1 ? 'text-base' : 'text-sm')}>
                {inline(block.text, prefixes, key)}
              </p>
            );
          case 'code':
            return (
              <pre key={key} className="m-0 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
                <code>{block.text}</code>
              </pre>
            );
          case 'quote':
            return (
              <blockquote key={key} className="m-0 border-s-2 border-border ps-3 text-muted-foreground">
                {block.lines.map((line, at) => (
                  <p key={at} className="m-0">
                    {inline(line, prefixes, `${key}-${at}`)}
                  </p>
                ))}
              </blockquote>
            );
          case 'list': {
            const List = block.ordered ? 'ol' : 'ul';
            return (
              <List
                key={key}
                className={cn('m-0 flex flex-col gap-1 ps-5', block.ordered ? 'list-decimal' : 'list-disc')}
              >
                {block.items.map((item, at) => (
                  <li key={at}>{inline(item, prefixes, `${key}-${at}`)}</li>
                ))}
              </List>
            );
          }
          case 'checklist':
            return (
              <ul key={key} className="m-0 flex list-none flex-col gap-1 p-0" data-checklist="">
                {block.items.map((item) => {
                  const Box = item.done ? CheckSquare : Square;
                  const box = (
                    <Box
                      aria-hidden
                      className={cn('mt-0.5 size-4 shrink-0', item.done ? 'text-foreground' : 'text-muted-foreground')}
                    />
                  );
                  return (
                    <li
                      key={item.line}
                      className="flex items-start gap-2"
                      data-checklist-item={item.done ? 'done' : 'open'}
                    >
                      {onToggleTask ? (
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={item.done}
                          aria-label={item.text}
                          disabled={toggleDisabled}
                          onClick={() => onToggleTask(item.line)}
                          className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 max-sm:min-h-11"
                        >
                          {box}
                        </button>
                      ) : (
                        box
                      )}
                      <span className={cn(item.done && 'text-muted-foreground')}>
                        {inline(item.text, prefixes, `${key}-${item.line}`)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            );
          case 'paragraph':
            return (
              <p key={key} className="m-0">
                {block.lines.map((line, at) => {
                  const labelled = LABELLED.exec(line);
                  return (
                    <span key={at} className="block">
                      {labelled ? (
                        <>
                          <span className={cn(eyebrowClass, 'me-2')}>{labelled[1]?.toLowerCase()}</span>
                          {inline(labelled[2] ?? '', prefixes, `${key}-${at}`)}
                        </>
                      ) : (
                        inline(line, prefixes, `${key}-${at}`)
                      )}
                    </span>
                  );
                })}
              </p>
            );
        }
      })}
    </div>
  );
}
