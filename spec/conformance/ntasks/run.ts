/**
 * The suite against this repository's Worker, run locally:
 *
 *   pnpm --filter @ntasks/spec run conformance:ntasks [-- --only INV-1]
 *
 * It starts the Worker with wrangler's test harness, writes its senders into
 * the local database, runs every check of the four levels Ntasks claims, and
 * stops the Worker. Nothing reaches Cloudflare or a deployed Ntasks.
 */
import { parseArgs } from 'node:util';
import { checks } from '../src/checks/index.ts';
import { formatReport, resultLine } from '../src/report.ts';
import { runSuite } from '../src/suite.ts';
import { startLocalNtasks } from './local.ts';

// pnpm passes the `--` before a script's own options through.
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const { values } = parseArgs({ args, options: { only: { type: 'string' } } });
const only = values.only?.split(',');
const unknown = only?.filter((name) => !checks.some((check) => check.id === name || check.rule === name)) ?? [];
if (unknown.length > 0) {
  console.error(`--only names no check: ${unknown.join(', ')}. node conformance/run.ts --list lists them.`);
  process.exit(2);
}
const local = await startLocalNtasks();
let passed = false;
try {
  const report = await runSuite(local.target, {
    ...(only === undefined ? {} : { only }),
    ...(local.target.knownGaps === undefined ? {} : { knownGaps: local.target.knownGaps }),
    onResult: (result) => console.log(resultLine(result)),
  });
  console.log(
    `\n${formatReport(report)
      .split('\n')
      .slice(2 + report.results.length)
      .join('\n')}`,
  );
  passed = report.passed;
} finally {
  await local.close();
}
process.exit(passed ? 0 : 1);
