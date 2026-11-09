import { describe, expect, it } from 'vitest';
import { criteriaOf } from '../src/index.ts';

describe('criteriaOf', () => {
  it('reads each list item, of any marker, without its marker or task-list box', () => {
    expect(
      criteriaOf('- Merged.\n* Deployed.\n+ Announced.\n1. Logged.\n2) Measured.\n- [ ] Ticked.\n- [x] Done.'),
    ).toEqual(['Merged.', 'Deployed.', 'Announced.', 'Logged.', 'Measured.', 'Ticked.', 'Done.']);
  });

  it('reads each other line as a criterion, skipping blank lines and headings', () => {
    expect(criteriaOf('## Done when\n\nThe page loads.\r\nThe test passes.\n   \n#hashtag stays')).toEqual([
      'The page loads.',
      'The test passes.',
      '#hashtag stays',
    ]);
  });

  it('joins an indented line to the item it wraps, and keeps a nested item as its own', () => {
    expect(
      criteriaOf('- A person closes a task\n  with a reason.\n  - The history records it.\n- Agents cannot.'),
    ).toEqual(['A person closes a task with a reason.', 'The history records it.', 'Agents cannot.']);
  });

  it('finds none in an empty acceptance', () => {
    expect(criteriaOf('')).toEqual([]);
    expect(criteriaOf('\n  \n')).toEqual([]);
  });
});
