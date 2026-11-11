import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, CornerDownLeft, LoaderCircle } from 'lucide-react';
import { IconButton } from './ui/button';
import { FieldError, Input } from './ui/field';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from './ui/menu';
import { PopoverAnchor } from './ui/popover';
import { cn } from '../lib/utils';

export interface FactChoice {
  value: string;
  label: string;
  /** A symbol before the words: a status or priority mark, an avatar, an epic's icon. */
  mark?: ReactNode;
}

/**
 * How a fact is changed: pick one value (or type one the list does not
 * hold), turn values on and off (labels), pick a date, or type a value
 * (an estimate, a number, a URL), with presets to pick from.
 *
 * `clear` is the item that takes the value off, offered while there is one;
 * it saves the empty string. `check` names what is wrong with a typed
 * value, which is then not saved.
 */
export type FactEditor =
  | { kind: 'choice'; value: string; choices: readonly FactChoice[]; other?: string }
  | { kind: 'toggle'; values: readonly string[]; choices: readonly FactChoice[]; other?: string }
  | {
      kind: 'date';
      value: string;
      presets: readonly FactChoice[];
      clear?: string;
      /** The date field's name; the fact's name and "date" when left out. */
      field?: string;
    }
  | {
      kind: 'text';
      value: string;
      /** The typed field's name, and its placeholder. */
      field: string;
      inputType?: 'text' | 'number' | 'url';
      presets?: readonly FactChoice[];
      clear?: string;
      check?: (text: string) => string | null;
    };

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
  const [picking, setPicking] = useState(false);
  // Toggles still saving, by value: a second press waits for the first, whose result the values show only after it.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const saving = picking || pending.size > 0;
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
    if (editor?.kind === 'toggle') {
      if (pending.has(next)) return;
      setPending((was) => new Set(was).add(next));
      try {
        await onSave(next, on);
      } finally {
        setPending((was) => {
          const now = new Set(was);
          now.delete(next);
          return now;
        });
      }
      return;
    }
    if (saving) return;
    setOpen(false);
    setPicking(true);
    try {
      await onSave(next, on);
    } finally {
      setPicking(false);
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
  return (
    <MenuContent label={label} align={align} footer={factMenuFooter(label, editor, onSave)}>
      {factMenuItems(editor, onSave)}
    </MenuContent>
  );
}

/** The values a fact's menu offers, for a menu that shows a fact's editor in place of its own list. */
export function factMenuItems(editor: FactEditor, onSave: (next: string, on?: boolean) => void): ReactNode[] {
  const presets = editor.kind === 'date' || editor.kind === 'text' ? (editor.presets ?? []) : [];
  if (editor.kind === 'choice')
    return editor.choices.map((choice) => (
      <MenuItem
        key={choice.value || 'none'}
        icon={choice.mark}
        checked={choice.value === editor.value}
        onSelect={() => onSave(choice.value)}
      >
        {choice.label}
      </MenuItem>
    ));
  if (editor.kind === 'toggle')
    return editor.choices.map((choice) => {
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
    });
  return [
    ...presets.map((preset) => (
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
          ...(presets.length > 0 ? [<MenuSeparator key="separator" />] : []),
          <MenuItem key="clear" onSelect={() => onSave('')}>
            {editor.clear}
          </MenuItem>,
        ]
      : []),
  ];
}

/** The field for a typed value at the foot of a fact's menu, or null when its editor takes none. */
export function factMenuFooter(
  label: string,
  editor: FactEditor,
  onSave: (next: string, on?: boolean) => void,
): ReactNode {
  const presets = editor.kind === 'date' || editor.kind === 'text' ? (editor.presets ?? []) : [];
  if (editor.kind === 'date')
    return <TypedValue label={editor.field ?? `${label} date`} type="date" initial={editor.value} onSave={onSave} />;
  if (editor.kind === 'text')
    return (
      <TypedValue
        label={editor.field}
        type={editor.inputType ?? 'text'}
        initial={editor.value}
        {...(editor.check ? { check: editor.check } : {})}
        autoFocus={presets.length === 0 && editor.value === ''}
        onSave={onSave}
      />
    );
  if (editor.other)
    return (
      <TypedValue
        label={editor.other}
        onSave={(next) => (editor.kind === 'toggle' ? onSave(next, true) : onSave(next))}
      />
    );
  return null;
}

/** A value typed instead of picked: Enter saves it, unless `check` names what is wrong with it, which shows under it. */
function TypedValue({
  label,
  type = 'text',
  initial = '',
  check,
  autoFocus = false,
  onSave,
}: {
  label: string;
  type?: 'text' | 'number' | 'url' | 'date';
  initial?: string;
  check?: (text: string) => string | null;
  autoFocus?: boolean;
  onSave: (next: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  return (
    <form
      className="flex flex-col gap-1"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const words = value.trim();
        if (words === '') return;
        const wrong = check?.(words) ?? null;
        setError(wrong);
        if (wrong === null) onSave(words);
      }}
    >
      <div className="flex items-center gap-1">
        <Input
          // A number field would hand back nothing for words it cannot read, so `check` could not name the problem.
          type={type === 'number' ? 'text' : type}
          inputMode={type === 'number' ? 'decimal' : undefined}
          aria-label={label}
          placeholder={type === 'date' ? undefined : label}
          spellCheck={false}
          autoFocus={autoFocus}
          value={value}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={error === null ? undefined : errorId}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
        />
        <IconButton
          type="submit"
          size="sm"
          label={`Save ${label.toLowerCase()}`}
          icon={<CornerDownLeft aria-hidden />}
        />
      </div>
      {error === null ? null : (
        <FieldError id={errorId} className="px-1 pb-0.5">
          {error}
        </FieldError>
      )}
    </form>
  );
}
