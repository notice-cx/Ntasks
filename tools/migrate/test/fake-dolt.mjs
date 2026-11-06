// A stand-in for the dolt SQL client: answers the query given as its last
// argument from a JSON file of canned answers, in Dolt's JSON result format.
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
if (!Object.hasOwn(queries, sql)) {
  process.stderr.write(`unknown query: ${sql}\n`);
  process.exit(1);
}
const rows = queries[sql];
// A `USE` statement prints its own empty result line first.
if (sql.startsWith('USE ')) process.stdout.write('{}\n');
process.stdout.write(rows.length === 0 ? '{}\n' : `${JSON.stringify({ rows })}\n`);
