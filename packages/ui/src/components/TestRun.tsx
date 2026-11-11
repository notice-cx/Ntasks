import { Check, X } from 'lucide-react';
import type { TaskTestResult } from '../api/types';

/**
 * A test run a comment or a close reported, on one line under its words:
 * passed or failed, the counts, the command and the commit. Greys only: green
 * and red mean Done and Blocked, so the mark and the word say the result.
 */
export function TestRun({ run }: { run: TaskTestResult }) {
  const passed = run.result === 'passed';
  const counts = [
    run.passed === undefined ? null : `${run.passed} passed`,
    run.failed === undefined ? null : `${run.failed} failed`,
  ].filter((count) => count !== null);
  return (
    <p
      className="m-0 mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ink-3"
      data-test-run={run.result}
    >
      <span className="inline-flex items-center gap-1 font-medium text-ink-2">
        {passed ? <Check aria-hidden className="size-3.5" /> : <X aria-hidden className="size-3.5" />}
        {passed ? 'Tests passed' : 'Tests failed'}
      </span>
      {counts.length > 0 ? <span className="nums">{counts.join(', ')}</span> : null}
      <code className="font-mono [overflow-wrap:anywhere]">{run.command}</code>
      {run.commit === undefined ? null : (
        <span>
          on <code className="font-mono">{run.commit.slice(0, 7)}</code>
        </span>
      )}
    </p>
  );
}
