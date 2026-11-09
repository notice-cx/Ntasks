import { useId, useState } from 'react';
import { Check } from 'lucide-react';
import { toast } from 'sonner';
import type { StepMark, StepMarking, TaskActor, TaskStep } from '../../api/types';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/field';
import { useMarkStep } from '../../hooks/useTasks';
import { ageMs, formatAge } from '../../lib/format';
import { actorLabel, stepsDone } from '../../lib/task-model';
import { cn } from '../../lib/utils';
import { MarkdownText } from './task-markdown';

/** The longest note or reason a step takes, as the server accepts it. */
export const STEP_NOTE_MAX = 1024;

/** A command as a fenced code block, fenced longer than any run of backticks in it, so Markdown shows it whole. */
export function commandBlock(command: string): string {
  const longest = Math.max(2, ...Array.from(command.matchAll(/`+/gu), (run) => run[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${command}\n${fence}`;
}

/**
 * The steps of a request that a person do steps, in order. Each step is a
 * box to tick, its text, its command as a block to copy, and who ticked it,
 * their note and where they were stuck. While the request is open and this
 * sign-in may mark steps, each step also offers Note and Stuck here. A tick
 * is sent at once; the last one closes the request.
 */
export function StepList({
  id,
  project,
  steps,
  proposalVersion,
  open,
  disabledReason = null,
  actors,
  nowMs,
}: {
  id: string;
  project: string;
  steps: readonly TaskStep[];
  proposalVersion: string | null;
  /** The request is open, so its steps can be marked. */
  open: boolean;
  /** Why this sign-in cannot mark steps, or null when it can. */
  disabledReason?: string | null;
  actors?: readonly TaskActor[];
  nowMs: number;
}) {
  const mark = useMarkStep();
  const headId = useId();
  const markable = open && disabledReason === null;

  function send(marking: StepMarking, after?: () => void) {
    mark.mutate(
      { id, project, proposalVersion, ...marking },
      { onSuccess: () => after?.(), onError: (error) => toast.error(error.message) },
    );
  }

  return (
    <section aria-labelledby={headId} className="flex flex-col gap-3" data-task-steps="">
      <h2 id={headId} className="m-0 flex items-baseline gap-2 text-sm font-semibold text-ink">
        Your steps
        <span className="nums text-meta font-normal text-ink-3">
          {stepsDone(steps)} of {steps.length} done
        </span>
      </h2>
      <ol className="m-0 flex list-none flex-col gap-4 p-0">
        {steps.map((step, index) => (
          <StepItem
            key={index}
            place={index + 1}
            step={step}
            markable={markable}
            pending={mark.isPending}
            disabledReason={open ? disabledReason : null}
            actors={actors}
            nowMs={nowMs}
            onMark={send}
          />
        ))}
      </ol>
    </section>
  );
}

function StepItem({
  place,
  step,
  markable,
  pending,
  disabledReason,
  actors,
  nowMs,
  onMark,
}: {
  place: number;
  step: TaskStep;
  markable: boolean;
  pending: boolean;
  disabledReason: string | null;
  actors?: readonly TaskActor[];
  nowMs: number;
  onMark: (marking: StepMarking, after?: () => void) => void;
}) {
  const [form, setForm] = useState<'note' | 'stuck' | null>(null);
  const done = step.done !== null;
  const state = done ? 'done' : step.stuck !== null ? 'stuck' : 'todo';
  const by = (mark: StepMark) => {
    const age = ageMs(nowMs, mark.at);
    return `${actorLabel(mark.by, actors)}${age === null ? '' : ` · ${formatAge(age)} ago`}`;
  };
  return (
    <li className="flex items-start gap-3" data-step={place} data-step-state={state}>
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={`Step ${place}`}
        aria-describedby={`step-${place}-text`}
        disabled={!markable || pending}
        title={disabledReason ?? undefined}
        onClick={() => onMark({ step: place, done: !done })}
        className="mt-0.5 -m-1 shrink-0 rounded-sm p-1 outline-none focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default"
        data-step-box={state}
      >
        <span
          aria-hidden
          className={cn(
            'grid size-[17px] place-items-center rounded-sm',
            done ? 'bg-accent text-on-accent' : 'bg-background inset-ring-[1.5px] inset-ring-border-strong',
          )}
        >
          {done ? <Check size={12} strokeWidth={3} /> : null}
        </span>
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div id={`step-${place}-text`} className="flex items-baseline gap-2">
          <span className="nums text-meta text-ink-3">{place}.</span>
          <MarkdownText source={step.text} className={cn('text-sm', done ? 'text-ink-2' : 'text-ink')} />
        </div>
        {step.command !== null ? <MarkdownText source={commandBlock(step.command)} /> : null}
        {step.done !== null ? <p className="m-0 text-meta text-ink-3">Done by {by(step.done)}</p> : null}
        {step.stuck !== null ? (
          <p className="m-0 text-meta text-wait-text [overflow-wrap:anywhere]" data-step-stuck="">
            Stuck: {step.stuck.reason} <span className="text-ink-3">({by(step.stuck)})</span>
          </p>
        ) : null}
        {step.note !== null ? (
          <p className="m-0 text-meta text-ink-2 [overflow-wrap:anywhere]" data-step-note="">
            Note: {step.note.text} <span className="text-ink-3">({by(step.note)})</span>
          </p>
        ) : null}
        {markable && form === null ? (
          <div className="flex gap-1.5">
            <Button type="button" size="sm" variant="ghost" onClick={() => setForm('note')} data-step-action="note">
              {step.note === null ? 'Add note' : 'Edit note'}
            </Button>
            {done ? null : (
              <Button type="button" size="sm" variant="ghost" onClick={() => setForm('stuck')} data-step-action="stuck">
                Stuck here
              </Button>
            )}
          </div>
        ) : null}
        {markable && form !== null ? (
          <StepForm
            place={place}
            kind={form}
            initial={form === 'note' ? (step.note?.text ?? '') : ''}
            pending={pending}
            onCancel={() => setForm(null)}
            onSave={(words) =>
              onMark(
                form === 'note' ? { step: place, note: words === '' ? null : words } : { step: place, stuck: words },
                () => setForm(null),
              )
            }
          />
        ) : null}
      </div>
    </li>
  );
}

/** A note on a step, or why the person stopped at it. Enter saves, Shift+Enter is a new line, Escape steps back. */
function StepForm({
  place,
  kind,
  initial,
  pending,
  onSave,
  onCancel,
}: {
  place: number;
  kind: 'note' | 'stuck';
  initial: string;
  pending: boolean;
  onSave: (words: string) => void;
  onCancel: () => void;
}) {
  const [words, setWords] = useState(initial);
  const hintId = useId();
  const trimmed = words.trim();
  // A stuck mark needs its reason; an empty note takes the note off.
  const ready = kind === 'note' ? trimmed !== initial.trim() : trimmed !== '';
  return (
    <form
      className="flex flex-col gap-2"
      data-step-form={kind}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !pending) onSave(trimmed);
      }}
    >
      <Textarea
        autoFocus
        rows={2}
        maxLength={STEP_NOTE_MAX}
        aria-label={kind === 'note' ? `Note on step ${place}` : `What stopped you at step ${place}`}
        aria-describedby={kind === 'note' ? hintId : undefined}
        value={words}
        onChange={(event) => setWords(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (ready && !pending) onSave(trimmed);
        }}
      />
      {kind === 'note' ? (
        <p id={hintId} className="m-0 text-meta text-ink-3">
          Never paste a password, key or token here.
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button variant="primary" type="submit" size="sm" disabled={!ready || pending}>
          {kind === 'note' ? 'Save note' : 'Send'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
