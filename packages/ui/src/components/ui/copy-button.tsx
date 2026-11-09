import { Check, Copy } from 'lucide-react';
import { useEffect, useState, type RefObject } from 'react';
import { toast } from 'sonner';
import { cn } from '../../lib/utils';
import { buttonVariants } from './button';

/** How long the button shows Copied after a copy. */
const COPIED_MS = 2000;

/**
 * Selects `element`'s text, leaving out a line break that ends it, as every
 * code block's does: pasted into a terminal, that line break would run the
 * command. The selection then holds what a copy would have put on the
 * clipboard.
 */
function select(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  const texts = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let node = texts.nextNode(); node; node = texts.nextNode()) last = node as Text;
  if (last?.data.endsWith('\n')) range.setEnd(last, last.data.length - 1);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * A small button that copies `text()`. `label`, such as "Copy the code", is
 * its name for a screen reader and its tooltip, and stays its name. After a
 * copy the button shows Copied for two seconds, and a status region beside
 * it says Copied, which a screen reader reads. Where the browser cannot copy,
 * as on a page served without HTTPS or after a refused write, it selects the
 * text of `target`, so the keyboard's copy key takes it, and says so.
 */
export function CopyButton({
  label,
  text,
  target,
  className,
}: {
  label: string;
  text: () => string;
  target: RefObject<HTMLElement | null>;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error('No clipboard');
      await navigator.clipboard.writeText(text());
    } catch {
      if (target.current) select(target.current);
      toast.error('Could not copy. The text is selected: copy it with your keyboard.');
      return;
    }
    setCopied(true);
  }

  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => void copy()}
        data-copied={copied ? '' : undefined}
        className={cn(buttonVariants({ variant: 'ghost', size: 'sm', icon: !copied }), className)}
      >
        {copied ? (
          <>
            <Check aria-hidden />
            Copied
          </>
        ) : (
          <Copy aria-hidden />
        )}
      </button>
      <span role="status" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
    </>
  );
}
