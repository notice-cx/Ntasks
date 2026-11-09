import { useState, type ComponentType, type FormEvent } from 'react';
import { Check, CheckCheck, ChevronDown, CircleSlash, Copy, SearchX } from 'lucide-react';
import { toast } from 'sonner';
import { isTaskId, type TaskResolution } from '@ntasks/domain';
import { Button } from './ui/button';
import { Field, Input, Textarea } from './ui/field';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from './ui/menu';
import { useCloseTask } from '../hooks/useTasks';
import { NOT_DONE, RESOLUTION_LABELS, type NotDone } from '../lib/task-model';

/** Each close where nothing shipped wears a glyph beside its words; none has a colour of its own. */
export const RESOLUTION_GLYPH: Readonly<Record<NotDone, ComponentType<{ className?: string }>>> = {
  'wont-do': CircleSlash,
  duplicate: Copy,
  'cant-reproduce': SearchX,
  'already-handled': CheckCheck,
  'no-longer-needed': CircleSlash,
};

/**
 * The ways a close can end, as a menu on a button: Done first when the task
 * can be closed as done, then each close where nothing shipped. Picking one
 * hands it to `onPick`, which opens the form that finishes it.
 */
export function CloseMenu({
  label,
  subject,
  done = false,
  onPick,
  variant = 'secondary',
  disabledReason = null,
}: {
  /** The button's words: Close, or Close as when Done is not on offer. */
  label: string;
  /** What the menu closes, named for a screen reader. */
  subject: string;
  done?: boolean;
  onPick: (resolution: TaskResolution) => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  /** Why this sign-in cannot close it, shown as the button's tip; null when it can. */
  disabledReason?: string | null;
}) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          type="button"
          variant={variant}
          disabled={disabledReason !== null}
          title={disabledReason ?? undefined}
          data-close-trigger=""
        >
          <Check aria-hidden />
          {label}
          <ChevronDown aria-hidden />
        </Button>
      </MenuTrigger>
      <MenuContent label={`Close ${subject} as`} align="end">
        {done ? (
          <>
            <MenuItem icon={<Check aria-hidden />} onSelect={() => onPick('done')}>
              {RESOLUTION_LABELS.done}
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        {NOT_DONE.map((resolution) => {
          const Glyph = RESOLUTION_GLYPH[resolution];
          return (
            <MenuItem key={resolution} icon={<Glyph aria-hidden />} onSelect={() => onPick(resolution)}>
              {RESOLUTION_LABELS[resolution]}
            </MenuItem>
          );
        })}
      </MenuContent>
    </Menu>
  );
}

export interface CloseAsInput {
  note?: string;
  duplicateOf?: string;
}

/**
 * The line a close where nothing shipped takes: its resolution named, a
 * Note, and for a duplicate the other task's id first. Enter sends, Escape
 * steps back; the caller's send carries the Undo.
 */
export function CloseNoteForm({
  id,
  resolution,
  onSend,
  onCancel,
}: {
  id: string;
  resolution: NotDone;
  onSend: (close: CloseAsInput) => void;
  onCancel: () => void;
}) {
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
      className="flex flex-wrap items-end gap-2"
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
      <span className="inline-flex h-7.5 shrink-0 items-center gap-1.5 text-label font-semibold text-ink [&_svg]:size-[15px] [&_svg]:text-ink-3">
        <Glyph aria-hidden />
        {RESOLUTION_LABELS[resolution]}
      </span>
      {duplicate ? (
        <Field label="Duplicate of" required className="w-40">
          <Input
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            className="nums"
            value={other}
            onChange={(event) => setOther(event.target.value)}
            aria-invalid={otherId !== '' && !ready ? true : undefined}
          />
        </Field>
      ) : null}
      <Field label="Note" className="min-w-0 flex-1 basis-56">
        <Input autoFocus={!duplicate} value={note} onChange={(event) => setNote(event.target.value)} />
      </Field>
      <Button variant="primary" type="submit" disabled={!ready} data-task-confirm="close-as">
        Close task
      </Button>
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

/** Close a task as done, with its evidence: a commit, a link, what proves it. */
export function CloseDoneForm({
  id,
  project,
  multiline = false,
  onDone,
}: {
  id: string;
  project: string;
  /** A field of several lines, where the page has the room; a row takes one. */
  multiline?: boolean;
  onDone: () => void;
}) {
  const close = useCloseTask();
  const [reason, setReason] = useState('');
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (reason.trim() === '' || close.isPending) return;
    try {
      await close.mutateAsync({ id, project, reason: reason.trim() });
    } catch (error) {
      toast.error(error instanceof Error && error.message !== '' ? error.message : `Could not close ${id}`);
      return;
    }
    toast.success(`Closed ${id}`);
    onDone();
  }
  const fieldProps = {
    autoFocus: true,
    value: reason,
    onChange: (event: { target: { value: string } }) => setReason(event.target.value),
  };
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      data-task-form="close"
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onDone();
        }
      }}
    >
      <Field label="Evidence" required className="min-w-0 flex-1 basis-64">
        {multiline ? (
          <Textarea
            rows={2}
            {...fieldProps}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter is a new line.
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void submit();
            }}
          />
        ) : (
          <Input {...fieldProps} />
        )}
      </Field>
      <Button
        variant="primary"
        type="submit"
        disabled={close.isPending || reason.trim() === ''}
        data-task-confirm="close"
      >
        <Check aria-hidden strokeWidth={2} />
        {close.isPending ? 'Closing…' : 'Close task'}
      </Button>
      <Button type="button" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}
