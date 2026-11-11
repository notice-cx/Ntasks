import { describe, expect, it } from 'vitest';
import type { TaskChange } from '@/api/types';
import { changeWords } from '@/lib/change-words';

const PR = 'https://github.example.com/example/web/pull/42';

function change(kind: string, changes: Record<string, unknown> = {}): TaskChange {
  return { seq: 7, projectId: 'p-web', taskId: 'web-1', kind, actor: 'agent:claude', model: null, changes };
}

describe('a change in words', () => {
  it('names a comment, a close, a reopen and a new task by their kind', () => {
    expect(changeWords(change('commented', { text: 'Started' }))).toBe('commented');
    expect(changeWords(change('closed', { status: 'closed' }))).toBe('closed it');
    expect(changeWords(change('reopened'))).toBe('reopened it');
    expect(changeWords(change('created'))).toBe('created it');
  });

  it('names a merge and a deploy with the pull request they shipped', () => {
    expect(changeWords(change('updated', { delivery: { stage: 'merged', pullRequest: PR } }))).toBe('merged #42');
    expect(changeWords(change('updated', { delivery: { stage: 'live', pullRequest: null } }))).toBe('deployed it');
  });

  it('names a claim and a release', () => {
    expect(changeWords(change('updated', { assignee: 'agent:claude' }))).toBe('claimed it');
    expect(changeWords(change('updated', { assignee: null }))).toBe('freed it');
  });

  it('names the work detail that changed, a new commit first', () => {
    const before = { work: { branch: 'claude/sign-in', pr: PR, next: 'Write the tests' } };
    const after = (work: Record<string, unknown>) => changeWords(change('updated', { work }), before);
    expect(after({ ...before.work, commit: 'abc1234', next: 'Fix the review' })).toBe('pushed a commit');
    expect(after({ ...before.work, next: 'Fix the review' })).toBe('set the next step');
    expect(changeWords(change('updated', { work: { pr: PR } }), { work: {} })).toBe('opened #42');
    expect(changeWords(change('updated', { work: { branch: 'codex/fix' } }), null)).toBe('started a branch');
    // Details that stayed as they were, or were cleared, name nothing.
    expect(after(before.work)).toBeNull();
    expect(after({ branch: 'claude/sign-in' })).toBeNull();
  });

  it('labels nothing it cannot name', () => {
    expect(changeWords(change('updated', { dependencies: [] }))).toBeNull();
    expect(changeWords(change('archived'))).toBeNull();
    expect(changeWords({ seq: 1, projectId: 'p-web', taskId: 'web-1' })).toBeNull();
  });
});
