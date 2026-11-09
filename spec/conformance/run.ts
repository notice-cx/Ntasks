/**
 * Checks a server against the Shared Work Protocol v0:
 *
 *   node conformance/run.ts --target target.json [--only INV-1,inv-3-retry-answers-once] [--binding mcp] [--json report.json]
 *   node conformance/run.ts --list
 *
 * The target file names the server's address, the levels it claims, its
 * bindings, projects and senders (README.md). The command prints a line per
 * check and exits 1 when a check of a claimed level fails.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { sectionOf } from './src/check.ts';
import { checks } from './src/checks/index.ts';
import { formatReport, resultLine } from './src/report.ts';
import { runSuite } from './src/suite.ts';
import { BINDINGS, readTarget, type BindingName, type Target } from './src/target.ts';

// pnpm passes the `--` before a script's own options through.
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const { values } = parseArgs({
  args,
  options: {
    target: { type: 'string' },
    only: { type: 'string' },
    binding: { type: 'string' },
    json: { type: 'string' },
    list: { type: 'boolean' },
  },
});
if (values.list === true) {
  for (const check of checks)
    console.log(
      `${check.level.padEnd(9)}${check.rule.padEnd(10)}${check.id}\n${' '.repeat(19)}${check.title} (${sectionOf(check.rule)})`,
    );
  process.exit(0);
}
if (values.target === undefined) {
  console.error('Usage: node conformance/run.ts --target target.json [--only ids] [--binding mcp|http] [--json file]');
  process.exit(2);
}
const binding = values.binding as BindingName | undefined;
if (binding !== undefined && !BINDINGS.includes(binding)) {
  console.error(`--binding is one of ${BINDINGS.join(', ')}`);
  process.exit(2);
}
const only = values.only?.split(',');
const unknown = only?.filter((name) => !checks.some((check) => check.id === name || check.rule === name)) ?? [];
if (unknown.length > 0) {
  console.error(`--only names no check: ${unknown.join(', ')}. --list lists them.`);
  process.exit(2);
}
let target: Target;
try {
  target = readTarget(values.target);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const report = await runSuite(target, {
  ...(only === undefined ? {} : { only }),
  ...(binding === undefined ? {} : { bindings: [binding] }),
  ...(target.knownGaps === undefined ? {} : { knownGaps: target.knownGaps }),
  onResult: (result) => console.log(resultLine(result)),
});
console.log(
  `\n${formatReport(report)
    .split('\n')
    .slice(2 + report.results.length)
    .join('\n')}`,
);
if (values.json !== undefined) writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
process.exit(report.passed ? 0 : 1);
