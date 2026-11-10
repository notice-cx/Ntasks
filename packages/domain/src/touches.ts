/**
 * Whether two tasks' work changes the same thing: the entries of `touches`
 * (TaskWork) that two lists share. Two entries meet when they are the same
 * path, or when one is a folder that holds the other, so
 * `workers/api/src/store/migrations` meets
 * `workers/api/src/store/migrations/0006_merge_order.sql`. A leading `./`
 * and a trailing `/` are ignored; letters keep their case.
 */
function plain(entry: string): string {
  return entry.replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '');
}

function meet(a: string, b: string): boolean {
  const [x, y] = [plain(a), plain(b)];
  return x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`);
}

/** The entries of `theirs` that meet one of `mine`, in their order. */
export function overlappingTouches(mine: readonly string[], theirs: readonly string[]): string[] {
  return theirs.filter((entry) => mine.some((own) => meet(own, entry)));
}
