import { Slot } from '@radix-ui/react-slot';
import { Check, ChevronRight } from 'lucide-react';
import {
  Children,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { cn } from '../../lib/utils';
import { Kbd } from './kbd';
import { Popover, PopoverAnchor, PopoverContent } from './popover';
import { roveFocus } from './rove';

/** What a menu's parts share. */
interface MenuState {
  open: boolean;
  setOpen: (open: boolean) => void;
  close: () => void;
  trigger: RefObject<HTMLButtonElement | null>;
  /** What the panel is placed against in place of the trigger, set by `MenuAnchor`. */
  anchor: RefObject<HTMLElement | null>;
  contentId: string;
}

const MenuContext = createContext<MenuState | null>(null);

function useMenu(part: string): MenuState {
  const menu = useContext(MenuContext);
  if (!menu) throw new Error(`${part} needs a Menu around it.`);
  return menu;
}

const ITEM = '[role^="menuitem"]:not([disabled])';

/**
 * A menu of actions, on a Popover. Each item has a 15 px icon, a label and
 * its key. While the menu is open, ↑ and ↓ move between items, Enter runs
 * the focused one, and an item's letter runs it directly; Escape closes it,
 * and focus goes back to its trigger. A menu that picks a value marks the
 * value held with a tick (`checked`) and opens on it.
 */
export function Menu({
  children,
  open: openProp,
  onOpenChange,
}: {
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const close = useCallback(() => setOpen(false), [setOpen]);
  const trigger = useRef<HTMLButtonElement>(null);
  const anchor = useRef<HTMLElement>(null);
  const contentId = useId();
  return (
    <MenuContext.Provider value={{ open, setOpen, close, trigger, anchor, contentId }}>{children}</MenuContext.Provider>
  );
}

/** The button that opens and closes the menu: a button, or with `asChild` its one child. */
export function MenuTrigger({
  asChild = false,
  onClick,
  ...props
}: Omit<ComponentProps<'button'>, 'ref'> & { asChild?: boolean }) {
  const menu = useMenu('MenuTrigger');
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      type="button"
      aria-haspopup="dialog"
      aria-expanded={menu.open}
      aria-controls={menu.open ? menu.contentId : undefined}
      data-state={menu.open ? 'open' : 'closed'}
      {...props}
      ref={menu.trigger}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) menu.setOpen(!menu.open);
      }}
    />
  );
}

/** The element the panel is placed against in place of the trigger, as its one child: a whole line with the trigger at its end. */
export function MenuAnchor({ children }: { children: ReactElement }) {
  const { anchor } = useMenu('MenuAnchor');
  return <Slot ref={anchor}>{children}</Slot>;
}

export function MenuContent({
  children,
  label,
  align = 'start',
  footer,
  panelKey,
  className,
}: {
  children: ReactNode;
  /** The menu's name for a screen reader, such as the task it acts on. */
  label: string;
  align?: 'start' | 'center' | 'end';
  /** Changed when the menu shows another list in place of this one, so focus moves to that list's first item. */
  panelKey?: string;
  /** What follows the items outside the menu itself, such as a field for a value the items do not hold.
   * A menu with no items is its footer alone. */
  footer?: ReactNode;
  className?: string;
}) {
  const menu = useMenu('MenuContent');
  // A press or a focus outside the menu leaves focus where it went; any other close puts it back on the trigger.
  const wentOutside = useRef(false);
  // A closed menu mounts no popover, so a list of rows, each with its own menu, keeps none of their parts.
  if (!menu.open) return null;
  const items = Children.toArray(children).length > 0;
  return (
    <Popover open onOpenChange={menu.setOpen}>
      <PopoverAnchor virtualRef={menu.anchor.current ? menu.anchor : menu.trigger} />
      <PopoverContent
        id={menu.contentId}
        align={align}
        className={cn('w-58 p-0', className)}
        // The panel puts focus on its first item instead of on itself.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          // A press on the trigger closes the menu through the trigger's own press.
          if (event.target instanceof Node && menu.trigger.current?.contains(event.target)) event.preventDefault();
          else wentOutside.current = true;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!wentOutside.current) menu.trigger.current?.focus();
          wentOutside.current = false;
        }}
      >
        {items ? (
          <MenuPanel key={panelKey} label={label} autoFocus>
            {children}
          </MenuPanel>
        ) : null}
        {footer ? <div className={cn('p-1', items && 'border-t border-border')}>{footer}</div> : null}
      </PopoverContent>
    </Popover>
  );
}

/** The list of items. `MenuContent` wraps it in a popover; on its own it draws a menu in place, as the gallery does. */
export function MenuPanel({
  children,
  label,
  autoFocus = false,
  className,
}: {
  children: ReactNode;
  label: string;
  autoFocus?: boolean;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const items = panel.current?.querySelectorAll<HTMLElement>(ITEM) ?? [];
    ([...items].find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
  }, [autoFocus]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (roveFocus(event, ITEM)) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.key.length !== 1) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEM)];
    const item = items.find((candidate) => candidate.dataset.shortcut === event.key.toLowerCase());
    if (!item) return;
    event.preventDefault();
    item.click();
  }

  return (
    <div
      ref={panel}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      className={cn('flex w-58 flex-col rounded-lg bg-background p-1 text-label text-ink', className)}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}

export function MenuItem({
  children,
  icon,
  shortcut,
  submenu = false,
  keepOpen = false,
  checked,
  disabled = false,
  onSelect,
  className,
}: {
  children: ReactNode;
  /** A 15 px icon or a symbol, in Text 3. */
  icon?: ReactNode;
  /** The key shown at the end. A single letter or digit also runs the item while the menu is open. */
  shortcut?: string;
  /** It opens a further list: a chevron takes the key's place, and the menu stays open. */
  submenu?: boolean;
  /** The menu stays open after it runs, as for an item that goes back to the previous list. */
  keepOpen?: boolean;
  /** One of a set of values: true on the value held, which ends in a tick. */
  checked?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  className?: string;
}) {
  const menu = useContext(MenuContext);
  const letter = shortcut && /^[\p{L}\p{N}]$/u.test(shortcut) ? shortcut.toLowerCase() : undefined;
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      tabIndex={-1}
      disabled={disabled}
      aria-haspopup={submenu ? 'menu' : undefined}
      aria-keyshortcuts={shortcut && !submenu ? shortcut : undefined}
      data-shortcut={letter}
      className={cn(
        'flex h-7.5 w-full shrink-0 items-center gap-2.25 rounded-sm px-2 text-start text-ink outline-none pointer-coarse:h-9',
        'hover:bg-hover focus:bg-hover disabled:opacity-45',
        '[&>svg]:size-[15px] [&>svg]:shrink-0 [&>svg]:text-ink-3',
        className,
      )}
      onClick={() => {
        onSelect?.();
        if (!submenu && !keepOpen) menu?.close();
      }}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {submenu ? (
        <ChevronRight aria-hidden size={14} strokeWidth={1.75} className="text-ink-3" />
      ) : shortcut ? (
        <Kbd aria-hidden>{shortcut.length === 1 ? shortcut.toUpperCase() : shortcut}</Kbd>
      ) : checked ? (
        <span aria-hidden className="inline-flex text-accent">
          <Check size={15} strokeWidth={2} />
        </span>
      ) : null}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="-mx-1 my-1 h-px bg-border" />;
}
