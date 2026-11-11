import { describe, expect, it } from 'vitest';
import { missingSections, requiredSections } from '../src/index.ts';

describe('missingSections', () => {
  it('names what a bug lacks, in order', () => {
    expect(missingSections({ type: 'bug', description: 'It crashes.', acceptance: '' })).toEqual([
      '## Steps to Reproduce',
      'acceptance',
    ]);
  });

  it('finds a heading by its name anywhere in the description, in any case', () => {
    expect(
      missingSections({ type: 'bug', description: '### steps TO reproduce\n1. Open it.', acceptance: 'No crash.' }),
    ).toEqual([]);
  });

  it('counts only a non-blank acceptance field as acceptance', () => {
    expect(missingSections({ type: 'task', description: '', acceptance: 'Merged.' })).toEqual([]);
    expect(missingSections({ type: 'epic', description: '', acceptance: 'Every child closed.' })).toEqual([]);
    expect(missingSections({ type: 'feature', description: '## Acceptance\nMerged.', acceptance: '   ' })).toEqual([
      'acceptance',
    ]);
  });

  it('expects nothing of a decision, a chore or a gate', () => {
    for (const type of ['decision', 'chore', 'gate'] as const) {
      expect(requiredSections(type)).toEqual([]);
      expect(missingSections({ type, description: '', acceptance: '' })).toEqual([]);
    }
  });
});
