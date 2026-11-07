import { useEffect, useRef, useState } from 'react';
import { Check, Inbox, SendHorizontal } from 'lucide-react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import type { TaskChoiceKey } from '@/api/types';
import { PageSkeleton, ReadFailed } from '@/components/surface';
import { Button } from '@/components/ui/button';
import { choiceForKey } from '@/components/ui/choice';
import { EmptyState } from '@/components/ui/empty-state';
import { Textarea } from '@/components/ui/field';
import { Kbd } from '@/components/ui/kbd';
import { BarSpacer, TopBar } from '@/components/ui/shell';
import { StatusMark } from '@/components/ui/symbols';
import { useBoard } from '@/hooks/useBoard';
import { useNow } from '@/hooks/useNow';
import { operationAvailable, useAnswerHides, useCapabilities, useInboxAnswer, verbReason } from '@/hooks/useTasks';
import { NO_FILTERS } from '@/lib/board-read';
import { ageMs, formatAge, formatInt } from '@/lib/format';
import { askVerb, isGate, type BoardTask, type InboxAsk } from '@/lib/task-model';
import { taskPath } from '@/lib/task-path';
import { cn } from '@/lib/utils';
import { cardOptions, DecisionAnswer } from './tasks/decision-card';
import { MarkdownText } from './tasks/task-markdown';

const TASKS_HOME = '/tasks';
const UNAVAILABLE = 'This sign-in cannot answer it.';

/** What a card asks of you, in the words its head shows. */
const ASK_WORDS: Readonly<Record<InboxAsk, string>> = {
  approve: 'Your approval',
  answer: 'Your answer',
  choose: 'Your choice',
};

function returnPath(state: unknown): string {
  const path = typeof state === 'object' && state !== null ? (state as { returnTo?: unknown }).returnTo : undefined;
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? path : TASKS_HOME;
}

/** A key pressed in a field or an open menu is not a Focus command. */
function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], [role="listbox"]',
    ) !== null
  );
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
  const board = useBoard({ ...NO_FILTERS, project: project ?? 'all' });
  const hides = useAnswerHides();
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set());

  const fetchedAt = (task: BoardTask) => board.projects.find((row) => row.key === task.project)?.fetchedAt ?? null;
  const queue = board.inbox.filter((task) => !hides(task.id, fetchedAt(task)));
  const at = start === null ? -1 : queue.findIndex((task) => task.id === start);
  const ordered = at <= 0 ? queue : [...queue.slice(at), ...queue.slice(0, at)];
  const pending = ordered.filter((task) => !skipped.has(task.id));
  // Passed with Not now and still waiting: the sitting is not over, only paused.
  const passed = ordered.length - pending.length;
  const current = pending[0] ?? null;
  const after = pending[1] ?? null;
  const shownIds = new Set(queue.map((task) => task.id));
  // Answered here and gone from the list while its Undo runs: still one of this sitting's decisions.
  const gone = [...handled].filter((id) => !shownIds.has(id)).length;
  const total = queue.length + gone;
  const position = Math.min(total, ordered.length - pending.length + gone + 1);
  const names = new Map(board.available.map((row) => [row.key, row.name]));

  let body;
  if (board.readFailure !== null) {
    body = (
      <ReadFailed
        title="Couldn't load your projects"
        error={board.readFailure}
        retrying={board.fetching}
        onRetry={() => void board.refetch()}
      />
    );
  } else if (board.loading) {
    body = <PageSkeleton shape="page" />;
  } else if (current === null) {
    body = (
      <div data-focus-done="">
        <EmptyState
          icon={<Inbox />}
          title={
            passed > 0
              ? `${formatInt(passed)} ${passed === 1 ? 'decision' : 'decisions'} skipped`
              : board.complete
                ? 'Nothing is waiting for you'
                : 'Nothing waiting in the projects that could be read'
          }
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              {passed > 0 ? (
                <Button type="button" onClick={() => setSkipped(new Set())} data-focus-again="">
                  Start over
                </Button>
              ) : null}
              <Button variant="primary" asChild>
                <Link to={leave}>Back to Tasks</Link>
              </Button>
            </div>
          }
        />
      </div>
    );
  } else {
    body = (
      <FocusDecision
        key={current.id}
        task={current}
        projectName={names.get(current.project) ?? current.project}
        after={after}
        writable={board.projects.some((row) => row.key === current.project && row.ok)}
        nowMs={now}
        onSkip={() => setSkipped((ids) => new Set([...ids, current.id]))}
        onSent={() => setHandled((ids) => new Set([...ids, current.id]))}
      />
    );
  }

  return (
    <>
      <TopBar title="Focus">
        {total > 0 ? (
          <span className="nums text-label font-medium text-ink-3" data-focus-position={`${position}/${total}`}>
            {formatInt(position)} of {formatInt(total)}
          </span>
        ) : null}
        <BarSpacer />
        <Button variant="ghost" asChild>
          <Link to={leave}>Leave focus</Link>
        </Button>
      </TopBar>
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-4 py-10 max-sm:py-5" data-tasks-focus="">
        {body}
      </div>
    </>
  );
}

/**
 * One decision on a card: whose turn it is and how long it has waited, the
 * title, the text, then its answer: options with their keys, an Approve, or
 * a box for words, beside Not now. Letters pick an option, Enter answers or
 * approves, and → passes it over.
 */
function FocusDecision({
  task,
  projectName,
  after,
  writable,
  nowMs,
  onSkip,
  onSent,
}: {
  task: BoardTask;
  projectName: string;
  after: BoardTask | null;
  writable: boolean;
  nowMs: number;
  onSkip: () => void;
  onSent: () => void;
}) {
  const capabilities = useCapabilities();
  const answer = useInboxAnswer();
  const [option, setOption] = useState<TaskChoiceKey | null>(null);
  const [note, setNote] = useState('');
  const [text, setText] = useState('');
  const ask = askVerb(task);
  const choices = ask === 'choose' ? (task.choices ?? null) : null;
  const allowed =
    writable && operationAvailable(capabilities, choices ? 'choose' : isGate(task) ? 'resolve' : 'respond');
  const reason = verbReason(capabilities, allowed, UNAVAILABLE);
  const waited = ageMs(nowMs, task.createdAt ?? task.updatedAt);
  const scope = { id: task.id, title: task.title, project: task.project };

  function choose(key: TaskChoiceKey) {
    if (choices === null || reason !== null) return;
    const picked = choices.options.find((entry) => entry.key === key);
    if (!picked) return;
    const said = note.trim();
    answer({ kind: 'choose', ...scope, option: key, label: picked.label, ...(said === '' ? {} : { note: said }) });
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
  const keys = useRef({ choose, approve, onSkip, ask, option, options: choices ? cardOptions(choices) : [] });
  keys.current = { choose, approve, onSkip, ask, option, options: choices ? cardOptions(choices) : [] };
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || typing(event.target)) return;
      const live = keys.current;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        live.onSkip();
        return;
      }
      // Enter on a button or a link presses it; anywhere else it answers.
      if (
        event.key === 'Enter' &&
        !(event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement)
      ) {
        if (live.ask === 'approve') {
          event.preventDefault();
          live.approve();
        } else if (live.ask === 'choose' && live.option !== null) {
          event.preventDefault();
          live.choose(live.option);
        }
        return;
      }
      const key = choiceForKey(event.key, live.options);
      if (key !== null) {
        event.preventDefault();
        setOption(key);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const notNow = (
    <Button type="button" variant="ghost" onClick={onSkip} aria-keyshortcuts="ArrowRight" data-focus-skip="">
      Not now <Kbd>→</Kbd>
    </Button>
  );

  return (
    <>
      <section
        className="flex flex-col rounded-xl bg-background px-5.5 pt-5.5 pb-4.5 shadow-pop max-sm:px-4"
        data-focus-decision={task.id}
      >
        <div className="nums flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ink-3">
          <StatusMark status="waiting" label={null} />
          <b className="font-semibold text-wait-text">{ASK_WORDS[ask]}</b>
          <span>{task.id}</span>
          <span>{projectName}</span>
          {waited !== null ? <span className="ms-auto">{formatAge(waited)}</span> : null}
        </div>
        <h1 className="m-0 mt-2.5 text-heading text-ink [overflow-wrap:anywhere]">
          <Link to={taskPath(task.id)} className="text-ink no-underline underline-offset-3 hover:underline">
            {task.title}
          </Link>
        </h1>
        {task.description.trim() ? (
          <MarkdownText source={task.description} className="mt-1.5 text-sm text-ink-2" />
        ) : null}
        <div className="mt-4">
          {choices ? (
            <div className="flex flex-col gap-3" data-focus-options="">
              <p className="m-0 text-sm font-medium text-ink [overflow-wrap:anywhere]">{choices.question}</p>
              <DecisionAnswer
                choices={choices}
                value={option}
                onChange={setOption}
                note={note}
                onNote={setNote}
                onAnswer={choose}
                disabledReason={reason}
                footer={notNow}
              />
            </div>
          ) : ask === 'approve' ? (
            <div className="flex items-center justify-end gap-2">
              {notNow}
              <Button
                variant="primary"
                type="button"
                disabled={reason !== null}
                title={reason ?? undefined}
                aria-keyshortcuts="Enter"
                onClick={approve}
                data-focus-approve=""
              >
                <Check aria-hidden strokeWidth={2} />
                Approve <Kbd>↵</Kbd>
              </Button>
            </div>
          ) : (
            <form
              className="flex flex-col gap-3"
              data-focus-answer=""
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              <Textarea
                rows={3}
                aria-label={`Your answer to ${task.id}`}
                value={text}
                disabled={reason !== null}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  send();
                }}
              />
              <div className="flex items-center justify-end gap-2">
                {notNow}
                <Button
                  variant="primary"
                  type="submit"
                  disabled={text.trim() === '' || reason !== null}
                  title={reason ?? undefined}
                >
                  <SendHorizontal aria-hidden />
                  Send <Kbd>↵</Kbd>
                </Button>
              </div>
            </form>
          )}
        </div>
      </section>
      {after ? (
        <p className={cn('m-0 flex min-w-0 items-center gap-2 px-1 text-label text-ink-3')} data-focus-after="">
          <span className="shrink-0 font-medium">Next</span>
          <Link to={taskPath(after.id)} className="min-w-0 truncate text-ink-2 no-underline hover:text-ink">
            {after.title}
          </Link>
        </p>
      ) : null}
    </>
  );
}

export default FocusRoute;
