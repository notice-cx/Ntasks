/**
 * What a link or a key asks of the Tasks board through the location's state,
 * without changing its address: open the composer, or put the cursor in the
 * search field.
 */

/** Location state that opens the composer. */
export const COMPOSE_STATE = 'newTask';

/** Location state that focuses the board's search field; its value changes on each request. */
export const SEARCH_STATE = 'search';

function field(state: unknown, name: string): unknown {
  return typeof state === 'object' && state !== null ? (state as Record<string, unknown>)[name] : undefined;
}

export function composeRequested(state: unknown): boolean {
  return field(state, COMPOSE_STATE) === true;
}

/** The request's stamp, so a second press of `/` focuses the field again; null when none was made. */
export function searchRequested(state: unknown): number | null {
  const stamp = field(state, SEARCH_STATE);
  return typeof stamp === 'number' ? stamp : null;
}

/**
 * AGPL-3.0 section 13 requires a modified copy that people use over a network
 * to offer them its source, so every version of the app links to it.
 */
export const SOURCE_URL = 'https://github.com/notice-cx/Ntasks';
