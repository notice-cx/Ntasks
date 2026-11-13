import { Slot, Slottable } from '@radix-ui/react-slot';
import { ChevronsUpDown, PanelLeft } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useMedia } from '../../hooks/useMedia';
import { useShortcut } from '../../hooks/useShortcut';
import { cn } from '../../lib/utils';
import { IconButton } from './button';

/**
 * Where the sidebar sits: `beside` the page, as a sheet only on a phone, or a
 * `sheet` at every width, for a host page that draws its own navigation
 * beside the app.
 */
export type SidebarPlace = 'beside' | 'sheet';

interface SidebarState {
  place: SidebarPlace;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Whether the person hid the sidebar from beside the page; a phone and a `sheet` ignore it. */
  collapsed: boolean;
  /** Whether the screen is wide enough for the sidebar beside the page. */
  wide: boolean;
  /** What the Sidebar button and `[` do: hide or show the sidebar beside the page, else open or close the sheet. */
  toggle: () => void;
  /** Closes the sheet and puts focus back on the button that opened it. */
  dismiss: () => void;
  sidebarId: string;
  opener: RefObject<HTMLButtonElement | null>;
  closer: RefObject<HTMLButtonElement | null>;
}

/** Tailwind's `sm`: from this width the sidebar sits beside the page, and the `max-sm:` classes stop. */
const WIDE = '(width >= 40rem)';

const COLLAPSED_KEY = 'ntasks.sidebar';

/**
 * Whether this browser keeps the sidebar hidden from beside the page. Storage
 * can be missing or refuse (a private window, a blocked site), and then the
 * sidebar shows.
 */
function storedCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === 'hidden';
  } catch {
    return false;
  }
}

function storeCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(COLLAPSED_KEY, 'hidden');
    else window.localStorage.removeItem(COLLAPSED_KEY);
  } catch {
    // Kept for this page only; the next load shows the sidebar.
  }
}

const SidebarContext = createContext<SidebarState | null>(null);

/**
 * The app's frame: a 236 px sidebar on Canvas and the page on Background,
 * divided by Border. On a phone, and at every width when `place` is `sheet`,
 * the sidebar is hidden and the page takes the width; the Sidebar button at
 * the start of the page's `TopBar` opens it as a sheet over the page. The
 * sheet closes on Escape, on a press outside it, on a link inside it, when
 * the browser goes back or forward, and as the screen widens. Beside the page, the Sidebar button
 * in `SidebarHeader` hides the sidebar and the page takes the width, until the
 * top bar's Sidebar button shows it again; the browser keeps the choice. `[`
 * does what the Sidebar button does.
 */
export function AppShell({
  sidebar,
  place = 'beside',
  children,
  className,
}: {
  sidebar: ReactNode;
  place?: SidebarPlace;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(storedCollapsed);
  const wide = useMedia(WIDE);
  const sidebarId = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const closer = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const dismiss = useCallback(() => {
    setOpen(false);
    opener.current?.focus();
  }, []);
  const toggle = useCallback(() => {
    if (place === 'sheet' || !wide) {
      if (open) dismiss();
      else setOpen(true);
      return;
    }
    const focused = document.activeElement;
    // Focus on a control that is about to hide moves to the Sidebar button that shows.
    refocus.current =
      focused !== null && (focused === opener.current || !!document.getElementById(sidebarId)?.contains(focused));
    setCollapsed(!collapsed);
    storeCollapsed(!collapsed);
  }, [place, wide, open, dismiss, collapsed, sidebarId]);
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    (collapsed ? opener : closer).current?.focus();
  }, [collapsed]);
  // A sheet still open as the screen widens closes: the sidebar now sits beside the page, or stays
  // hidden there, and then focus inside it moves to the top bar's Sidebar button. Only a change of
  // width runs this; a toggle moves focus itself.
  useLayoutEffect(() => {
    if (!wide || place === 'sheet') return;
    setOpen(false);
    const focused = document.activeElement;
    if (collapsed && focused !== null && document.getElementById(sidebarId)?.contains(focused)) opener.current?.focus();
  }, [wide]);
  useShortcut('[', toggle);
  const state = useMemo(
    () => ({ place, open, setOpen, collapsed, wide, toggle, dismiss, sidebarId, opener, closer }),
    [place, open, collapsed, wide, toggle, dismiss, sidebarId],
  );
  const hidden = place === 'beside' && collapsed;

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
      <div
        className={cn(
          place === 'sheet'
            ? 'min-h-full bg-background'
            : [
                'grid min-h-screen bg-canvas',
                hidden ? 'grid-cols-1' : 'grid-cols-[236px_minmax(0,1fr)] max-sm:grid-cols-1',
              ],
          className,
        )}
      >
        {sidebar}
        {open ? (
          <div
            aria-hidden
            className={cn('fixed inset-0 z-40 bg-black/30', place === 'beside' && 'sm:hidden')}
            onClick={dismiss}
            data-sidebar-backdrop=""
          />
        ) : null}
        {place === 'sheet' ? (
          // A host page that draws its own navigation holds the one main landmark.
          <div className="min-w-0 bg-background">{children}</div>
        ) : (
          <main
            className={cn('min-w-0 border-l border-border bg-background max-sm:border-l-0', hidden && 'border-l-0')}
          >
            {children}
          </main>
        )}
      </div>
    </SidebarContext.Provider>
  );
}

/**
 * The app's navigation. Inside an `AppShell` on a phone, it shows as a sheet
 * while the top bar's Sidebar button has it open; on a wider screen it is
 * hidden while the person keeps it hidden.
 */
export function Sidebar({ className, children, onClick, ...props }: ComponentProps<'nav'>) {
  const shell = useContext(SidebarContext);
  const open = shell?.open ?? false;
  const sheet = shell?.place === 'sheet';
  const collapsed = !sheet && (shell?.collapsed ?? false);
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    if (open) nav.current?.querySelector<HTMLElement>('a[href], button:not([disabled])')?.focus();
  }, [open]);
  return (
    <nav
      ref={nav}
      id={shell?.sidebarId}
      data-open={open ? '' : undefined}
      data-collapsed={collapsed ? '' : undefined}
      className={cn(
        'flex flex-col gap-0.5 px-2.5 pt-2.5 pb-4',
        sheet
          ? open
            ? 'fixed inset-y-0 left-0 z-50 w-[min(280px,85vw)] overflow-y-auto bg-canvas shadow-pop'
            : 'hidden'
          : [
              'sticky top-0 h-screen',
              collapsed && 'sm:hidden',
              open
                ? 'max-sm:fixed max-sm:inset-y-0 max-sm:left-0 max-sm:z-50 max-sm:h-auto max-sm:w-[min(280px,85vw)] max-sm:overflow-y-auto max-sm:bg-canvas max-sm:shadow-pop'
                : 'max-sm:hidden',
            ],
        className,
      )}
      onClick={(event: MouseEvent<HTMLElement>) => {
        onClick?.(event);
        // Following a link is leaving the sheet.
        if (open && event.target instanceof Element && event.target.closest('a[href]')) shell?.dismiss();
      }}
      {...props}
    >
      {children}
    </nav>
  );
}

/**
 * The top bar's Sidebar button, which `TopBar` puts first. It opens the
 * sidebar as a sheet; beside the page it shows only while the sidebar is
 * hidden, and shows it again.
 */
function SidebarOpener() {
  const shell = useContext(SidebarContext);
  if (!shell) return null;
  const beside = shell.place === 'beside';
  return (
    <IconButton
      ref={shell.opener}
      label="Sidebar"
      shortcut="["
      icon={<PanelLeft aria-hidden />}
      aria-expanded={beside && shell.wide ? !shell.collapsed : shell.open}
      aria-controls={shell.sidebarId}
      className={cn('-ms-1.5', beside && !shell.collapsed && 'sm:hidden')}
      onClick={shell.toggle}
    />
  );
}

/**
 * The sidebar header's Sidebar button, which hides the sidebar from beside the
 * page. A phone's sheet and a `sheet` sidebar leave it out, so opening the
 * sheet puts focus on its first item rather than on a button it hides.
 */
function SidebarCloser() {
  const shell = useContext(SidebarContext);
  if (shell?.place !== 'beside' || !shell.wide) return null;
  return (
    <IconButton
      ref={shell.closer}
      size="sm"
      label="Sidebar"
      shortcut="["
      icon={<PanelLeft aria-hidden />}
      aria-expanded={!shell.collapsed}
      aria-controls={shell.sidebarId}
      className="-ms-1.5"
      onClick={shell.toggle}
    />
  );
}

/**
 * The sidebar's first line: inside an `AppShell`, the Sidebar button that
 * hides it, then the workspace's icon and name, and the search button. For a
 * person in several workspaces the name is a `WorkspaceButton` that opens the
 * menu of the others.
 */
export function SidebarHeader({ icon, name, children }: { icon: ReactNode; name: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-2 flex h-9 items-center gap-2 ps-2 pe-1.5">
      <SidebarCloser />
      {icon}
      {typeof name === 'string' ? (
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{name}</span>
      ) : (
        name
      )}
      {children}
    </div>
  );
}

/** The workspace's name as a button, ending in a chevron pair that marks a choice. It takes the header's free width. */
export function WorkspaceButton({ className, children, ...props }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      className={cn(
        '-ms-1 flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-start text-sm font-semibold text-ink',
        'transition-colors duration-120 hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent',
        'aria-expanded:bg-hover',
        className,
      )}
      {...props}
    >
      <span className="min-w-0 truncate">{children}</span>
      <ChevronsUpDown aria-hidden size={14} strokeWidth={1.75} className="shrink-0 text-ink-3" />
    </button>
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

/**
 * A project's mark in the sidebar, in a page's path and in Settings, 16 px
 * square unless `size` says otherwise: the icon read from its website when
 * `src` gives one, else the first letter of its prefix (`web` is W) in a
 * ringed square. The project's name always stands beside it, so screen
 * readers skip it.
 */
export function ProjectBadge({
  prefix,
  src = null,
  size = 16,
  className,
}: {
  prefix: string;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const letter = (prefix.trim()[0] ?? '?').toUpperCase();
  if (src !== null && broken !== src)
    return (
      <img
        alt=""
        aria-hidden
        src={src}
        width={size}
        height={size}
        data-project-icon=""
        className={cn('shrink-0 rounded-sm object-contain', className)}
        style={{ width: size, height: size }}
        onError={() => setBroken(src)}
      />
    );
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-sm bg-background leading-none font-semibold text-ink-2 inset-ring inset-ring-border-strong',
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.625) }}
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
 * then its search and actions at the end. Inside an `AppShell` on a phone,
 * and while the sidebar is hidden, it starts with the Sidebar button.
 */
export function TopBar({
  title,
  children,
  className,
  compact = false,
}: {
  title: ReactNode;
  children?: ReactNode;
  className?: string;
  /** A toolbar below a page heading that already has a Sidebar button. */
  compact?: boolean;
}) {
  return (
    <header
      className={cn(
        'flex h-14 items-center gap-2.5 border-b border-border ps-6 pe-5 max-sm:h-13 max-sm:gap-2 max-sm:ps-4 max-sm:pe-3',
        compact && 'h-12 max-sm:h-11',
        className,
      )}
    >
      {compact ? null : <SidebarOpener />}
      {typeof title === 'string' ? (
        <h1 className="m-0 me-2 text-page-title text-ink max-sm:text-heading">{title}</h1>
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
