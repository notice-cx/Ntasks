import { ChevronRight } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';
import { Kbd } from './kbd';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { roveFocus } from './rove';

/**
 * A menu of actions, on a Popover. Each item has a 15 px icon, a label and
 * its key. While the menu is open, ↑ and ↓ move between items, Enter runs
 * the focused one, and an item's letter runs it directly; Escape closes it.
 */
const MenuContext = createContext<{ close: () => void } | null>(null);

const ITEM = '[role="menuitem"]:not([disabled])';

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
  return (
    <MenuContext.Provider value={{ close }}>
      <Popover open={open} onOpenChange={setOpen}>
        {children}
      </Popover>
    </MenuContext.Provider>
  );
}

export const MenuTrigger = PopoverTrigger;

export function MenuContent({
  children,
  label,
  align = 'start',
  className,
}: {
  children: ReactNode;
  /** The menu's name for a screen reader, such as the task it acts on. */
  label: string;
  align?: 'start' | 'center' | 'end';
  className?: string;
}) {
  return (
    <PopoverContent
      align={align}
      className={cn('w-58 p-0', className)}
      // The panel puts focus on its first item instead of on itself.
      onOpenAutoFocus={(event) => event.preventDefault()}
    >
      <MenuPanel label={label} autoFocus>
        {children}
      </MenuPanel>
    </PopoverContent>
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
    if (autoFocus) panel.current?.querySelector<HTMLElement>(ITEM)?.focus();
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
  disabled?: boolean;
  onSelect?: () => void;
  className?: string;
}) {
  const menu = useContext(MenuContext);
  const letter = shortcut && /^[\p{L}\p{N}]$/u.test(shortcut) ? shortcut.toLowerCase() : undefined;
  return (
    <button
      type="button"
      role="menuitem"
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
      ) : null}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="-mx-1 my-1 h-px bg-border" />;
}
