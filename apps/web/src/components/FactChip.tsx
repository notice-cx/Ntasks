import { useState, type ReactNode } from 'react';
import { Check, ChevronDown, CornerDownLeft, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { fieldClass } from '@/components/ui/chrome';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { focusStart, roveFocus } from '@/components/ui/rove';
import { cn } from '@/lib/utils';

export interface FactChoice {
  value: string;
  label: string;
  mark?: ReactNode;
}

/** How a fact is edited: pick a choice (or type another value), type a value, or pick a date. */
export type FactEditor =
  | { kind: 'choice'; value: string; choices: readonly FactChoice[]; other?: { label: string; placeholder?: string } }
  | { kind: 'text'; value: string; inputLabel: string; placeholder?: string }
  | { kind: 'date'; value: string; presets?: readonly { label: string; value: string }[]; clearLabel?: string };

export const factChipClass =
  'inline-flex min-h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-0.5 text-left text-xs font-medium text-foreground';

const pressable = cn(
  'group outline-none hover:border-foreground/30 hover:bg-muted/60 active:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring',
  'data-[state=open]:border-ring/60 data-[state=open]:bg-muted max-sm:min-h-11',
);

/**
 * A fact drawn as its value that edits where it is read: a press opens a
 * small editor, a choice or Enter saves at once (the caller's save carries
 * the Undo), and Escape leaves it as it was. Without write permission it is
 * the same chip with nothing to press.
 */
export function FactChip({
  label,
  valueText,
  children,
  to,
  editor,
  onSave,
  readOnly = false,
  quiet = false,
  className,
}: {
  label: string;
  valueText: string;
  children: ReactNode;
  to?: string;
  editor?: FactEditor;
  onSave?: (next: string) => Promise<boolean>;
  readOnly?: boolean;
  quiet?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const editable = editor !== undefined && onSave !== undefined && !readOnly;
  // A long value wraps between its parts and its words, never inside a name.
  const face = (
    <span
      className={cn(
        'inline-flex min-w-0 flex-wrap items-center gap-x-1.5 break-words',
        quiet && 'text-muted-foreground',
      )}
    >
      {children}
    </span>
  );

  async function save(next: string) {
    setOpen(false);
    if (!editable || saving || next === editor.value) return;
    setSaving(true);
    try {
      await onSave?.(next);
    } finally {
      setSaving(false);
    }
  }

  if (!editable) {
    return to ? (
      <Link to={to} data-fact-chip="link" className={cn(factChipClass, pressable, className)}>
        {face}
      </Link>
    ) : (
      <span data-fact-chip="plain" className={cn(factChipClass, className)}>
        {face}
      </span>
    );
  }

  const name = valueText === '' ? label : `${label}: ${valueText}`;
  const status = saving ? (
    <LoaderCircle aria-hidden className="size-3 shrink-0 motion-safe:animate-spin" />
  ) : (
    <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground group-data-[state=open]:rotate-180" />
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {to ? (
        <span data-fact-chip="split" className={cn(factChipClass, 'gap-0 p-0', className)}>
          <Link
            to={to}
            className={cn(
              'inline-flex min-h-7 min-w-0 items-center gap-1.5 rounded-s-full py-0.5 ps-2.5 pe-2',
              pressable,
            )}
          >
            {face}
          </Link>
          <PopoverTrigger
            type="button"
            aria-label={`Change ${label.toLowerCase()}`}
            className={cn('inline-flex min-h-7 items-center rounded-e-full border-s border-border px-1.5', pressable)}
          >
            {status}
          </PopoverTrigger>
        </span>
      ) : (
        <PopoverTrigger
          type="button"
          aria-label={`Change ${name}`}
          data-fact-chip="edit"
          className={cn(factChipClass, pressable, className)}
        >
          {face}
          {status}
        </PopoverTrigger>
      )}
      <PopoverContent
        aria-label={label}
        className="w-64 p-1.5"
        // The editor opens on the value it holds, else on its first option or its field.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusStart(event.target as HTMLElement, '[role="option"], input', '[role="option"][aria-selected="true"]');
        }}
      >
        <Editor editor={editor} label={label} onSave={(next) => void save(next)} />
      </PopoverContent>
    </Popover>
  );
}

function Editor({ editor, label, onSave }: { editor: FactEditor; label: string; onSave: (next: string) => void }) {
  const [typed, setTyped] = useState(editor.kind === 'choice' ? '' : editor.value);
  const typedField = (inputLabel: string, placeholder?: string, kind: 'text' | 'date' = 'text') => (
    <form
      className="flex items-center gap-1.5 p-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (typed.trim() !== '') onSave(typed.trim());
      }}
    >
      <input
        type={kind}
        aria-label={inputLabel}
        placeholder={placeholder}
        className={cn(fieldClass, 'h-8 min-w-0 flex-1')}
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
      />
      <button
        type="submit"
        aria-label={`Save ${label.toLowerCase()}`}
        className="grid size-8 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CornerDownLeft className="size-4" aria-hidden />
      </button>
    </form>
  );
  if (editor.kind === 'text') return typedField(editor.inputLabel, editor.placeholder);
  if (editor.kind === 'date') {
    return (
      <div className="flex flex-col gap-0.5">
        <Options label={label}>
          {(editor.presets ?? []).map((preset) => (
            <Option
              key={preset.value}
              label={preset.label}
              picked={preset.value === editor.value}
              onPick={() => onSave(preset.value)}
            />
          ))}
          {editor.value !== '' && editor.clearLabel ? (
            <Option label={editor.clearLabel} picked={false} onPick={() => onSave('')} />
          ) : null}
        </Options>
        {typedField(`${label} date`, undefined, 'date')}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      <Options label={label}>
        {editor.choices.map((choice) => (
          <Option
            key={choice.value || 'none'}
            label={choice.label}
            mark={choice.mark}
            picked={choice.value === editor.value}
            onPick={() => onSave(choice.value)}
          />
        ))}
      </Options>
      {/* A typed value is a field beside the list, never an item in it. */}
      {editor.other ? typedField(editor.other.label, editor.other.placeholder) : null}
    </div>
  );
}

/** A list of options: a listbox that holds only its options, moved through with the arrow keys. */
function Options({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className="flex flex-col gap-0.5"
      role="listbox"
      aria-label={label}
      onKeyDown={(event) => roveFocus(event, '[role="option"]')}
    >
      {children}
    </div>
  );
}

function Option({
  label,
  mark,
  picked,
  onPick,
}: {
  label: string;
  mark?: ReactNode;
  picked: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={picked}
      onClick={onPick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm text-foreground outline-none hover:bg-muted focus-visible:bg-muted max-sm:min-h-11"
    >
      {mark ? (
        <span aria-hidden className="inline-flex shrink-0">
          {mark}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{label}</span>
      {picked ? <Check aria-hidden className="size-4 shrink-0 text-primary" /> : null}
    </button>
  );
}
