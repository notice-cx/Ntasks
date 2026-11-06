import { describe, expect, it } from 'vitest';
import { missingSections, requiredSections } from '../src/index.ts';

// Cases follow Beads' lint (MIT License, Copyright (c) 2025 Beads
// Contributors; THIRD_PARTY_NOTICES.md), internal/validation/template.go in v1.3.1.

describe('missingSections', () => {
  it('names every section a bug lacks, in order', () => {
    expect(missingSections({ type: 'bug', description: 'It crashes.', acceptance: '' })).toEqual([
      '## Steps to Reproduce',
      '## Acceptance Criteria',
    ]);
  });

  it('finds a section by its name anywhere, in any case', () => {
    expect(
      missingSections({
        type: 'bug',
        description: '### steps TO reproduce\n1. Open it.\nACCEPTANCE CRITERIA: no crash',
        acceptance: '',
      }),
    ).toEqual([]);
  });

  it('counts a non-empty acceptance field as the criteria section', () => {
    expect(missingSections({ type: 'task', description: '', acceptance: 'Merged.' })).toEqual([]);
    expect(missingSections({ type: 'epic', description: '', acceptance: 'Every child closed.' })).toEqual([]);
    expect(missingSections({ type: 'task', description: '', acceptance: '   ' })).toEqual(['## Acceptance Criteria']);
  });

  it("accepts Acceptance Criteria in place of an epic's Success Criteria", () => {
    expect(
      missingSections({ type: 'epic', description: '## Acceptance Criteria\nAll shipped.', acceptance: '' }),
    ).toEqual([]);
  });

  it('expects a decision to state the decision, its rationale and the alternatives', () => {
    expect(missingSections({ type: 'decision', description: '## Rationale\nCheaper.', acceptance: '' })).toEqual([
      '## Decision',
      '## Alternatives Considered',
    ]);
  });

  it('expects nothing of a chore or a gate', () => {
    expect(requiredSections('chore')).toEqual([]);
    expect(requiredSections('gate')).toEqual([]);
    expect(missingSections({ type: 'chore', description: '', acceptance: '' })).toEqual([]);
  });
});
