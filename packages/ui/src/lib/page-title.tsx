/**
 * The browser tab's title for each page, most specific part first, so tabs,
 * history and bookmarks tell pages apart: `web-b2r6 · Fix the reset link —
 * Ntasks`, `Waiting for you (3) · Example web app — Ntasks`. Every page sets
 * its own with `usePageTitle`. A host that renders the app inside its own
 * page receives the titles through `TitleProvider` and keeps its tab title.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

export const TITLE_SUFFIX = ' — Ntasks';
/** About the length a tab or a history entry shows before the suffix. */
export const TITLE_LENGTH = 60;
const SEPARATOR = ' · ';

/**
 * `lead`, then the other parts that have words, joined by a middle dot, cut
 * with an ellipsis to TITLE_LENGTH, then the suffix. `lead`, such as a task's
 * id, is never cut.
 */
export function pageTitle(lead: string, ...rest: readonly (string | null | undefined | false)[]): string {
  const tail = rest.filter((part): part is string => typeof part === 'string' && part.trim() !== '').join(SEPARATOR);
  let body = tail === '' ? lead : `${lead}${SEPARATOR}${tail}`;
  if (body.length > TITLE_LENGTH) {
    // The room left for the rest after the lead, its separator and the ellipsis.
    const room = TITLE_LENGTH - lead.length - SEPARATOR.length - 1;
    const kept = room > 0 ? tail.slice(0, room).trimEnd() : '';
    body = kept === '' ? lead : `${lead}${SEPARATOR}${kept}…`;
  }
  return `${body}${TITLE_SUFFIX}`;
}

const setDocumentTitle = (title: string) => {
  document.title = title;
};

const TitleSetter = createContext<(title: string) => void>(setDocumentTitle);

/**
 * Where the pages' titles go: to `onTitle` when the host passes one, in place
 * of the document's title, and otherwise to the document's title.
 */
export function TitleProvider({ onTitle, children }: { onTitle?: (title: string) => void; children: ReactNode }) {
  // A host may pass a new function on every render; the pages keep one setter.
  const latest = useRef(onTitle);
  useLayoutEffect(() => {
    latest.current = onTitle;
  });
  const set = useRef((title: string) => (latest.current ?? setDocumentTitle)(title)).current;
  return <TitleSetter.Provider value={set}>{children}</TitleSetter.Provider>;
}

/** Sets the page's title, as `pageTitle` writes it, while the page shows. */
export function usePageTitle(lead: string, ...rest: readonly (string | null | undefined | false)[]): void {
  const set = useContext(TitleSetter);
  const title = pageTitle(lead, ...rest);
  useEffect(() => set(title), [set, title]);
}
