import { Check, Copy } from 'lucide-react';
import { useEffect, useState, type RefObject } from 'react';
import { toast } from 'sonner';
import { cn } from '../../lib/utils';
import { buttonVariants } from './button';

/** How long the button shows Copied after a copy. */
const COPIED_MS = 2000;

/**
 * A small button that copies `text()`. `label`, such as "Copy the code", is
 * its name for a screen reader and its tooltip. After a copy it shows Copied
 * for two seconds, and a screen reader reads that change. Where the browser
 * cannot copy, as on a page served without HTTPS or after a refused write,
 * it selects the text of `target`, so the keyboard's copy key takes it, and
 * says so.
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
      if (target.current) getSelection()?.selectAllChildren(target.current);
      toast.error('Could not copy. The text is selected: copy it with your keyboard.');
      return;
    }
    setCopied(true);
  }

  return (
    <button
      type="button"
      title={label}
      aria-live="polite"
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
        <>
          <Copy aria-hidden />
          <span className="sr-only">{label}</span>
        </>
      )}
    </button>
  );
}
