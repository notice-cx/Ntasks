import { ChevronDown, CircleAlert, Plus, X } from 'lucide-react';
import { Component, lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { NewTask, TaskProject } from '../api/types';
import { Badge } from './ui/badge';
import { Button, IconButton } from './ui/button';
import { Tabs } from './ui/choice';
import { Field, Input, Select, Textarea } from './ui/field';
import { usePortalContainer } from './ui/popover';
import { useCreateTask, useRetryKey } from '../hooks/useTasks';
import { PRIORITY_LABELS, typeLabel } from '../lib/symbols';
import { usePaths } from '../lib/paths';
import { cn } from '../lib/utils';
import { TaskPrefixesProvider } from '../routes/tasks/task-prefixes';

// The Markdown renderer is about 100 kB compressed, and the board, where the
// composer opens, has no other use for it: it loads when a preview is asked for.
let renderer: Promise<typeof import('../routes/tasks/task-markdown')> | null = null;

/** The renderer's module, read once. A failed read is forgotten, so the next attempt asks again. */
function loadRenderer(): Promise<typeof import('../routes/tasks/task-markdown')> {
  renderer ??= import('../routes/tasks/task-markdown').catch((error: unknown) => {
    renderer = null;
    throw error;
  });
  return renderer;
}

/** React keeps a lazy component's failed load for good, so each attempt is a new one. */
function lazyRenderer() {
  return lazy(() => loadRenderer().then((module) => ({ default: module.MarkdownText })));
}

/** Catches a preview that failed to load, so the composer and its draft stay as they are. */
class PreviewBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** The description drawn as it will show on the task's page, with its task ids linked. */
function DescriptionPreview({ source, prefixes }: { source: string; prefixes: ReadonlySet<string> }) {
  const [attempt, setAttempt] = useState(0);
  const [Renderer, setRenderer] = useState(lazyRenderer);
  const failed = (
    <div className="flex flex-col items-start gap-2" data-preview-failed="">
      <span className="flex items-center gap-1.5 text-meta text-ink">
        <CircleAlert aria-hidden size={14} className="shrink-0 text-ink-2" />
        The preview could not load
      </span>
      <p className="m-0 whitespace-pre-wrap text-ink-2">{source}</p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => {
          setRenderer(lazyRenderer);
          setAttempt((count) => count + 1);
        }}
      >
        Try again
      </Button>
    </div>
  );
  return (
    <PreviewBoundary key={attempt} fallback={failed}>
      <Suspense fallback={<span className="text-ink-3">Loading…</span>}>
        <TaskPrefixesProvider value={prefixes}>
          <Renderer source={source} />
        </TaskPrefixesProvider>
      </Suspense>
    </PreviewBoundary>
  );
}

/** The types a new task can take; decisions and approvals are opened by agents with their options. */
const TASK_TYPES = ['task', 'bug', 'feature', 'chore', 'epic'] as const;

/** A Done when text as the editor's lines: each line's own words, without its checkbox. */
export function acceptanceLines(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]\s+)?(?:\[[ xX]\]\s*)?/, '').trim())
    .filter((line) => line !== '');
  return lines.length > 0 ? lines : [''];
}

/** The editor's lines as the checklist a task's Done when holds, blank lines dropped. */
export function acceptanceText(lines: readonly string[]): string {
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => `- [ ] ${line}`)
    .join('\n');
}

export interface ComposerPrefill {
  project?: string;
  title?: string;
}

/**
 * File a task. Title, project and priority are the first screen and Enter
 * files; the rest waits under More. The task is filed only on a press, and
 * the toast that follows opens its page.
 */
export function TaskComposer({
  open,
  onClose,
  projects,
  loading = false,
  prefill = null,
}: {
  open: boolean;
  onClose: () => void;
  projects: readonly TaskProject[];
  /** The project list is still on its way: nothing can be filed against it yet. */
  loading?: boolean;
  prefill?: ComposerPrefill | null;
}) {
  const titleId = useId();
  const fieldId = useId();
  const navigate = useNavigate();
  const paths = usePaths();
  const container = usePortalContainer();
  const createTask = useCreateTask();
  const [project, setProject] = useState('');
  const [title, setTitle] = useState('');
  const [type, setType] = useState('task');
  const [priority, setPriority] = useState(2);
  const [parent, setParent] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [labelDraft, setLabelDraft] = useState('');
  const [description, setDescription] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [lines, setLines] = useState<string[]>(['']);
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const lineRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [more, setMore] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [filing, setFiling] = useState(false);
  // Set at once, where state would wait for the next render: a second press in the same moment files nothing.
  const inFlight = useRef(false);
  const retryKey = useRetryKey();

  // Seeded once per opening, so a project list arriving later never resets what was typed.
  const seeded = useRef(false);
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (seeded.current) return;
    seeded.current = true;
    setProject(prefill?.project ?? '');
    setTitle(prefill?.title ?? '');
    setType('task');
    setPriority(2);
    setParent('');
    setLabels([]);
    setLabelDraft('');
    setDescription('');
    setPreviewing(false);
    setLines(['']);
    setMore(false);
    setErrors({});
  }, [open, prefill]);

  // The only project is picked when the list arrives, unless one is chosen or
  // prefilled. The prefill is checked itself: on the render that opens the
  // composer, `project` still holds the value from before the seeding above.
  useEffect(() => {
    if (!open || project !== '' || prefill?.project || projects.length !== 1) return;
    setProject(projects[0]?.logicalKey ?? '');
  }, [open, project, prefill, projects]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (focusLine === null) return;
    lineRefs.current[focusLine]?.focus();
    setFocusLine(null);
  }, [focusLine, lines.length]);

  if (!open) return null;

  const chosen = projects.find((entry) => entry.logicalKey === project) ?? null;

  function addLabel() {
    const value = labelDraft.trim();
    if (value !== '' && !labels.includes(value)) setLabels((current) => [...current, value]);
    setLabelDraft('');
  }

  function insertLine(at: number) {
    setLines((current) => [...current.slice(0, at), '', ...current.slice(at)]);
    setFocusLine(at);
  }

  function removeLine(at: number) {
    setLines((current) => current.filter((_, index) => index !== at));
    setFocusLine(Math.max(0, at - 1));
  }

  async function file() {
    if (inFlight.current || loading) return;
    const next: Record<string, string> = {};
    const cleanTitle = title.trim();
    const cleanParent = parent.trim();
    if (!chosen) next.project = 'No project chosen.';
    if (!cleanTitle) next.title = 'No title.';
    // A parent from another project cannot hold this task.
    if (cleanParent && chosen && !cleanParent.startsWith(`${chosen.prefix}-`))
      next.parent = `A parent in ${chosen.displayName} starts with ${chosen.prefix}-.`;
    setErrors(next);
    if (next.parent) setMore(true);
    if (Object.keys(next).length > 0 || !chosen) return;

    const acceptance = acceptanceText(lines);
    const input: NewTask = {
      project: chosen.logicalKey,
      title: cleanTitle,
      type,
      priority,
      ...(labels.length > 0 ? { labels } : {}),
      ...(cleanParent ? { parent: cleanParent } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(acceptance ? { acceptance } : {}),
    };
    inFlight.current = true;
    setFiling(true);
    try {
      const created = await createTask.mutateAsync({ input, idempotencyKey: retryKey.keyFor(JSON.stringify(input)) });
      retryKey.done();
      toast.success(`Filed ${created.id}`, {
        description: cleanTitle,
        action: { label: 'Open', onClick: () => void navigate(paths.task(created.id)) },
      });
      onClose();
    } catch (error) {
      setErrors({
        form: error instanceof Error && error.message !== '' ? error.message : 'The task could not be filed.',
      });
    } finally {
      inFlight.current = false;
      setFiling(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" data-task-composer="">
      <button
        type="button"
        aria-label="Close the composer"
        onClick={onClose}
        className="absolute inset-0 bg-ink/20 dark:bg-black/50"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-full w-full max-w-lg flex-col bg-background shadow-pop"
      >
        <header className="flex h-14 items-center justify-between gap-3 border-b border-border ps-5 pe-3">
          <h2 id={titleId} className="m-0 text-heading text-ink">
            File a task
          </h2>
          <IconButton label="Close" shortcut="Esc" icon={<X aria-hidden />} onClick={onClose} />
        </header>

        <div
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5"
          onKeyDown={(event) => {
            // Cmd or Ctrl with Enter files from any field, the multi-line ones included.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void file();
            }
          }}
        >
          <Field label="Title" required error={errors.title}>
            <Input
              value={title}
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                event.preventDefault();
                // The panel files on Cmd or Ctrl with Enter too; this press is handled here alone.
                event.stopPropagation();
                void file();
              }}
              data-composer-title=""
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <Field label="Project" required error={errors.project}>
              <Select value={project} onChange={(event) => setProject(event.target.value)} data-composer-project="">
                <option value="" disabled hidden />
                {projects.map((entry) => (
                  <option key={entry.logicalKey} value={entry.logicalKey}>
                    {entry.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priority">
              <Select
                value={String(priority)}
                onChange={(event) => setPriority(Number(event.target.value))}
                data-composer-priority=""
              >
                {PRIORITY_LABELS.map((word, index) => (
                  <option key={word} value={String(index)}>
                    {word}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {labels.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5" data-composer-labels="">
              {labels.map((label) => (
                <Badge key={label} dot className="pe-0.5">
                  {label}
                  <button
                    type="button"
                    aria-label={`Remove label ${label}`}
                    onClick={() => setLabels((current) => current.filter((entry) => entry !== label))}
                    className="grid size-4 place-items-center rounded-full text-ink-3 outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <X aria-hidden size={12} />
                  </button>
                </Badge>
              ))}
            </div>
          ) : null}

          <Button
            type="button"
            variant="ghost"
            className="-ms-2.5 w-fit"
            aria-expanded={more}
            onClick={() => setMore((current) => !current)}
            data-composer-more=""
          >
            <ChevronDown className={cn('motion-safe:transition-transform', more && 'rotate-180')} aria-hidden />
            More
          </Button>

          {more ? (
            <div className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Type">
                  <Select value={type} onChange={(event) => setType(event.target.value)} data-composer-type="">
                    {TASK_TYPES.map((value) => (
                      <option key={value} value={value}>
                        {typeLabel(value)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Parent epic" error={errors.parent}>
                  <Input
                    className="nums"
                    value={parent}
                    onChange={(event) => setParent(event.target.value)}
                    spellCheck={false}
                    data-composer-parent=""
                  />
                </Field>
              </div>

              <Field label="Labels">
                <Input
                  value={labelDraft}
                  onChange={(event) => setLabelDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    addLabel();
                  }}
                  end={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="-me-1"
                      onClick={addLabel}
                      disabled={labelDraft.trim() === ''}
                    >
                      <Plus aria-hidden /> Add
                    </Button>
                  }
                />
              </Field>

              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor={`${fieldId}-description`} className="text-label font-medium text-ink-2">
                    Description
                  </label>
                  <Tabs
                    label="Description view"
                    items={[
                      { value: 'write', label: 'Write' },
                      { value: 'preview', label: 'Preview' },
                    ]}
                    value={previewing ? 'preview' : 'write'}
                    onChange={(view) => setPreviewing(view === 'preview')}
                  />
                </div>
                {previewing ? (
                  <div className="min-h-24 overflow-x-auto rounded-md bg-surface px-3 py-2 inset-ring inset-ring-border">
                    {description.trim() ? (
                      <DescriptionPreview
                        source={description}
                        prefixes={new Set(projects.map((entry) => entry.prefix))}
                      />
                    ) : (
                      <span className="text-sm text-ink-3">Nothing to preview</span>
                    )}
                  </div>
                ) : (
                  <Textarea
                    id={`${fieldId}-description`}
                    rows={5}
                    className="resize-y"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    data-composer-description=""
                  />
                )}
              </div>

              {/* One label for several fields, so the lines stand outside a Field, which owns one control's id. */}
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor={`${fieldId}-acceptance-0`} className="text-label font-medium text-ink-2">
                  Done when
                </label>
                <div className="flex flex-col gap-1.5" data-composer-acceptance="">
                  {lines.map((line, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="size-[15px] shrink-0 rounded-sm inset-ring-[1.5px] inset-ring-border-strong"
                      />
                      <Input
                        id={`${fieldId}-acceptance-${index}`}
                        ref={(node) => {
                          lineRefs.current[index] = node;
                        }}
                        value={line}
                        aria-label={index === 0 ? undefined : `Done when, line ${index + 1}`}
                        onChange={(event) => {
                          const value = event.target.value;
                          setLines((current) => current.map((entry, at) => (at === index ? value : entry)));
                        }}
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey) return;
                          // Enter starts the next line; Backspace on an empty one removes it.
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            insertLine(index + 1);
                          } else if (event.key === 'Backspace' && line === '' && lines.length > 1) {
                            event.preventDefault();
                            removeLine(index);
                          }
                        }}
                        data-composer-acceptance-line={index}
                      />
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="-ms-2 w-fit"
                    onClick={() => insertLine(lines.length)}
                  >
                    <Plus aria-hidden /> Add line
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <footer className="flex flex-col gap-2 border-t border-border px-5 py-3">
          {errors.form ? (
            <p className="m-0 flex items-center gap-1.5 text-meta text-ink" role="alert" data-composer-error="">
              <CircleAlert aria-hidden size={14} className="shrink-0 text-ink-2" />
              {errors.form}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="button"
              onClick={() => void file()}
              disabled={filing || loading}
              data-composer-submit=""
            >
              {filing ? 'Filing…' : 'File task'}
            </Button>
          </div>
        </footer>
      </aside>
    </div>,
    container,
  );
}
