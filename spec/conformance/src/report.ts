/** The report as text: one line per check, the failures with what each check sent, and each level's verdict. */
import type { CheckResult, Report } from './suite.ts';

const MARK: Readonly<Record<CheckResult['status'], string>> = {
  passed: 'pass',
  failed: 'FAIL',
  warned: 'warn',
  'not-run': 'skip',
  'known-gap': 'gap ',
  'gap-closed': 'FAIL',
  'not-applicable': 'n/a ',
};

export function resultLine(result: CheckResult): string {
  const bindings = result.bindings
    .map(
      (binding) =>
        `${binding.binding} ${binding.status === 'not-offered' ? '-' : binding.status === 'not-run' ? 'skipped' : binding.status}`,
    )
    .join(', ');
  return `${MARK[result.status]}  ${result.rule.padEnd(9)} ${result.id}${bindings === '' ? '' : `  [${bindings}]`}`;
}

export function formatReport(report: Report): string {
  const lines: string[] = [`Shared Work Protocol v0 conformance: ${report.target}`, ''];
  for (const result of report.results) lines.push(resultLine(result));
  const attention = report.results.filter((result) => !['passed', 'not-applicable'].includes(result.status));
  if (attention.length > 0) lines.push('');
  for (const result of attention) {
    lines.push(`${MARK[result.status]}  ${result.id} — ${result.title} (${result.section})`);
    if (result.detail) lines.push(`      ${result.detail}`);
    for (const binding of result.bindings) {
      if (binding.status === 'passed') continue;
      lines.push(`      ${binding.binding}: ${binding.detail ?? binding.status}`);
      if (binding.status === 'failed' && result.status !== 'known-gap')
        for (const line of binding.trace ?? []) lines.push(`        ${line}`);
    }
  }
  lines.push('');
  for (const level of report.levels) lines.push(`${level.level.padEnd(9)} ${level.status}`);
  lines.push('', verdict(report));
  return lines.join('\n');
}

/** The run's result in one sentence, naming what a passing run still leaves out. */
function verdict(report: Report): string {
  if (!report.passed) return 'Some checks failed.';
  const count = (status: CheckResult['status']) => report.results.filter((result) => result.status === status).length;
  const caveats = [
    [count('known-gap'), 'known gap failed as listed', 'known gaps failed as listed'],
    [count('warned'), 'check of a SHOULD rule failed', 'checks of SHOULD rules failed'],
    [
      count('not-run'),
      'check did not run, so its level is incomplete',
      'checks did not run, so their levels are incomplete',
    ],
  ] as const;
  const named = [
    ...caveats.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`),
    ...(report.filtered
      ? ["--only or --binding left part of the run out, so no level's verdict is a conformance result"]
      : []),
  ];
  return named.length === 0 ? 'Every check of the claimed levels passed.' : `The run passed, but ${named.join('; ')}.`;
}
