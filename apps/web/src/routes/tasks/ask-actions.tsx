import { useId, useState, type ReactNode } from 'react';
import { Check, CornerDownLeft, SendHorizontal } from 'lucide-react';
import type { TaskChoiceKey, TaskChoices } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/choice';
import { Textarea } from '@/components/ui/field';
import { useInboxAnswer } from '@/hooks/useTasks';
import type { InboxAsk } from '@/lib/task-model';

/**
 * What a row in Waiting for you offers: Approve on an approval, the options
 * side by side on a decision (one press answers), and Answer on a question,
 * which opens a box under the row. Every answer waits in the Undo window.
 * `buttons` sit beside the title and `box` under it; both are null when
 * nothing is asked. Closing as something else is in the row's menu.
 */
export function useAskActions({
  ask,
  id,
  title,
  project,
  choices = null,
  disabledReason = null,
  chooseDisabledReason = disabledReason,
}: {
  ask: InboxAsk | null;
  id: string;
  title: string;
  project: string;
  choices?: TaskChoices | null;
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
    answer({ kind: 'answer', id, title, project, text: words });
    setText('');
    setAnswering(false);
  }

  function choose(option: TaskChoiceKey) {
    const label = choices?.options.find((entry) => entry.key === option)?.label;
    answer({ kind: 'choose', id, title, project, option, ...(label === undefined ? {} : { label }) });
  }

  // A row has no room to write why its controls are disabled, so each one
  // carries the reason as its description, and a pointer shows it as a tip.
  const reason = choosing ? chooseDisabledReason : disabledReason;
  const described = reason ? reasonId : undefined;
  const control =
    ask === 'approve' ? (
      <Button
        variant="primary"
        type="button"
        size="sm"
        disabled={disabled}
        title={disabledReason || undefined}
        aria-describedby={described}
        onClick={() => answer({ kind: 'approve', id, title, project })}
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
  const box = answering ? (
    <AnswerForm id={id} text={text} onText={setText} onSend={send} onCancel={() => setAnswering(false)} size="sm" />
  ) : null;
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
