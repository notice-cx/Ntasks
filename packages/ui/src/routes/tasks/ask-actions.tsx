import { lazy, Suspense, useId, useState, type ReactNode } from 'react';
import { Check, CheckCheck, CornerDownLeft, GitPullRequest, ListChecks, SendHorizontal } from 'lucide-react';
import type { TaskChoiceKey, TaskChoices, TaskStep } from '../../api/types';
import { Button } from '../../components/ui/button';
import { Segmented } from '../../components/ui/choice';
import { Field, Input, Textarea } from '../../components/ui/field';
import { useInboxAnswer } from '../../hooks/useTasks';
import { pullRequestName } from '../../lib/format';
import { PERFORMED_LABEL, stepsDone, type InboxAsk } from '../../lib/task-model';
import { cn } from '../../lib/utils';

// The steps draw Markdown, whose renderer the board loads only when a row opens them.
const StepList = lazy(() => import('./step-list').then((module) => ({ default: module.StepList })));

/**
 * What a row in Waiting for you offers: Approve on an approval, beside Did it
 * myself, which opens a note under the row, after the pull request whose
 * auto-merge Approve turns on when the approval gates one; the options side by
 * side on a decision (one press answers), Answer on a question, which opens a
 * box under the row, and Your steps on a request to do steps, which opens its
 * steps under the row. Every answer waits in the Undo window.
 * `buttons` sit beside the title and `box` under it; both are null when
 * nothing is asked. Closing as something else is in the row's menu.
 */
export function useAskActions({
  ask,
  id,
  title,
  project,
  proposalVersion = null,
  choices = null,
  steps = null,
  pullRequest = null,
  nowMs = Date.now(),
  disabledReason = null,
  chooseDisabledReason = disabledReason,
  performedDisabledReason = disabledReason,
}: {
  ask: InboxAsk | null;
  id: string;
  title: string;
  project: string;
  /** The proposal version the row shows, which every answer sends. */
  proposalVersion?: string | null;
  choices?: TaskChoices | null;
  /** A request's steps, which Steps opens. */
  steps?: readonly TaskStep[] | null;
  /** The pull request an approval gates. */
  pullRequest?: string | null;
  nowMs?: number;
  /** Why the verbs cannot run here, or null. */
  disabledReason?: string | null;
  chooseDisabledReason?: string | null;
  performedDisabledReason?: string | null;
}): { buttons: ReactNode; box: ReactNode } {
  const [answering, setAnswering] = useState(false);
  const [performing, setPerforming] = useState(false);
  const [text, setText] = useState('');
  const answer = useInboxAnswer();
  const reasonId = useId();
  const mergeId = useId();
  const disabled = disabledReason !== null;

  if (ask === null) return { buttons: null, box: null };

  const choosing = ask === 'choose' && choices !== null;

  function send() {
    const words = text.trim();
    if (words === '') return;
    answer({ kind: 'answer', id, title, project, proposalVersion, text: words });
    setText('');
    setAnswering(false);
  }

  function choose(option: TaskChoiceKey) {
    const label = choices?.options.find((entry) => entry.key === option)?.label;
    answer({ kind: 'choose', id, title, project, proposalVersion, option, ...(label === undefined ? {} : { label }) });
  }

  // A row has no room to write why its controls are disabled, so each one
  // carries the reason as its description, and a pointer shows it as a tip.
  const reason = choosing ? chooseDisabledReason : disabledReason;
  const described = reason ? reasonId : undefined;
  const doing = ask === 'do' && steps !== null;
  const control = doing ? (
    <Button
      type="button"
      size="sm"
      aria-expanded={answering}
      onClick={() => setAnswering((open) => !open)}
      data-task-action="steps"
    >
      <ListChecks aria-hidden />
      Your steps
      <span className="nums text-ink-3">
        {stepsDone(steps)}/{steps.length}
      </span>
    </Button>
  ) : ask === 'approve' ? (
    <>
      {pullRequest ? <AutoMergeNote pullRequest={pullRequest} id={mergeId} compact /> : null}
      <PerformedButton
        size="sm"
        open={performing}
        onToggle={() => setPerforming((open) => !open)}
        disabledReason={performedDisabledReason}
        describedBy={performedDisabledReason ? reasonId : undefined}
      />
      <Button
        variant="primary"
        type="button"
        size="sm"
        disabled={disabled}
        title={disabledReason || undefined}
        aria-describedby={describedBy(described, pullRequest ? mergeId : undefined)}
        onClick={() => answer({ kind: 'approve', id, title, project, proposalVersion })}
        data-task-action="approve"
      >
        <Check aria-hidden strokeWidth={2} />
        Approve
      </Button>
    </>
  ) : choosing ? (
    <Segmented
      question={choices.question}
      options={choices.options.map((option) => ({
        key: option.key,
        label: option.label,
        recommended: option.recommended === true,
      }))}
      disabled={chooseDisabledReason !== null}
      describedBy={described}
      onChoose={choose}
    />
  ) : (
    <Button
      type="button"
      size="sm"
      aria-expanded={answering}
      disabled={disabled}
      title={disabledReason || undefined}
      aria-describedby={described}
      onClick={() => setAnswering((open) => !open)}
      data-task-action="answer"
    >
      <CornerDownLeft aria-hidden />
      Answer
    </Button>
  );
  const box = performing ? (
    <PerformedForm
      id={id}
      size="sm"
      onSend={(note) => {
        answer({ kind: 'performed', id, title, project, proposalVersion, ...(note === undefined ? {} : { note }) });
        setPerforming(false);
      }}
      onCancel={() => setPerforming(false)}
    />
  ) : !answering ? null : doing ? (
    <Suspense fallback={<span className="text-meta text-ink-3">Loading…</span>}>
      <StepList
        id={id}
        project={project}
        steps={steps}
        proposalVersion={proposalVersion}
        open
        disabledReason={disabledReason}
        nowMs={nowMs}
      />
    </Suspense>
  ) : (
    <AnswerForm id={id} text={text} onText={setText} onSend={send} onCancel={() => setAnswering(false)} size="sm" />
  );
  const shownReason = reason ?? (ask === 'approve' ? performedDisabledReason : null);
  const buttons = (
    <>
      {control}
      {shownReason ? (
        <span id={reasonId} className="sr-only">
          {shownReason}
        </span>
      ) : null}
    </>
  );
  return { buttons, box };
}

/** An `aria-describedby` naming each element given, or undefined when none is. */
function describedBy(...ids: readonly (string | undefined)[]): string | undefined {
  const named = ids.filter((id) => id !== undefined && id !== '');
  return named.length === 0 ? undefined : named.join(' ');
}

/**
 * What Approve does to the pull request an approval gates: it turns on the
 * pull request's auto-merge. The pull request is a link that opens it on
 * GitHub. `compact` is a row's form, which leaves out the sentence; `id` lets
 * Approve take the note as its description.
 */
export function AutoMergeNote({
  pullRequest,
  id,
  compact = false,
  className,
}: {
  pullRequest: string;
  id?: string;
  compact?: boolean;
  className?: string;
}) {
  const link = (
    <a
      href={pullRequest}
      target="_blank"
      rel="noreferrer"
      className="nums text-accent-text no-underline hover:underline"
      data-approve-pull-request=""
    >
      {pullRequestName(pullRequest)}
    </a>
  );
  if (compact) {
    return (
      <span
        id={id}
        className={cn(
          // On a phone it takes a line of its own, so Did it myself and Approve stay side by side under it.
          'me-1 inline-flex shrink-0 items-center gap-1.25 whitespace-nowrap text-meta text-ink-3 max-sm:basis-full [&_svg]:size-3.5',
          className,
        )}
      >
        <GitPullRequest aria-hidden />
        Auto-merge {link}
      </span>
    );
  }
  return (
    <p id={id} className={cn('m-0 text-label text-ink-3 [overflow-wrap:anywhere]', className)}>
      Approve turns on auto-merge for {link}.
    </p>
  );
}

/** Did it myself: the button that opens the note a person's report that they did an approval's action takes. */
export function PerformedButton({
  open,
  onToggle,
  disabledReason = null,
  describedBy,
  size = 'md',
  iconOnPhone = false,
}: {
  open: boolean;
  onToggle: () => void;
  /** Why this sign-in cannot send it, or null. */
  disabledReason?: string | null;
  describedBy?: string | undefined;
  size?: 'sm' | 'md';
  /** On a phone the button shows its icon alone, its words kept for a screen reader, so a top bar fits the screen. */
  iconOnPhone?: boolean;
}) {
  return (
    <Button
      type="button"
      size={size}
      aria-expanded={open}
      disabled={disabledReason !== null}
      title={disabledReason || undefined}
      aria-describedby={describedBy}
      onClick={onToggle}
      data-task-action="performed"
    >
      <CheckCheck aria-hidden />
      {iconOnPhone ? <span className="max-sm:sr-only">{PERFORMED_LABEL}</span> : PERFORMED_LABEL}
    </Button>
  );
}

/**
 * The line a person's report that they did an approval's action themselves
 * takes: its name and a Note. Enter sends, Escape steps back; the caller's
 * send carries the Undo.
 */
export function PerformedForm({
  id,
  onSend,
  onCancel,
  size = 'md',
}: {
  id: string;
  onSend: (note: string | undefined) => void;
  onCancel: () => void;
  size?: 'sm' | 'md';
}) {
  const [note, setNote] = useState('');
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      data-task-form="performed"
      aria-label={`${PERFORMED_LABEL}: ${id}`}
      onSubmit={(event) => {
        event.preventDefault();
        const words = note.trim();
        onSend(words === '' ? undefined : words);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onCancel();
      }}
    >
      <span className="inline-flex h-7.5 shrink-0 items-center gap-1.5 text-label font-semibold text-ink [&_svg]:size-[15px] [&_svg]:text-ink-3">
        <CheckCheck aria-hidden />
        {PERFORMED_LABEL}
      </span>
      <Field label="Note" className="min-w-0 flex-1 basis-56">
        <Input autoFocus value={note} onChange={(event) => setNote(event.target.value)} />
      </Field>
      <Button variant="primary" type="submit" size={size} data-task-confirm="performed">
        <SendHorizontal aria-hidden />
        Send
      </Button>
      <Button type="button" size={size} variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

/** A box for the words that answer a question: Enter sends, Shift+Enter is a new line, Escape steps back. */
export function AnswerForm({
  id,
  text,
  onText,
  onSend,
  onCancel,
  size = 'md',
}: {
  id: string;
  text: string;
  onText: (text: string) => void;
  onSend: () => void;
  onCancel: () => void;
  size?: 'sm' | 'md';
}) {
  return (
    <form
      className="flex items-start gap-2 max-sm:flex-wrap"
      data-task-form="answer"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <span className="min-w-0 flex-1 max-sm:basis-full">
        <Textarea
          autoFocus
          rows={2}
          aria-label={`Your answer to ${id}`}
          value={text}
          onChange={(event) => onText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
              return;
            }
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            onSend();
          }}
        />
      </span>
      <Button variant="primary" type="submit" size={size} disabled={text.trim() === ''} data-task-confirm="answer">
        <SendHorizontal aria-hidden />
        Send
      </Button>
      <Button type="button" size={size} variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}
