// A stand-in for the dolt SQL client: answers each query of a step from a
// JSON file of canned answers, printing them as dolt 2.6.1 does: `{}` and an
// empty line for START TRANSACTION and ROLLBACK, and one result line for each
// SELECT.
import { readFileSync } from 'node:fs';

const [answersFile, ...rest] = process.argv.slice(2);
const sql = rest.at(-1);
const { password, home, queries } = JSON.parse(readFileSync(answersFile, 'utf8'));
if (process.env.DOLT_CLI_PASSWORD !== password) {
  process.stderr.write('Access denied for user\n');
  process.exit(1);
}
// The client must not see the caller's home folder or its settings.
if (process.env.HOME === home || process.env.DOLT_DISABLE_EVENT_FLUSH !== '1') {
  process.stderr.write("The client ran with the caller's home or with usage reporting on\n");
  process.exit(1);
}
const markers = /SELECT '(ntasks-[^']+)' AS ntasks_query(?:; |$)/gu;
if (!sql.startsWith('START TRANSACTION READ ONLY; ') || !sql.endsWith('; ROLLBACK')) {
  process.stderr.write('A step must run in a read-only transaction\n');
  process.exit(1);
}
const body = sql.slice('START TRANSACTION READ ONLY; '.length, -'; ROLLBACK'.length);
// With a capture group, split() gives the text before the first marker, then each marker and the text after it.
const parts = body.split(markers);
const out = ['{}', ''];
for (let index = 1; index < parts.length; index += 2) {
  const marker = parts[index];
  out.push(`{"rows": [{"ntasks_query":"${marker}"}]}`);
  if (marker.endsWith(':end')) break;
  const query = parts[index + 1].replace(/; $/u, '');
  if (!Object.hasOwn(queries, query)) {
    process.stderr.write(`unknown query: ${query}\n`);
    process.exit(1);
  }
  const rows = queries[query];
  out.push(rows.length === 0 ? '{}\n' : JSON.stringify({ rows }));
}
out.push('{}', '');
process.stdout.write(`${out.join('\n')}\n`);
