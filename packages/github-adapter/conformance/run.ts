/**
 * The conformance suite's core level against the adapter:
 *
 *   pnpm --filter @ntasks/github-adapter run conformance
 *
 * runs over the stand-in for GitHub, and
 *
 *   SWP_GITHUB_REPOSITORY=owner/name GITHUB_TOKEN=… pnpm --filter @ntasks/github-adapter run conformance
 *
 * over that GitHub repository, whose issues it fills with the checks' tasks.
 * Point it only at a repository made for the run.
 */
import { formatReport, resultLine } from '../../../spec/conformance/src/report.ts';
import { runSuite } from '../../../spec/conformance/src/suite.ts';
import { startLocalAdapter } from './local.ts';

const repository = process.env.SWP_GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (repository !== undefined && (token === undefined || token === '')) {
  console.error('SWP_GITHUB_REPOSITORY needs GITHUB_TOKEN: a token that may read and write that repository’s issues.');
  process.exit(2);
}
const local = await startLocalAdapter(repository === undefined ? null : { repository, token: token! });
let passed = false;
try {
  console.log(repository === undefined ? 'Over the stand-in for GitHub.' : `Over GitHub: ${repository}.`);
  const report = await runSuite(local.target, {
    knownGaps: local.target.knownGaps ?? {},
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
