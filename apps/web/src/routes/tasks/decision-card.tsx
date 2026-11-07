import { useId, type ReactNode } from 'react';
import type { TaskChoiceKey, TaskChoices } from '@/api/types';
import { Button } from '@/components/ui/button';
import { OptionList, type ChoiceOption } from '@/components/ui/choice';
import { Input } from '@/components/ui/field';
import { Kbd } from '@/components/ui/kbd';
import { choiceOrder } from '@/lib/task-model';

/** The longest note a pick may carry. */
export const NOTE_MAX = 2000;

/** A decision's options in the order a card lists them, as `OptionList` takes them. */
export function cardOptions(choices: TaskChoices): ChoiceOption[] {
  return choiceOrder(choices).map((option) => ({
    key: option.key,
    label: option.label,
    ...(option.detail ? { detail: option.detail } : {}),
    ...(option.recommended ? { recommended: true } : {}),
  }));
}

/**
 * A decision answered on a card: its options, a Note, whatever the caller
 * seats beside them (Not now on Focus), and Answer. A press or an option's
 * letter selects it; Answer or Enter sends the selected option, and Enter on
 * a focused option sends that one. The caller holds the selection and the
 * note, so its own keys can reach them.
 */
export function DecisionAnswer({
  choices,
  value,
  onChange,
  note,
  onNote,
  onAnswer,
  disabledReason = null,
  footer,
}: {
  choices: TaskChoices;
  value: TaskChoiceKey | null;
  onChange: (key: TaskChoiceKey) => void;
  note: string;
  onNote: (note: string) => void;
  onAnswer: (key: TaskChoiceKey) => void;
  /** Why this sign-in cannot answer, shown as a tip and read with each option; null when it can. */
  disabledReason?: string | null;
  footer?: ReactNode;
}) {
  const reasonId = useId();
  const disabled = disabledReason !== null;
  return (
    <form
      className="flex flex-col gap-3"
      data-decision=""
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && value !== null) onAnswer(value);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || disabled || !(event.target instanceof HTMLElement)) return;
        const key = event.target.closest<HTMLElement>('[role="radio"]')?.dataset.choiceOption as
          TaskChoiceKey | undefined;
        if (key === undefined) return;
        event.preventDefault();
        onChange(key);
        onAnswer(key);
      }}
    >
      <OptionList
        question={choices.question}
        options={cardOptions(choices)}
        value={value}
        onChange={onChange}
        disabled={disabled}
        describedBy={disabledReason ? reasonId : undefined}
      />
      <div className="flex items-center gap-2 max-sm:flex-wrap">
        <Input
          aria-label="Note"
          placeholder="Note"
          maxLength={NOTE_MAX}
          value={note}
          disabled={disabled}
          onChange={(event) => onNote(event.target.value)}
          boxClassName="flex-1 max-sm:basis-full"
          data-decision-note=""
        />
        {footer}
        <Button
          variant="primary"
          type="submit"
          disabled={disabled || value === null}
          title={disabledReason ?? undefined}
          aria-keyshortcuts="Enter"
          data-decision-answer=""
        >
          Answer <Kbd>↵</Kbd>
        </Button>
      </div>
      {disabledReason ? (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      ) : null}
    </form>
  );
}
