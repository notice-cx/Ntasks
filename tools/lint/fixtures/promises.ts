// Code that breaks the rules on purpose. The lint run skips this directory;
// test/promises.test.ts lints the file. A line that ends with a rule's name
// must be reported by that rule, and no other line may be reported. The
// Worker's globals come from workers/api/worker-configuration.d.ts.

export async function refresh(): Promise<number> {
  return 1;
}

export async function mistakes(db: D1Database, ctx: ExecutionContext): Promise<void> {
  db.prepare('SELECT 1').run(); // no-floating-promises
  db.batch([db.prepare('SELECT 1')]); // no-floating-promises
  fetch('https://example.com/'); // no-floating-promises
  refresh(); // no-floating-promises
  refresh().then(() => undefined); // no-floating-promises
  [1, 2].forEach(async () => await refresh()); // no-misused-promises
  const ready = refresh() || 1; // no-misused-promises

  // The ways CONTRIBUTING.md allows: await, return, or ctx.waitUntil().
  await db.prepare('SELECT 1').run();
  ctx.waitUntil(refresh());
  console.log(ready);
}

export function handled(db: D1Database): Promise<D1Response> {
  return db.prepare('SELECT 1').run();
}
