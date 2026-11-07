import { useState, type ReactNode } from 'react';
import { ChevronDown, CornerDownLeft, LoaderCircle } from 'lucide-react';
import { IconButton } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { PopoverAnchor } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface FactChoice {
  value: string;
  label: string;
  /** A symbol before the words: a status or priority mark, an avatar, an epic's icon. */
  mark?: ReactNode;
}

/**
 * How a fact is changed: pick one value (or type one the list does not
 * hold), turn values on and off (labels), or pick a date.
 */
export type FactEditor =
  | { kind: 'choice'; value: string; choices: readonly FactChoice[]; other?: string }
  | { kind: 'toggle'; values: readonly string[]; choices: readonly FactChoice[]; other?: string }
  | { kind: 'date'; value: string; presets: readonly FactChoice[]; clear?: string };

/**
 * One fact in a task's side panel: its name in Text 3, then its value as
 * plain text. A fact this sign-in may change opens a menu of values from
 * anywhere on its line, and shows the menu's chevron while the line is
 * hovered or focused; a fact it may not change is only its words. A pick
 * saves at once, through `onSave`, which carries the Undo.
 */
export function Fact({
  label,
  valueText,
  children,
  muted = false,
  wrap = false,
  editor,
  onSave,
  className,
}: {
  label: string;
  /** The value in words, for the control's name. */
  valueText: string;
  children: ReactNode;
  /** The value is an absence, such as None or Nobody, drawn in Text 3. */
  muted?: boolean;
  /** The value is several parts, such as labels, that take more lines when they need them; any other is cut to one. */
  wrap?: boolean;
  editor?: FactEditor | null;
  /** Saves a picked value; for a `toggle` editor, the value turned on or, with `false`, off. */
  onSave?: (next: string, on?: boolean) => Promise<boolean>;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const editable = editor != null && onSave !== undefined;
  const face = (end?: ReactNode) => (
    <dd
      className={cn(
        'm-0 flex min-w-0 flex-1 items-center gap-x-2 gap-y-1 text-[13.5px] leading-5',
        wrap
          ? 'flex-wrap'
          : 'whitespace-nowrap [&>span:not([data-avatar])]:min-w-0 [&>span:not([data-avatar])]:truncate',
        muted ? 'text-ink-3' : 'font-medium text-ink',
      )}
    >
      {children}
      {end}
    </dd>
  );
  const row = cn(
    'relative flex min-h-8 items-center gap-2 rounded-md px-2 py-1.5',
    editable && 'transition-colors duration-120 hover:bg-hover has-[[aria-expanded=true]]:bg-hover',
    className,
  );
  const name = <dt className="w-[92px] shrink-0 self-start pt-px text-meta font-medium text-ink-3">{label}</dt>;

  if (!editable) {
    return (
      <div className={row} data-fact={label}>
        {name}
        {face()}
      </div>
    );
  }

  async function save(next: string, on?: boolean) {
    if (!onSave) return;
    // A pick closes the menu and waits for its save; toggles stay open and may follow one another.
    if (editor?.kind !== 'toggle') {
      if (saving) return;
      setOpen(false);
    }
    setSaving(true);
    try {
      await onSave(next, on);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className={cn(row, 'group/fact')} data-fact={label}>
          {name}
          {face(
            <MenuTrigger asChild>
              <button
                type="button"
                aria-label={`${label}: ${valueText}`}
                className={cn(
                  // The button reaches over the whole line, so a press on the name or the value opens it.
                  'ms-auto inline-grid size-5 shrink-0 place-items-center self-start rounded-sm text-ink-3 outline-none',
                  'after:absolute after:inset-0 after:rounded-md focus-visible:after:outline-2 focus-visible:after:outline-accent',
                  'opacity-0 group-hover/fact:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100',
                  saving && 'opacity-100',
                )}
                data-fact-edit=""
              >
                {saving ? (
                  <LoaderCircle aria-hidden size={14} className="motion-safe:animate-spin" />
                ) : (
                  <ChevronDown aria-hidden size={14} />
                )}
              </button>
            </MenuTrigger>,
          )}
        </div>
      </PopoverAnchor>
      <FactMenu label={label} editor={editor} onSave={(next, on) => void save(next, on)} />
    </Menu>
  );
}

/** A fact whose value is a link, such as an epic: the link opens it, and the chevron beside it changes it. */
export function LinkedFact({
  label,
  valueText,
  children,
  muted = false,
  editor,
  onSave,
}: {
  label: string;
  valueText: string;
  children: ReactNode;
  muted?: boolean;
  editor?: FactEditor | null;
  onSave?: (next: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const editable = editor != null && onSave !== undefined;
  return (
    <div className="group/fact flex min-h-8 items-center gap-2 rounded-md px-2 py-1.5" data-fact={label}>
      <dt className="w-[92px] shrink-0 self-start pt-px text-meta font-medium text-ink-3">{label}</dt>
      <dd
        className={cn(
          'm-0 flex min-w-0 flex-1 items-center gap-2 text-[13.5px] leading-5',
          muted ? 'text-ink-3' : 'font-medium text-ink',
        )}
      >
        {children}
        {editable ? (
          <Menu open={open} onOpenChange={setOpen}>
            <MenuTrigger asChild>
              <IconButton
                size="sm"
                label={`${label}: ${valueText}`}
                icon={<ChevronDown aria-hidden />}
                className="-my-1 -me-1.5 ms-auto opacity-0 group-hover/fact:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
                data-fact-edit=""
              />
            </MenuTrigger>
            <FactMenu
              label={label}
              editor={editor}
              align="end"
              onSave={(next) => {
                setOpen(false);
                void onSave(next);
              }}
            />
          </Menu>
        ) : null}
      </dd>
    </div>
  );
}

/** The menu a fact opens: its values, the one held ticked, then a field for a value the list does not hold. */
function FactMenu({
  label,
  editor,
  align = 'start',
  onSave,
}: {
  label: string;
  editor: FactEditor;
  align?: 'start' | 'end';
  onSave: (next: string, on?: boolean) => void;
}) {
  const typed =
    editor.kind === 'date' ? (
      <TypedValue label={`${label} date`} type="date" initial={editor.value} onSave={onSave} />
    ) : editor.other ? (
      <TypedValue
        label={editor.other}
        onSave={(next) => (editor.kind === 'toggle' ? onSave(next, true) : onSave(next))}
      />
    ) : null;
  return (
    <MenuContent label={label} align={align} footer={typed}>
      {editor.kind === 'choice'
        ? editor.choices.map((choice) => (
            <MenuItem
              key={choice.value || 'none'}
              icon={choice.mark}
              checked={choice.value === editor.value}
              onSelect={() => onSave(choice.value)}
            >
              {choice.label}
            </MenuItem>
          ))
        : editor.kind === 'toggle'
          ? editor.choices.map((choice) => {
              const on = editor.values.includes(choice.value);
              return (
                <MenuItem
                  key={choice.value}
                  icon={choice.mark}
                  checked={on}
                  keepOpen
                  onSelect={() => onSave(choice.value, !on)}
                >
                  {choice.label}
                </MenuItem>
              );
            })
          : [
              ...editor.presets.map((preset) => (
                <MenuItem
                  key={preset.value}
                  icon={preset.mark}
                  checked={preset.value === editor.value}
                  onSelect={() => onSave(preset.value)}
                >
                  {preset.label}
                </MenuItem>
              )),
              ...(editor.value !== '' && editor.clear
                ? [
                    <MenuSeparator key="separator" />,
                    <MenuItem key="clear" onSelect={() => onSave('')}>
                      {editor.clear}
                    </MenuItem>,
                  ]
                : []),
            ]}
    </MenuContent>
  );
}

/** A value typed instead of picked: Enter saves it. */
function TypedValue({
  label,
  type = 'text',
  initial = '',
  onSave,
}: {
  label: string;
  type?: 'text' | 'date';
  initial?: string;
  onSave: (next: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim() !== '') onSave(value.trim());
      }}
    >
      <Input
        type={type}
        aria-label={label}
        placeholder={type === 'text' ? label : undefined}
        spellCheck={false}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <IconButton type="submit" size="sm" label={`Save ${label.toLowerCase()}`} icon={<CornerDownLeft aria-hidden />} />
    </form>
  );
}
