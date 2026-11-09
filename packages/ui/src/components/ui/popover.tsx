import * as PopoverPrimitive from '@radix-ui/react-popover';
import { createContext, useContext, useState, type ComponentProps } from 'react';
import { cn } from '../../lib/utils';

/**
 * An anchored panel on Radix: Radix owns focus, Escape and outside-press
 * closing, and placement. It is the popover elevation: Background, 8 px
 * corners and `shadow-pop`, whose first ring is its edge. Menus (menu.tsx)
 * are built on it.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

/** Where popovers render: the nearest `ThemeScope`, or the document's body when there is none. */
const PortalContainer = createContext<HTMLElement | null>(null);

/**
 * The element a layer drawn over the page (a popover, the composer) renders
 * into: the nearest `ThemeScope`, so it keeps that scope's theme and the
 * app's tokens, which apply only inside the app's root.
 */
export function usePortalContainer(): HTMLElement {
  return useContext(PortalContainer) ?? document.body;
}

export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal container={usePortalContainer()}>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          'z-50 max-h-(--radix-popover-content-available-height) w-72 overflow-auto rounded-lg bg-background p-3 text-ink shadow-pop outline-none motion-safe:animate-pop-in',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

/**
 * A part of the page drawn in a theme of its own, whatever the system
 * prefers: `light` or `dark`, or `system` to follow the page. Popovers opened
 * inside it render inside it too, so they take its theme; one rendered on the
 * document's body would take the page's.
 */
export function ThemeScope({
  theme,
  className,
  children,
  ...props
}: ComponentProps<'div'> & { theme: 'system' | 'light' | 'dark' }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setElement} className={cn(theme !== 'system' && theme, className)} {...props}>
      <PortalContainer.Provider value={element}>{children}</PortalContainer.Provider>
    </div>
  );
}
