import { useEffect, useId, useRef, useState } from 'react';
import { Check, SendHorizontal, Star } from 'lucide-react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { TASK_CHOICE_KEYS, type TaskChoiceKey } from '@/api/types';
import { PageSkeleton, ReadFailed } from '@/components/surface';
import { Button } from '@/components/ui/button';
import { eyebrowClass, fieldClass, inlineLinkClass, pillControlClass } from '@/components/ui/chrome';
import { useBoard } from '@/hooks/useBoard';
import { useNow } from '@/hooks/useNow';
import { operationAvailable, useAnswerHides, useCapabilities, useInboxAnswer, verbReason } from '@/hooks/useTasks';
import { NO_FILTERS } from '@/lib/board-read';
import { ageMs, formatInt } from '@/lib/format';
import { askVerb, choiceOrder, isGate, type BoardTask, type InboxAsk } from '@/lib/task-model';
import { taskPath } from '@/lib/task-path';
import { cn } from '@/lib/utils';
import { ageLabel } from './tasks/ask-queue';
import { askGlyph } from './tasks/task-face';

const TASKS_HOME = '/tasks';
const NOTE_MAX = 2000;
const DAY = 86_400_000;
const UNAVAILABLE = 'This sign-in cannot answer it.';

const ASK_LINE: Readonly<Record<InboxAsk, string>> = {
  approve: 'Needs your approval',
  answer: 'Needs your answer',
  choose: 'Needs your choice',
};

function returnPath(state: unknown): string {
  const path = typeof state === 'object' && state !== null ? (state as { returnTo?: unknown }).returnTo : undefined;
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? path : TASKS_HOME;
}

/** A key pressed in a field or an open menu is not a Focus command. */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], [role="listbox"]') !== null;
}

/**
 * `/tasks/focus`: your decisions one at a time, in the decisions list's order.
 * A pick, an approval or an answer goes through the same answer as the
 * board's, with the same Undo; Not now passes over a decision without
 * answering it. `?project=` narrows to one project and `?task=` starts at one
 * decision.
 */
export function FocusRoute() {
  const now = useNow();
  const [params] = useSearchParams();
  const location = useLocation();
  const leave = returnPath(location.state);
  const project = params.get('project');
  const start = params.get('task');
  const board = useBoard({ ...NO_FILTERS, project: project ?? 'all' }, now);
  const hides = useAnswerHides();
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set());

  const readAt = (task: BoardTask) => board.projects.find((row) => row.key === task.project)?.readAt ?? null;
  const queue = board.inbox.filter((task) => !hides(task.id, readAt(task)));
  const at = start === null ? -1 : queue.findIndex((task) => task.id === start);
  const ordered = at <= 0 ? queue : [...queue.slice(at), ...queue.slice(0, at)];
  const pending = ordered.filter((task) => !skipped.has(task.id));
  const current = pending[0] ?? null;
  const after = pending[1] ?? null;
  const shownIds = new Set(queue.map((task) => task.id));
  // Answered here and gone from the list while its Undo runs: still one of this sitting's decisions.
  const gone = [...handled].filter((id) => !shownIds.has(id)).length;
  const total = queue.length + gone;
  const position = Math.min(total, ordered.length - pending.length + gone + 1);
  const names = new Map(board.available.map((row) => [row.key, row.name]));

  let body;
  if (board.catalog.isError) {
    body = <ReadFailed title="Couldn't load your projects" error={board.catalog.error} retrying={board.fetching} onRetry={() => void board.refetch()} />;
  } else if (board.loading) {
    body = <PageSkeleton shape="page" />;
  } else if (current === null) {
    body = (
      <div className="flex flex-col items-start gap-3 py-10" data-focus-done="">
        <p className="m-0 text-figure-sm text-foreground">{board.complete ? "That's every decision for you." : 'No decisions in the projects that could be read.'}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild><Link to={leave}>Back to Tasks</Link></Button>
          {skipped.size > 0 ? <Button type="button" variant="ghost" onClick={() => setSkipped(new Set())} data-focus-again="">Start over</Button> : null}
        </div>
      </div>
    );
  } else {
    body = (
      <FocusDecision
        key={current.id}
        task={current}
        projectName={names.get(current.project) ?? current.project}
        after={after}
        afterProject={after ? names.get(after.project) ?? after.project : null}
        writable={board.projects.some((row) => row.key === current.project && row.ok)}
        nowMs={now}
        onSkip={() => setSkipped((ids) => new Set([...ids, current.id]))}
        onSent={() => setHandled((ids) => new Set([...ids, current.id]))}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 md:p-6" data-tasks-focus="">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className={eyebrowClass} data-focus-position={`${position}/${total}`}>
          {total > 0 ? `Focus · ${formatInt(position)} of ${formatInt(total)} for you` : 'Focus'}
        </span>
        {/* Past two dozen the dots are no longer countable; the words carry the place. */}
        {total > 0 && total <= 24 ? (
          <span aria-hidden className="flex flex-wrap gap-1">
            {Array.from({ length: total }, (_, index) => (
              <span key={index} className={cn('size-1.5 rounded-full', current === null || index < position ? 'bg-foreground/80' : 'bg-border')} />
            ))}
          </span>
        ) : null}
        <Link to={leave} className={cn('ms-auto text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline', pillControlClass)}>Leave focus</Link>
      </div>
      {body}
    </div>
  );
}

/** One decision, with every way of answering it as a large press and the keys that do the same. */
function FocusDecision({ task, projectName, after, afterProject, writable, nowMs, onSkip, onSent }: {
  task: BoardTask;
  projectName: string;
  after: BoardTask | null;
  afterProject: string | null;
  writable: boolean;
  nowMs: number;
  onSkip: () => void;
  onSent: () => void;
}) {
  const capabilities = useCapabilities();
  const answer = useInboxAnswer();
  const noteId = useId();
  const reasonId = useId();
  const [note, setNote] = useState('');
  const [text, setText] = useState('');
  const ask = askVerb(task);
  const choices = ask === 'choose' ? task.choices ?? null : null;
  const options = choices ? choiceOrder(choices) : [];
  const allowed = writable && operationAvailable(capabilities, choices ? 'choose' : isGate(task) ? 'resolve' : 'respond');
  const reason = verbReason(capabilities, allowed, UNAVAILABLE);
  const waited = ageMs(nowMs, task.createdAt ?? task.updatedAt);
  const scope = { id: task.id, title: task.title, project: task.project };

  function choose(key: TaskChoiceKey) {
    if (choices === null || reason !== null) return;
    const option = choices.options.find((entry) => entry.key === key);
    if (!option) return;
    const said = note.trim();
    answer({ kind: 'choose', ...scope, option: key, label: option.label, ...(said === '' ? {} : { note: said }) });
    onSent();
  }
  function approve() {
    if (reason !== null) return;
    answer({ kind: 'approve', ...scope });
    onSent();
  }
  function send() {
    const words = text.trim();
    if (words === '' || reason !== null) return;
    answer({ kind: 'answer', ...scope, text: words });
    onSent();
  }

  // The latest handlers, for the one listener the page keeps.
  const keys = useRef({ choose, approve, onSkip, ask, keys: options.map((option) => option.key) });
  keys.current = { choose, approve, onSkip, ask, keys: options.map((option) => option.key) };
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || typing(event.target)) return;
      const live = keys.current;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        live.onSkip();
        return;
      }
      if (event.key === 'Enter' && live.ask === 'approve' && !(event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement)) {
        event.preventDefault();
        live.approve();
        return;
      }
      const key = TASK_CHOICE_KEYS.find((candidate) => candidate === event.key.toLowerCase());
      if (key !== undefined && live.keys.includes(key)) {
        event.preventDefault();
        live.choose(key);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hint = choices
    ? `${options.map((option) => option.key.toUpperCase()).join(' ')} choose · → skip`
    : ask === 'approve' ? 'Enter approve · → skip' : '→ skip';

  return (
    <section className="flex flex-col gap-5" data-focus-decision={task.id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <span className="font-medium text-foreground">{projectName}</span>
        <span className="inline-flex items-center gap-1.5 font-medium text-warn">
          <span aria-hidden className="font-bold">{askGlyph(task)}</span>
          {ASK_LINE[ask]}
          {waited !== null ? ` · waiting ${ageLabel(waited / DAY)}` : ''}
        </span>
      </div>

      <h1 className="m-0 text-[28px] font-bold leading-[1.1] tracking-[-0.03em] text-foreground md:text-display">
        <Link to={taskPath(task.id)} className="underline-offset-4 hover:underline">{task.title}</Link>
      </h1>
      {task.description.trim() ? <p className="m-0 whitespace-pre-line text-base text-muted-foreground">{task.description.trim()}</p> : null}

      {choices ? (
        <div role="group" aria-labelledby={`${noteId}-question`} className="flex flex-col gap-3" data-focus-options="">
          <p id={`${noteId}-question`} className="m-0 text-base font-medium text-foreground [overflow-wrap:anywhere]">{choices.question}</p>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3 p-0">
            {options.map((option) => (
              <li key={option.key} className="min-w-0">
                <button
                  type="button"
                  disabled={reason !== null}
                  aria-describedby={reason ? reasonId : undefined}
                  onClick={() => choose(option.key)}
                  className={cn(
                    'flex h-full min-h-16 w-full items-start gap-3 rounded-xl border bg-card px-4 py-3 text-start hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60',
                    pillControlClass,
                    option.recommended ? 'border-foreground/40' : 'border-border',
                  )}
                  data-focus-option={option.key}
                >
                  <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full border-[1.5px] border-current text-sm font-semibold text-foreground">
                    {option.key.toUpperCase()}
                  </span>
                  <span className="grid min-w-0 gap-1">
                    <span className="text-base font-medium text-foreground [overflow-wrap:anywhere]">{option.label}</span>
                    {option.recommended ? (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Star aria-hidden className="size-3 fill-current" />
                        Recommended
                      </span>
                    ) : null}
                    {option.detail ? <span className="whitespace-pre-line text-sm text-muted-foreground [overflow-wrap:anywhere]">{option.detail}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <span className="flex items-center gap-2">
            <label htmlFor={noteId} className="shrink-0 text-xs font-medium text-muted-foreground">Note</label>
            <input id={noteId} type="text" className={cn(fieldClass, 'h-9 min-w-0 flex-1')} maxLength={NOTE_MAX} value={note} onChange={(event) => setNote(event.target.value)} data-focus-note="" />
          </span>
        </div>
      ) : ask === 'approve' ? (
        <div>
          <Button type="button" className="min-h-11 px-6 text-base" disabled={reason !== null} aria-describedby={reason ? reasonId : undefined} onClick={approve} data-focus-approve="">
            <Check aria-hidden />
            Approve
          </Button>
        </div>
      ) : (
        <form className="flex items-start gap-2 max-sm:flex-wrap" data-focus-answer="" onSubmit={(event) => { event.preventDefault(); send(); }}>
          <textarea
            rows={2}
            className={cn(fieldClass, 'min-h-16 w-full flex-1 resize-y max-sm:basis-full')}
            aria-label={`Your answer to ${task.id}`}
            placeholder="Your answer"
            value={text}
            disabled={reason !== null}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              send();
            }}
          />
          <Button type="submit" disabled={text.trim() === '' || reason !== null}>
            <SendHorizontal aria-hidden />
            Send
          </Button>
        </form>
      )}
      {reason ? <p id={reasonId} className="m-0 text-xs text-muted-foreground">{reason}</p> : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/60 pt-3">
        <Button type="button" variant="ghost" onClick={onSkip} data-focus-skip="">Not now</Button>
        {after ? (
          <span className="min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere]" data-focus-after="">
            After this: <Link to={taskPath(after.id)} className={inlineLinkClass}>{after.title}</Link>{afterProject ? ` · ${afterProject}` : ''}
          </span>
        ) : null}
        <span className="ms-auto text-xs text-muted-foreground max-sm:hidden" data-focus-keys="">{hint}</span>
      </div>
    </section>
  );
}

export default FocusRoute;
