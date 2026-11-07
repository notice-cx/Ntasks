import { useState, type ReactNode } from 'react';
import { Check, Reply, SendHorizontal } from 'lucide-react';
import type { TaskChoiceKey, TaskChoices } from '@/api/types';
import { ChoiceButtons } from '@/components/ChoiceButtons';
import { Button } from '@/components/ui/button';
import { fieldClass } from '@/components/ui/chrome';
import { useInboxAnswer } from '@/hooks/useTasks';
import type { InboxAsk } from '@/lib/task-model';
import { cn } from '@/lib/utils';
import { useCloseAs } from './close-actions';

/**
 * What a task waiting on a person offers, on its decision row and its own
 * page: Approve on an approval; Answer and Close as on a question; and on a
 * question that carries options, one button per option with Answer and
 * Close as under them. Every answer waits in the Undo window. `buttons` sit
 * beside the title and `box` under it; both are null when nothing is asked.
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
  /** A row indents the box under its title; the page's header sets it in a panel. */
  placement: 'row' | 'header';
  /** An option was pressed: the page draws it as the pick while the Undo window runs. */
  onChosen?: (option: TaskChoiceKey) => void;
}): { buttons: ReactNode; box: ReactNode } {
  const [answering, setAnswering] = useState(false);
  const [text, setText] = useState('');
  const answer = useInboxAnswer();
  const indent = placement === 'row' ? 'pb-2 pe-2 ps-9' : undefined;
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
      className={indent}
      disabledReason={quiet(chooseDisabledReason)}
      onChoose={(option, note) => {
        const label = choices.options.find((entry) => entry.key === option)?.label;
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
      }}
      footer={answerVerbs}
    />
  ) : null;

  const answerBox = answering ? (
    <form
      className={cn('flex items-start gap-2 max-sm:flex-wrap', indent)}
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

  const closeBox = closeAs.box ? <div className={indent}>{closeAs.box}</div> : null;
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
