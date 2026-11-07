import { Slot, Slottable } from '@radix-ui/react-slot';
import { PanelLeft } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { cn } from '@/lib/utils';
import { IconButton } from './button';
import { NtasksLogo } from './symbols';

interface SidebarState {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Closes the sheet and puts focus back on the button that opened it. */
  dismiss: () => void;
  sidebarId: string;
  opener: RefObject<HTMLButtonElement | null>;
}

const SidebarContext = createContext<SidebarState | null>(null);

/**
 * The app's frame: a 236 px sidebar on Canvas and the page on Background,
 * divided by Border. On a phone the sidebar is hidden and the page takes the
 * width; the Sidebar button at the start of the page's `TopBar` opens it as
 * a sheet over the page. The sheet closes on Escape, on a press outside it,
 * on a link inside it, and when the browser goes back or forward.
 */
export function AppShell({
  sidebar,
  children,
  className,
}: {
  sidebar: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const sidebarId = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const dismiss = useCallback(() => {
    setOpen(false);
    opener.current?.focus();
  }, []);
  const state = useMemo(() => ({ open, setOpen, dismiss, sidebarId, opener }), [open, dismiss, sidebarId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      dismiss();
    };
    const onHistory = () => setOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('popstate', onHistory);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onHistory);
    };
  }, [open, dismiss]);

  return (
    <SidebarContext.Provider value={state}>
      <div className={cn('grid min-h-screen grid-cols-[236px_minmax(0,1fr)] bg-canvas max-sm:grid-cols-1', className)}>
        {sidebar}
        {open ? (
          <div
            aria-hidden
            className="fixed inset-0 z-40 bg-black/30 sm:hidden"
            onClick={dismiss}
            data-sidebar-backdrop=""
          />
        ) : null}
        <main className="min-w-0 border-l border-border bg-background max-sm:border-l-0">{children}</main>
      </div>
    </SidebarContext.Provider>
  );
}

/** The app's navigation. Inside an `AppShell` on a phone, it shows as a sheet while the top bar's Sidebar button has it open. */
export function Sidebar({ className, children, onClick, ...props }: ComponentProps<'nav'>) {
  const shell = useContext(SidebarContext);
  const open = shell?.open ?? false;
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    if (open) nav.current?.querySelector<HTMLElement>('a[href], button:not([disabled])')?.focus();
  }, [open]);
  return (
    <nav
      ref={nav}
      id={shell?.sidebarId}
      data-open={open ? '' : undefined}
      className={cn(
        'sticky top-0 flex h-screen flex-col gap-0.5 px-2.5 pt-2.5 pb-4',
        open
          ? 'max-sm:fixed max-sm:inset-y-0 max-sm:left-0 max-sm:z-50 max-sm:h-auto max-sm:w-[min(280px,85vw)] max-sm:overflow-y-auto max-sm:bg-canvas max-sm:shadow-pop'
          : 'max-sm:hidden',
        className,
      )}
      onClick={(event: MouseEvent<HTMLElement>) => {
        onClick?.(event);
        // Following a link is leaving the sheet.
        if (open && event.target instanceof Element && event.target.closest('a[href]')) shell?.setOpen(false);
      }}
      {...props}
    >
      {children}
    </nav>
  );
}

/** The button that opens the sidebar on a phone; `TopBar` puts it first. Hidden on wider screens, where the sidebar always shows. */
function SidebarOpener() {
  const shell = useContext(SidebarContext);
  if (!shell) return null;
  return (
    <IconButton
      ref={shell.opener}
      label="Sidebar"
      icon={<PanelLeft aria-hidden />}
      aria-expanded={shell.open}
      aria-controls={shell.sidebarId}
      className="-ms-1.5 sm:hidden"
      onClick={() => shell.setOpen(!shell.open)}
    />
  );
}

/** The sidebar's first line: the logo, the workspace's name, and its search and new-task buttons. */
export function SidebarHeader({ name, children }: { name: string; children?: ReactNode }) {
  return (
    <div className="mb-2 flex h-9 items-center gap-2 ps-2 pe-1.5">
      <NtasksLogo size={20} />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{name}</span>
      {children}
    </div>
  );
}

/** A heading over a part of the sidebar: Projects, People. */
export function NavSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5" aria-label={title}>
      <h2 aria-hidden className="mx-2 mt-4.5 mb-1 text-xs font-medium text-ink-3">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * One place in the sidebar: a 16 px icon or symbol, its name and its count.
 * The current one is on Hover in Text. Pass a router link as the child with
 * `asChild`, so the item is the link.
 */
export function NavItem({
  icon,
  count,
  active = false,
  asChild = false,
  className,
  children,
  ...props
}: ComponentProps<'a'> & {
  icon: ReactNode;
  /** The count at the end: a number, or a `Count` for the amber waiting count. */
  count?: ReactNode;
  active?: boolean;
  asChild?: boolean;
}) {
  const Comp = asChild ? Slot : 'a';
  return (
    <Comp
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-7.5 items-center gap-2.25 rounded-md px-2 text-nav font-medium text-ink-2 no-underline',
        'transition-colors duration-120 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent',
        'aria-[current=page]:bg-hover aria-[current=page]:text-ink',
        '[&_svg]:shrink-0 [&>svg]:size-4 [&>svg]:text-ink-3 aria-[current=page]:[&>svg]:text-ink-2',
        className,
      )}
      {...props}
    >
      {icon}
      {/* With asChild the child is the link, and its text is the label. */}
      {asChild ? <Slottable>{children}</Slottable> : <span className="min-w-0 truncate">{children}</span>}
      {count === undefined || count === null ? null : typeof count === 'number' ? (
        <span className="nums ms-auto text-xs font-medium text-ink-3">{count}</span>
      ) : (
        <span className="ms-auto">{count}</span>
      )}
    </Comp>
  );
}

/** The first letter of a project's prefix (`web` is W) in a 16 px ringed square: the project's mark in the sidebar and in a page's path. */
export function ProjectBadge({ prefix, className }: { prefix: string; className?: string }) {
  const letter = (prefix.trim()[0] ?? '?').toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-sm bg-background text-[10px] leading-4 font-semibold text-ink-2 inset-ring inset-ring-border-strong',
        className,
      )}
    >
      {letter}
    </span>
  );
}

/** Pushes what follows to the sidebar's foot, such as Settings. */
export function SidebarSpacer() {
  return <div aria-hidden className="flex-1" />;
}

/**
 * A page's top bar, 56 px: its title (or a path of links), then its views,
 * then its search and actions at the end. Inside an `AppShell` on a phone it
 * starts with the button that opens the sidebar.
 */
export function TopBar({ title, children, className }: { title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <header
      className={cn(
        'flex h-14 items-center gap-2.5 border-b border-border ps-6 pe-5 max-sm:h-13 max-sm:ps-4 max-sm:pe-3',
        className,
      )}
    >
      <SidebarOpener />
      {typeof title === 'string' ? (
        <h1 className="m-0 me-2 text-page-title text-ink max-sm:text-lg">{title}</h1>
      ) : (
        title
      )}
      {children}
    </header>
  );
}

/** Takes the free width in a top bar, so what follows sits at its end. */
export function BarSpacer() {
  return <span aria-hidden className="flex-1" />;
}
