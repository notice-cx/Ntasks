import { useEffect, useId, useRef, useState, type PointerEvent, type ReactElement, type ReactNode } from 'react';
import { Popover, PopoverAnchor, PopoverContent } from './popover';

/** How long a mouse rests on the control before the tooltip shows, so passing over a list shows none. */
export const TOOLTIP_REST_MS = 300;

/** A pen or a finger has no hover: a press shows the tooltip instead. */
function isMouse(event: PointerEvent): boolean {
  return event.pointerType !== 'touch' && event.pointerType !== 'pen';
}

/**
 * A short line about a control, above it. It shows while a mouse rests on
 * the control, while the control holds focus, and after a press, so a mouse,
 * a keyboard and a touch screen all reach it. It hides when the mouse leaves,
 * focus moves on, Escape is pressed or a press lands elsewhere. The control
 * keeps its own accessible name, and the tooltip describes it while it
 * shows. Radix's popover places it, inside the nearest `ThemeScope`, and it
 * never takes focus. The child must be one focusable element, such as a
 * button.
 */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactElement }) {
  const [open, setOpen] = useState(false);
  const rest = useRef<number | undefined>(undefined);
  const anchor = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => () => window.clearTimeout(rest.current), []);

  function hide() {
    window.clearTimeout(rest.current);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : hide())}>
      <PopoverAnchor
        asChild
        ref={anchor}
        aria-describedby={open ? id : undefined}
        onPointerEnter={(event) => {
          if (!isMouse(event)) return;
          window.clearTimeout(rest.current);
          rest.current = window.setTimeout(() => setOpen(true), TOOLTIP_REST_MS);
        }}
        onPointerLeave={(event) => {
          if (isMouse(event)) hide();
        }}
        onFocus={() => setOpen(true)}
        onBlur={hide}
        onClick={() => setOpen(true)}
      >
        {children}
      </PopoverAnchor>
      <PopoverContent
        id={id}
        role="tooltip"
        side="top"
        align="center"
        sideOffset={6}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        // A press on the control itself shows the tooltip; it must not count as a press elsewhere.
        onPointerDownOutside={(event) => {
          if (event.target instanceof Node && anchor.current?.contains(event.target)) event.preventDefault();
        }}
        className="w-auto rounded-md px-2 py-1.5 text-meta font-medium whitespace-nowrap"
      >
        {content}
      </PopoverContent>
    </Popover>
  );
}
