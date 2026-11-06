import { useId, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { CheckCheck, ChevronDown, CircleSlash, Copy, Lock, SearchX } from 'lucide-react';
import { isTaskId, TASK_RESOLUTIONS, type TaskResolution } from '@ntasks/domain';
import { Button } from '@/components/ui/button';
import { fieldClass, pillChoiceClass, pillChoiceStateClass } from '@/components/ui/chrome';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { focusStart, roveFocus } from '@/components/ui/rove';
import { NOT_DONE, RESOLUTION_LABELS, type NotDone } from '@/lib/task-model';
import { cn } from '@/lib/utils';

/** Each close where nothing shipped wears a glyph beside its words; none has a colour of its own. */
export const RESOLUTION_GLYPH: Readonly<Record<NotDone, ComponentType<{ className?: string }>>> = {
  'wont-do': CircleSlash,
  duplicate: Copy,
  'cant-reproduce': SearchX,
  'already-handled': CheckCheck,
  'no-longer-needed': CircleSlash,
};

/**
 * The ways a close ends, as one row of chips, Done first: a radio group whose
 * arrow keys move the pick. Every chip keeps its border, so a press never
 * reflows the row.
 */
export function ResolutionChips({
  value,
  onChange,
}: {
  value: TaskResolution;
  onChange: (resolution: TaskResolution, byKey: boolean) => void;
}) {
  const chips = useRef<(HTMLButtonElement | null)[]>([]);
  function step(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = TASK_RESOLUTIONS.length - 1;
    const to =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowRight' || event.key === 'ArrowDown'
            ? index === last
              ? 0
              : index + 1
            : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
              ? index === 0
                ? last
                : index - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    onChange(TASK_RESOLUTIONS[to] ?? 'done', true);
    chips.current[to]?.focus();
  }
  return (
    <div role="radiogroup" aria-label="How it ended" className="flex flex-wrap gap-1.5" data-resolution-chips="">
      {TASK_RESOLUTIONS.map((resolution, index) => {
        const picked = resolution === value;
        return (
          <button
            key={resolution}
            ref={(node) => {
              chips.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={picked}
            tabIndex={picked ? 0 : -1}
            className={cn(pillChoiceClass, pillChoiceStateClass(picked), 'py-1.5 motion-safe:active:scale-[0.97]')}
            data-resolution={resolution}
            onClick={() => onChange(resolution, false)}
            onKeyDown={(event) => step(event, index)}
          >
            <span
              aria-hidden
              className={cn('size-2.5 shrink-0 rounded-full border-[1.5px] border-current', picked && 'bg-current')}
            />
            {RESOLUTION_LABELS[resolution]}
          </button>
        );
      })}
    </div>
  );
}

/** The closes where nothing shipped, as a menu beside a row's other verbs. */
export function CloseAsMenu({
  onPick,
  subject,
  disabledReason = null,
}: {
  onPick: (resolution: NotDone) => void;
  subject: string;
  disabledReason?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  const disabled = disabledReason !== null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
            aria-haspopup="menu"
            disabled={disabled}
            aria-describedby={disabledReason ? reasonId : undefined}
            data-close-as-trigger=""
          >
            Close as
            <ChevronDown aria-hidden className={cn('motion-safe:transition-transform', open && 'rotate-180')} />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          role="menu"
          aria-label={`Close ${subject} as`}
          align="end"
          className="w-52 p-1.5"
          data-close-as-menu=""
          // A menu opens on its first item and moves with the arrow keys.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            focusStart(event.target as HTMLElement, '[role="menuitem"]');
          }}
          onKeyDown={(event) => roveFocus(event, '[role="menuitem"]')}
        >
          {NOT_DONE.map((resolution) => {
            const Glyph = RESOLUTION_GLYPH[resolution];
            return (
              <button
                key={resolution}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm text-foreground outline-none hover:bg-muted focus-visible:bg-muted max-sm:min-h-11"
                onClick={() => {
                  setOpen(false);
                  onPick(resolution);
                }}
                data-close-as={resolution}
              >
                <Glyph className="size-4 shrink-0 text-muted-foreground" />
                {RESOLUTION_LABELS[resolution]}
              </button>
            );
          })}
        </PopoverContent>
      </Popover>
      {disabledReason ? (
        <span id={reasonId} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="size-3.5 shrink-0" aria-hidden />
          {disabledReason}
        </span>
      ) : null}
    </span>
  );
}

export interface CloseAsInput {
  note?: string;
  duplicateOf?: string;
}

/**
 * The one line a close where nothing shipped takes: its resolution named, a
 * Note, and for a duplicate the other task's id first. Enter sends, Escape
 * steps back; the caller's send carries the Undo.
 */
export function CloseNoteForm({
  id,
  resolution,
  onSend,
  onCancel,
  named = true,
  autoFocus = true,
}: {
  id: string;
  resolution: NotDone;
  onSend: (close: CloseAsInput) => void;
  onCancel: () => void;
  /** Whether the line names its resolution; beside chips that already show it, it does not. */
  named?: boolean;
  autoFocus?: boolean;
}) {
  const ids = useId();
  const [note, setNote] = useState('');
  const [other, setOther] = useState('');
  const duplicate = resolution === 'duplicate';
  const otherId = other.trim();
  const ready = !duplicate || (isTaskId(otherId) && otherId !== id);
  const Glyph = RESOLUTION_GLYPH[resolution];

  function send() {
    if (!ready) return;
    const words = note.trim();
    onSend({ ...(words === '' ? {} : { note: words }), ...(duplicate ? { duplicateOf: otherId } : {}) });
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      data-task-form="close-as"
      data-close-resolution={resolution}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onCancel();
      }}
    >
      {named ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-foreground">
          <Glyph className="size-4 text-muted-foreground" aria-hidden />
          {RESOLUTION_LABELS[resolution]}
        </span>
      ) : null}
      {duplicate ? (
        <span className="flex items-center gap-2">
          <label htmlFor={`${ids}-other`} className="shrink-0 text-xs font-medium text-muted-foreground">
            Duplicate of
          </label>
          <input
            id={`${ids}-other`}
            type="text"
            autoFocus={autoFocus}
            spellCheck={false}
            autoCapitalize="off"
            className={cn(fieldClass, 'h-8 w-36 font-mono text-xs')}
            value={other}
            onChange={(event) => setOther(event.target.value)}
            aria-invalid={otherId !== '' && !ready ? true : undefined}
          />
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 basis-56 items-center gap-2">
        <label htmlFor={`${ids}-note`} className="shrink-0 text-xs font-medium text-muted-foreground">
          Note
        </label>
        <input
          id={`${ids}-note`}
          type="text"
          autoFocus={autoFocus && !duplicate}
          className={cn(fieldClass, 'h-8 min-w-0 flex-1')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </span>
      <span className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!ready} data-task-confirm="close-as">
          Close task
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </span>
    </form>
  );
}
