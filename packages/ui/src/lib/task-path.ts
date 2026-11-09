/** The prefix a task id starts with: everything before its first hyphen. */
export function taskPrefix(id: string): string {
  const at = id.indexOf('-');
  return at < 0 ? '' : id.slice(0, at);
}
