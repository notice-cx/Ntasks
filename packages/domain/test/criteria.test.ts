import { describe, expect, it } from 'vitest';
import { criteriaOf } from '../src/index.ts';

const texts = (acceptance: string) => criteriaOf(acceptance).map((criterion) => criterion.text);

describe('criteriaOf', () => {
  it('reads each list item, of any marker, without its marker or task-list box', () => {
    expect(texts('- Merged.\n* Deployed.\n+ Announced.\n1. Logged.\n2) Measured.\n- [ ] Ticked.\n- [x] Done.')).toEqual(
      ['Merged.', 'Deployed.', 'Announced.', 'Logged.', 'Measured.', 'Ticked.', 'Done.'],
    );
  });

  it('says which task-list boxes are ticked', () => {
    expect(criteriaOf('- [x] Merged.\n- [ ] Deployed.\n- [X] Announced.\n- Logged.')).toEqual([
      { text: 'Merged.', ticked: true },
      { text: 'Deployed.', ticked: false },
      { text: 'Announced.', ticked: true },
      { text: 'Logged.', ticked: false },
    ]);
  });

  it('reads each other line as a criterion, skipping blank lines and headings', () => {
    expect(texts('## Done when\n\nThe page loads.\r\nThe test passes.\n   \n#hashtag stays')).toEqual([
      'The page loads.',
      'The test passes.',
      '#hashtag stays',
    ]);
  });

  it('joins an indented line to the item it wraps, and keeps a nested item as its own', () => {
    expect(texts('- A person closes a task\n  with a reason.\n  - The history records it.\n- Agents cannot.')).toEqual([
      'A person closes a task with a reason.',
      'The history records it.',
      'Agents cannot.',
    ]);
  });

  it('finds none in an empty acceptance', () => {
    expect(criteriaOf('')).toEqual([]);
    expect(criteriaOf('\n  \n')).toEqual([]);
  });
});
