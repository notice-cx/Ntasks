/**
 * Web addresses written out in plain text, such as a task's title, a code
 * block or a step's command, found so the page can link them. Only http and
 * https count: a `javascript:` or any other scheme stays text.
 */

/** Where an address starts and ends in the text, and the address itself. */
export interface WebAddress {
  start: number;
  end: number;
  href: string;
}

// An address runs to the first space, quote, angle bracket or backtick.
const ADDRESS = /\bhttps?:\/\/[^\s<>"'`]+/gi;
// Punctuation that ends a sentence after an address is the sentence's, not the address's.
const TRAILING = /[.,;:!?*_~]+$/;
const OPENERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

const count = (text: string, char: string) => text.split(char).length - 1;

/** The address as written, less what follows it in the sentence: trailing punctuation, and a closing bracket it never opened. */
function trimmed(address: string): string {
  let rest = address;
  for (;;) {
    const bare = rest.replace(TRAILING, '');
    const last = bare.at(-1) ?? '';
    const opener = OPENERS[last];
    if (opener !== undefined && count(bare, last) > count(bare, opener)) {
      rest = bare.slice(0, -1);
      continue;
    }
    return bare;
  }
}

/** Every http or https address in `text`, in order. */
export function webAddresses(text: string): WebAddress[] {
  const found: WebAddress[] = [];
  for (const match of text.matchAll(ADDRESS)) {
    const href = trimmed(match[0]);
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') continue;
    found.push({ start: match.index, end: match.index + href.length, href });
  }
  return found;
}
