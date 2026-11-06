import { ChevronDown, Plus, Square, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { NewTask, TaskProject } from '@/api/types';
import { Button } from '@/components/ui/button';
import { fieldClass, pillControlClass, pillPickerStateClass } from '@/components/ui/chrome';
import { useCreateTask, useRetryKey } from '@/hooks/useTasks';
import { PRIORITY_BANDS } from '@/lib/task-model';
import { taskPath } from '@/lib/task-path';
import { cn } from '@/lib/utils';
import { MarkdownText } from '@/routes/tasks/task-markdown';

const FIELD = cn(fieldClass, 'w-full py-1.5');

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

  // The only project is picked when the list arrives, unless one is already chosen.
  useEffect(() => {
    if (!open || project !== '' || projects.length !== 1) return;
    setProject(projects[0]?.logicalKey ?? '');
  }, [open, project, projects]);

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
    if (!chosen) next.project = 'Choose the project this task belongs to.';
    if (!cleanTitle) next.title = 'Write a title someone can read without context.';
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
        action: { label: 'Open', onClick: () => void navigate(taskPath(created.id)) },
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
        className="absolute inset-0 bg-background/70 backdrop-blur-sm"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-full w-full max-w-lg flex-col border-l border-border bg-card shadow-xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <h2 id={titleId} className="m-0 text-base font-semibold">
            File a task
          </h2>
          <Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X aria-hidden />
          </Button>
        </header>

        <div
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
          onKeyDown={(event) => {
            // Cmd or Ctrl with Enter files from any field, the multi-line ones included.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void file();
            }
          }}
        >
          <Field id={`${fieldId}-title`} label="Title" required error={errors.title}>
            <input
              id={`${fieldId}-title`}
              className={cn(FIELD, 'text-base')}
              value={title}
              autoFocus
              required
              aria-required="true"
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                event.preventDefault();
                // The panel files on Cmd or Ctrl with Enter too; this press is handled here alone.
                event.stopPropagation();
                void file();
              }}
              placeholder="What should be true when this is done"
              data-composer-title=""
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <Field id={`${fieldId}-project`} label="Project" required error={errors.project}>
              <select
                id={`${fieldId}-project`}
                className={FIELD}
                value={project}
                required
                aria-required="true"
                onChange={(event) => setProject(event.target.value)}
                data-composer-project=""
              >
                <option value="">Choose a project…</option>
                {projects.map((entry) => (
                  <option key={entry.logicalKey} value={entry.logicalKey}>
                    {entry.displayName} ({entry.prefix}-)
                  </option>
                ))}
              </select>
            </Field>
            <Field id={`${fieldId}-priority`} label="Priority">
              <select
                id={`${fieldId}-priority`}
                className={FIELD}
                value={String(priority)}
                onChange={(event) => setPriority(Number(event.target.value))}
                data-composer-priority=""
              >
                {PRIORITY_BANDS.map((band, index) => (
                  <option key={band} value={String(index)}>
                    {band}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {labels.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5" data-composer-labels="">
              {labels.map((label) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-1 rounded-md border border-border py-0.5 pe-1 ps-2 font-mono text-[11px]"
                >
                  {label}
                  <button
                    type="button"
                    aria-label={`Remove label ${label}`}
                    onClick={() => setLabels((current) => current.filter((entry) => entry !== label))}
                    className="rounded-sm px-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-fit px-1.5 text-muted-foreground"
            aria-expanded={more}
            onClick={() => setMore((current) => !current)}
            data-composer-more=""
          >
            <ChevronDown className={cn('motion-safe:transition-transform', more && 'rotate-180')} aria-hidden />
            More
          </Button>

          {more ? (
            <div className="flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id={`${fieldId}-type`} label="Type">
                  <select
                    id={`${fieldId}-type`}
                    className={FIELD}
                    value={type}
                    onChange={(event) => setType(event.target.value)}
                    data-composer-type=""
                  >
                    {TASK_TYPES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field id={`${fieldId}-parent`} label="Parent epic" error={errors.parent}>
                  <input
                    id={`${fieldId}-parent`}
                    className={cn(FIELD, 'font-mono')}
                    value={parent}
                    onChange={(event) => setParent(event.target.value)}
                    placeholder={chosen ? `${chosen.prefix}-…` : 'An epic id'}
                    spellCheck={false}
                    data-composer-parent=""
                  />
                </Field>
              </div>

              <Field id={`${fieldId}-labels`} label="Labels">
                <div className="flex items-center gap-2">
                  <input
                    id={`${fieldId}-labels`}
                    className={FIELD}
                    value={labelDraft}
                    onChange={(event) => setLabelDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      addLabel();
                    }}
                    placeholder="Add a label"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addLabel}
                    disabled={labelDraft.trim() === ''}
                  >
                    <Plus aria-hidden /> Add
                  </Button>
                </div>
              </Field>

              <Field
                id={`${fieldId}-description`}
                label="Description"
                hint="Markdown: lists, checklists, code and links work; task ids become links."
                aside={
                  <div
                    role="group"
                    aria-label="Write or preview"
                    className="inline-flex items-center gap-0.5 rounded-md border border-border p-0.5"
                  >
                    {[false, true].map((preview) => (
                      <button
                        key={String(preview)}
                        type="button"
                        aria-pressed={previewing === preview}
                        onClick={() => setPreviewing(preview)}
                        className={cn(
                          'inline-flex items-center rounded-sm border px-2 py-0.5 text-xs',
                          pillControlClass,
                          pillPickerStateClass(previewing === preview),
                        )}
                      >
                        {preview ? 'Preview' : 'Write'}
                      </button>
                    ))}
                  </div>
                }
              >
                {previewing ? (
                  <div className={cn(FIELD, 'min-h-24 overflow-x-auto')}>
                    {description.trim() ? (
                      <MarkdownText source={description} />
                    ) : (
                      <span className="text-muted-foreground">Nothing to preview</span>
                    )}
                  </div>
                ) : (
                  <textarea
                    id={`${fieldId}-description`}
                    className={cn(FIELD, 'min-h-24 resize-y')}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="What, why with the numbers, where"
                    data-composer-description=""
                  />
                )}
              </Field>

              <Field id={`${fieldId}-acceptance-0`} label="Done when">
                <div className="flex flex-col gap-1.5" data-composer-acceptance="">
                  {lines.map((line, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Square className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <input
                        id={`${fieldId}-acceptance-${index}`}
                        ref={(node) => {
                          lineRefs.current[index] = node;
                        }}
                        className={FIELD}
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
                        placeholder={index === 0 ? 'The proof that it is done' : undefined}
                        data-composer-acceptance-line={index}
                      />
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-fit px-1.5 text-muted-foreground"
                    onClick={() => insertLine(lines.length)}
                  >
                    <Plus aria-hidden /> Another line
                  </Button>
                </div>
              </Field>
            </div>
          ) : null}
        </div>

        <footer className="flex flex-col gap-2 border-t border-border px-4 py-3">
          {errors.form ? (
            <p className="m-0 text-xs text-error" role="alert" data-composer-error="">
              {errors.form}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void file()} disabled={filing || loading} data-composer-submit="">
              {filing ? 'Filing…' : 'File task'}
            </Button>
          </div>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}

/** A label, its control, and the reason a file was refused, on the field that caused it. Required fields carry an asterisk. */
function Field({
  id,
  label,
  required = false,
  error,
  aside,
  hint,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  error?: string | undefined;
  aside?: ReactNode;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-foreground">
          {label}
          {required ? (
            <span aria-hidden className="text-muted-foreground">
              {' '}
              *
            </span>
          ) : null}
        </label>
        {aside}
      </div>
      {children}
      {hint ? <span className="text-micro text-muted-foreground">{hint}</span> : null}
      {error ? (
        <span className="text-[11px] leading-snug text-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
