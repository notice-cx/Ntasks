/** A task's page. A task id names its project by its prefix, so the address needs nothing else. */
export function taskPath(id: string): string {
  return `/tasks/${encodeURIComponent(id)}`;
}

/** The prefix a task id starts with: everything before its first hyphen. */
export function taskPrefix(id: string): string {
  const at = id.indexOf('-');
  return at < 0 ? '' : id.slice(0, at);
}

/**
 * Whether an address on this site is one of the app's own pages: `/` and
 * everything under `/tasks`. Any other address here, such as `/sign-in` or
 * `/api/…`, is the Worker's, and a link to it must load it, not route to it.
 */
export function isAppPage(pathname: string): boolean {
  return pathname === '/' || pathname === '/tasks' || pathname.startsWith('/tasks/');
}
