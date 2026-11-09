import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { scopeStyles } from '../scope-styles.config.ts';

/** Each rule's selectors after scoping, in order. */
function scoped(css: string): string[][] {
  const root = postcss([scopeStyles()]).process(css, { from: undefined }).root;
  const rules: string[][] = [];
  root.walkRules((rule) => {
    rules.push(rule.selectors);
  });
  return rules;
}

describe("the stylesheet's scope", () => {
  it('moves the page root, the reset and the utilities inside the app root', () => {
    expect(
      scoped(`
        :root, :host { --spacing: 4px }
        html { line-height: 1.5 }
        body { margin: 0 }
        *, ::before { box-sizing: border-box }
        h1, select:not([multiple]) { font-size: inherit }
        .dark, .bg-canvas:hover { color: red }
        @media (width >= 40rem) { .sm\\:flex { display: flex } }
        @layer base { :root, .light { --ink: #000 } }
      `),
    ).toEqual([
      ['[data-ntasks]'],
      ['[data-ntasks]'],
      ['[data-ntasks]'],
      ['[data-ntasks]', '[data-ntasks] *', '[data-ntasks]::before', '[data-ntasks] ::before'],
      ['[data-ntasks] h1', '[data-ntasks] select:not([multiple])'],
      ['[data-ntasks].dark', '[data-ntasks] .dark', '[data-ntasks].bg-canvas:hover', '[data-ntasks] .bg-canvas:hover'],
      ['[data-ntasks].sm\\:flex', '[data-ntasks] .sm\\:flex'],
      ['[data-ntasks]', '[data-ntasks].light', '[data-ntasks] .light'],
    ]);
  });

  it('leaves keyframes, nested rules and rules already scoped as they are', () => {
    expect(
      scoped(`
        @keyframes arrive { from { opacity: 0 } to { opacity: 1 } }
        .row { &:hover { color: red } }
        [data-ntasks] .x { color: red }
      `),
    ).toEqual([['from'], ['to'], ['[data-ntasks].row', '[data-ntasks] .row'], ['&:hover'], ['[data-ntasks] .x']]);
  });
});
