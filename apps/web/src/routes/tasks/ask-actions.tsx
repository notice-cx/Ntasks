import { useId, useState, type ReactNode } from 'react';
import { Check, CornerDownLeft, Reply, SendHorizontal } from 'lucide-react';
import type { TaskChoiceKey, TaskChoices } from '@/api/types';
import { ChoiceButtons } from '@/components/ChoiceButtons';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/choice';
import { fieldClass } from '@/components/ui/chrome';
import { Textarea } from '@/components/ui/field';
import { useInboxAnswer } from '@/hooks/useTasks';
import type { InboxAsk } from '@/lib/task-model';
import { cn } from '@/lib/utils';
import { useCloseAs } from './close-actions';

/**
 * What a task waiting on a person offers, on its row in Waiting for you and
 * on its own page. Every answer waits in the Undo window. `buttons` sit
 * beside the title and `box` under it; both are null when nothing is asked.
 *
 * On a row: Approve on an approval, the options side by side on a decision
 * (one press answers), and Answer on a question, which opens a box under
 * the row. Closing as something else is in the row's menu. On the page:
 * Approve; Answer and Close as on a question; and on a decision, one button
 * per option with Answer and Close as under them.
 */
export function useAskActions({
  ask,
  id,
  title,
  project,
  choices = null,
  disabledReason = null,
  chooseDisabledReason = disabledReason,
  placement,
  onChosen,
}: {
  ask: InboxAsk | null;
  id: string;
  title: string;
  project: string;
  choices?: TaskChoices | null;
  /** Why the verbs cannot run here, or null. */
  disabledReason?: string | null;
  chooseDisabledReason?: string | null;
  /** A row in Waiting for you, or the task page's header. */
  placement: 'row' | 'header';
  /** An option was pressed: the page draws it as the pick while the Undo window runs. */
  onChosen?: (option: TaskChoiceKey) => void;
}): { buttons: ReactNode; box: ReactNode } {
  const [answering, setAnswering] = useState(false);
  const [text, setText] = useState('');
  const answer = useInboxAnswer();
  const reasonId = useId();
  // The header writes the reason once beside its buttons, so the controls under it are disabled without repeating it.
  const quiet = (reason: string | null) => (placement === 'header' && reason !== null ? '' : reason);
  const closeAs = useCloseAs({
    id,
    title,
    project,
    via: 'dismiss',
    disabledReason: quiet(disabledReason),
    onOpen: () => setAnswering(false),
  });
  const disabled = disabledReason !== null;

  function send() {
    const words = text.trim();
    if (words === '') return;
    answer({ kind: 'answer', id, title, project, text: words });
    setText('');
    setAnswering(false);
  }

  if (ask === null) return { buttons: null, box: null };

  const choosing = ask === 'choose' && choices !== null;

  function choose(option: TaskChoiceKey, note?: string) {
    const label = choices?.options.find((entry) => entry.key === option)?.label;
    answer({
      kind: 'choose',
      id,
      title,
      project,
      option,
      ...(label === undefined ? {} : { label }),
      ...(note === undefined ? {} : { note }),
    });
    setAnswering(false);
    onChosen?.(option);
  }

  if (placement === 'row') {
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
          onChoose={(option) => choose(option)}
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
    const rowBox = answering ? (
      <form
        className="flex items-start gap-2 max-sm:flex-wrap"
        data-task-form="answer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <span className="min-w-0 flex-1 max-sm:basis-full">
          <Textarea
            autoFocus
            rows={2}
            aria-label={`Your answer to ${id}`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setAnswering(false);
                return;
              }
              // Enter sends; Shift+Enter is a new line.
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              send();
            }}
          />
        </span>
        <Button variant="primary" type="submit" size="sm" disabled={text.trim() === ''} data-task-confirm="answer">
          <SendHorizontal aria-hidden />
          Send
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setAnswering(false)}>
          Cancel
        </Button>
      </form>
    ) : null;
    const rowButtons = (
      <>
        {control}
        {reason ? (
          <span id={reasonId} className="sr-only">
            {reason}
          </span>
        ) : null}
      </>
    );
    return { buttons: rowButtons, box: rowBox };
  }
  // Under a set of options the free-text verbs step back: the options are what this question wants first.
  const answerVerbs = (
    <>
      <Button
        type="button"
        size="sm"
        variant={choosing || answering ? 'secondary' : 'primary'}
        aria-expanded={answering}
        disabled={disabled}
        onClick={() => {
          setAnswering((open) => !open);
          closeAs.cancel();
        }}
        data-task-action="answer"
      >
        <Reply aria-hidden />
        Answer
      </Button>
      {closeAs.menu}
    </>
  );

  const buttons =
    ask === 'approve' ? (
      <Button
        variant="primary"
        type="button"
        size="sm"
        disabled={disabled}
        onClick={() => answer({ kind: 'approve', id, title, project })}
        data-task-action="approve"
      >
        <Check aria-hidden />
        Approve
      </Button>
    ) : choosing ? null : (
      answerVerbs
    );

  const options = choosing ? (
    <ChoiceButtons
      choices={choices}
      disabledReason={quiet(chooseDisabledReason)}
      onChoose={(option, note) => choose(option, note)}
      footer={answerVerbs}
    />
  ) : null;

  const answerBox = answering ? (
    <form
      className="flex items-start gap-2 max-sm:flex-wrap"
      data-task-form="answer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <textarea
        autoFocus
        rows={1}
        className={cn(fieldClass, 'min-h-9 w-full flex-1 resize-y max-sm:basis-full')}
        aria-label={`Your answer to ${id}`}
        placeholder="Your answer"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setAnswering(false);
            return;
          }
          // Enter sends; Shift+Enter is a new line.
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          send();
        }}
      />
      <Button variant="primary" type="submit" size="sm" disabled={text.trim() === ''} data-task-confirm="answer">
        <SendHorizontal aria-hidden />
        Send
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setAnswering(false)}>
        Cancel
      </Button>
    </form>
  ) : null;

  const closeBox = closeAs.box;
  const box =
    options || answerBox || closeBox ? (
      <>
        {options}
        {answerBox}
        {closeBox}
      </>
    ) : null;
  return { buttons, box };
}
