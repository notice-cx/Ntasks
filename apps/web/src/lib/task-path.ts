/** A task's page. A task id names its project by its prefix, so the address needs nothing else. */
export function taskPath(id: string): string {
  return `/tasks/${encodeURIComponent(id)}`;
}

/** The prefix a task id starts with: everything before its first hyphen. */
export function taskPrefix(id: string): string {
  const at = id.indexOf('-');
  return at < 0 ? '' : id.slice(0, at);
}
