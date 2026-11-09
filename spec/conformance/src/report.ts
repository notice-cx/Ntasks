/** The report as text: one line per check, the failures with what each check sent, and each level's verdict. */
import type { CheckResult, Report } from './suite.ts';

const MARK: Readonly<Record<CheckResult['status'], string>> = {
  passed: 'pass',
  failed: 'FAIL',
  warned: 'warn',
  'not-run': 'skip',
  'known-gap': 'gap ',
  'gap-closed': 'FAIL',
};

export function resultLine(result: CheckResult): string {
  const bindings = result.bindings
    .map((binding) => `${binding.binding} ${binding.status === 'not-offered' ? '-' : binding.status}`)
    .join(', ');
  return `${MARK[result.status]}  ${result.rule.padEnd(9)} ${result.id}${bindings === '' ? '' : `  [${bindings}]`}`;
}

export function formatReport(report: Report): string {
  const lines: string[] = [`Shared Work Protocol v0 conformance: ${report.target}`, ''];
  for (const result of report.results) lines.push(resultLine(result));
  const attention = report.results.filter((result) => result.status !== 'passed');
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
  const incomplete = report.levels.some((level) => level.status === 'incomplete');
  lines.push(
    '',
    !report.passed
      ? 'Some checks failed.'
      : incomplete
        ? 'No check failed, but a claimed level is incomplete: some of its checks did not run.'
        : 'No check of the claimed levels failed.',
  );
  return lines.join('\n');
}
