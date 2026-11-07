import { Star } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { TASK_CHOICE_KEYS, type TaskChoiceKey } from '@/api/types';
import { choiceName } from '@/lib/task-model';
import { cn } from '@/lib/utils';
import { Kbd } from './kbd';
import { roveFocus } from './rove';

/**
 * Choosing among a decision's options, each named by its letter. `Segmented`
 * answers in place on a row: one press is the answer. `OptionList` is the
 * decision card's list: a press or the letter selects an option, and the
 * card's Answer sends it. `Tabs` switches the view of a page.
 */

export interface ChoiceOption {
  key: TaskChoiceKey;
  label: string;
  detail?: string;
  recommended?: boolean;
}

/** The option a key press names: its letter, either case, among the options offered. */
export function choiceForKey(key: string, options: readonly Pick<ChoiceOption, 'key'>[]): TaskChoiceKey | null {
  const letter = TASK_CHOICE_KEYS.find((candidate) => candidate === key.toLowerCase());
  return letter !== undefined && options.some((option) => option.key === letter) ? letter : null;
}

function optionName(option: ChoiceOption): string {
  return `${choiceName(option.key, option.label)}${option.recommended ? ', recommended' : ''}`;
}

const RecommendedStar = ({ size = 12 }: { size?: number }) => (
  <Star aria-hidden size={size} strokeWidth={2} className="shrink-0 text-ink-3" />
);

/**
 * A row's answer: the options side by side in one ringed strip, each its key,
 * its label and a star when recommended. On a phone the options wrap, each in
 * its own ring.
 */
export function Segmented({
  question,
  options,
  onChoose,
  disabled = false,
  className,
}: {
  /** What the options answer; the group's name for a screen reader. */
  question: string;
  options: readonly ChoiceOption[];
  onChoose: (key: TaskChoiceKey) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={question}
      className={cn(
        'inline-flex overflow-hidden rounded-md bg-background inset-ring inset-ring-border',
        'max-sm:flex-wrap max-sm:gap-1.5 max-sm:overflow-visible max-sm:bg-transparent max-sm:inset-ring-0',
        className,
      )}
    >
      {options.map((option, index) => (
        <button
          key={option.key}
          type="button"
          disabled={disabled}
          aria-label={optionName(option)}
          data-choice-option={option.key}
          className={cn(
            'inline-flex h-6.5 items-center gap-1.5 whitespace-nowrap ps-1.25 pe-2.25 text-meta font-medium text-ink outline-none',
            'transition-colors duration-120 hover:bg-hover focus-visible:bg-hover focus-visible:inset-ring-2 focus-visible:inset-ring-accent',
            'disabled:pointer-events-none disabled:opacity-45',
            index > 0 && 'shadow-[inset_1px_0_0_var(--border)]',
            'max-sm:h-7.5 max-sm:rounded-md max-sm:bg-background max-sm:shadow-none max-sm:inset-ring max-sm:inset-ring-border',
          )}
          onClick={() => onChoose(option.key)}
        >
          <Kbd size="sm">{option.key.toUpperCase()}</Kbd>
          {option.label}
          {option.recommended ? <RecommendedStar /> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * The decision card's options, one per line: key, label in 14 px semibold,
 * the detail under it in Text 3, and Recommended at the end of its line.
 * The selected option is ringed in Accent on Accent soft. Inside the list, a
 * letter selects its option and ↑ ↓ move between them.
 */
export function OptionList({
  question,
  options,
  value,
  onChange,
  disabled = false,
  className,
}: {
  question: string;
  options: readonly ChoiceOption[];
  value: TaskChoiceKey | null;
  onChange: (key: TaskChoiceKey) => void;
  disabled?: boolean;
  className?: string;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (roveFocus(event, '[role="radio"]:not([disabled])')) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = choiceForKey(event.key, options);
    if (key === null || disabled) return;
    event.preventDefault();
    onChange(key);
  }
  return (
    <div role="radiogroup" aria-label={question} className={cn('flex flex-col gap-2', className)} onKeyDown={onKeyDown}>
      {options.map((option, index) => {
        const selected = option.key === value;
        return (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={optionName(option)}
            tabIndex={selected || (value === null && index === 0) ? 0 : -1}
            disabled={disabled}
            data-choice-option={option.key}
            className={cn(
              'grid grid-cols-[22px_1fr_auto] gap-x-2.5 gap-y-0.5 rounded-lg px-3 py-2.75 text-start',
              'transition-[background-color,box-shadow] duration-120',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              'disabled:pointer-events-none disabled:opacity-45',
              selected
                ? 'bg-accent-soft inset-ring-[1.5px] inset-ring-accent'
                : 'inset-ring inset-ring-border hover:bg-hover',
            )}
            onClick={() => onChange(option.key)}
          >
            <Kbd className="row-span-2 mt-px">{option.key.toUpperCase()}</Kbd>
            <span className="text-sm font-semibold text-ink">{option.label}</span>
            {option.recommended ? (
              <span className="col-start-3 row-start-1 inline-flex items-center gap-1 text-chip font-medium text-ink-2">
                <RecommendedStar />
                Recommended
              </span>
            ) : null}
            {option.detail ? (
              <span className="col-start-2 text-label font-normal text-ink-3">{option.detail}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** A page's views, such as All, Active and Done: the current one is ringed on Surface. */
export function Tabs<T extends string>({
  label,
  items,
  value,
  onChange,
  className,
}: {
  label: string;
  items: readonly { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn('flex gap-0.5', className)}>
      {items.map((item) => {
        const on = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={on}
            className={cn(
              'inline-flex h-6.5 items-center rounded-md px-2.25 text-label font-medium pointer-coarse:h-7.5',
              'transition-colors duration-120 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              on ? 'bg-surface text-ink inset-ring inset-ring-border' : 'text-ink-3 hover:text-ink',
            )}
            onClick={() => onChange(item.value)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
