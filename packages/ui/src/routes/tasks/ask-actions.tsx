import { lazy, Suspense, useId, useState, type ReactNode } from 'react';
import { Check, CornerDownLeft, ListChecks, SendHorizontal } from 'lucide-react';
import type { TaskChoiceKey, TaskChoices, TaskStep } from '../../api/types';
import { Button } from '../../components/ui/button';
import { Segmented } from '../../components/ui/choice';
import { Textarea } from '../../components/ui/field';
import { useInboxAnswer } from '../../hooks/useTasks';
import { stepsDone, type InboxAsk } from '../../lib/task-model';

// The steps draw Markdown, whose renderer the board loads only when a row opens them.
const StepList = lazy(() => import('./step-list').then((module) => ({ default: module.StepList })));

/**
 * What a row in Waiting for you offers: Approve on an approval, the options
 * side by side on a decision (one press answers), Answer on a question,
 * which opens a box under the row, and Your steps on a request to do steps,
 * which opens its steps under the row. Every answer waits in the Undo window.
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
  nowMs = Date.now(),
  disabledReason = null,
  chooseDisabledReason = disabledReason,
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
  nowMs?: number;
  /** Why the verbs cannot run here, or null. */
  disabledReason?: string | null;
  chooseDisabledReason?: string | null;
}): { buttons: ReactNode; box: ReactNode } {
  const [answering, setAnswering] = useState(false);
  const [text, setText] = useState('');
  const answer = useInboxAnswer();
  const reasonId = useId();
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
    <Button
      variant="primary"
      type="button"
      size="sm"
      disabled={disabled}
      title={disabledReason || undefined}
      aria-describedby={described}
      onClick={() => answer({ kind: 'approve', id, title, project, proposalVersion })}
      data-task-action="approve"
    >
      <Check aria-hidden strokeWidth={2} />
      Approve
    </Button>
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
  const box = !answering ? null : doing ? (
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
  const buttons = (
    <>
      {control}
      {reason ? (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      ) : null}
    </>
  );
  return { buttons, box };
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
