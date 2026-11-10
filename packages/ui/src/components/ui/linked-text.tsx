import type { ReactNode } from 'react';
import { webAddresses } from '../../lib/web-links';

/** A link in task text, in Accent text, underlined while pointed at. */
export const LINK_CLASS =
  'text-accent-text no-underline underline-offset-3 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-accent';

/**
 * Plain text, such as a task's title, with each http or https address in it
 * as a link that opens in a new tab with no opener and no referrer; every
 * other character as it was.
 */
export function LinkedText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const address of webAddresses(text)) {
    if (address.start > last) parts.push(text.slice(last, address.start));
    parts.push(
      <a
        key={address.start}
        href={address.href}
        target="_blank"
        rel="noopener noreferrer"
        className={LINK_CLASS}
        data-web-link=""
      >
        {text.slice(address.start, address.end)}
      </a>,
    );
    last = address.end;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
