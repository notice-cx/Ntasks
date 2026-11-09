/**
 * A PostCSS plugin that vite.config.ts runs on the package's stylesheet: it
 * scopes every rule to the app's root element, `[data-ntasks]`, so the
 * design system's tokens, Tailwind's reset and its utilities style only the
 * app and never a host's page. `:root`, `:host`, `html` and `body` name the
 * root itself; any other selector matches inside it, and, when it does not
 * start with an element's name, the root too. Keyframes, font faces and
 * registered properties have no selectors to scope and keep their global
 * names.
 */
import type { AtRule, Node, Plugin, Rule } from 'postcss';

export const SCOPE = '[data-ntasks]';

const PAGE_ROOT = /^(?::root|:host|html|body)(?=$|[\s.:[#>+~])/;

/** The selectors that stand for `selector` inside the app's root. */
export function scopedSelectors(selector: string): string[] {
  const trimmed = selector.trim();
  if (trimmed.startsWith(SCOPE)) return [trimmed];
  if (PAGE_ROOT.test(trimmed)) return [trimmed.replace(PAGE_ROOT, SCOPE)];
  const inside = `${SCOPE} ${trimmed}`;
  if (trimmed === '*') return [SCOPE, inside];
  // A selector that starts with an element's name cannot match the root, a div, as written.
  return /^[.:[#]/.test(trimmed) ? [`${SCOPE}${trimmed}`, inside] : [inside];
}

function scoped(rule: Rule): boolean {
  for (let node: Node | undefined = rule.parent; node; node = node.parent) {
    // A nested rule is scoped by the rule it sits in, and a keyframe's selector is a percentage.
    if (node.type === 'rule') return false;
    if (node.type === 'atrule' && /keyframes$/i.test((node as AtRule).name)) return false;
  }
  return true;
}

export function scopeStyles(): Plugin {
  return {
    postcssPlugin: 'ntasks-scope-styles',
    Rule(rule) {
      if (!scoped(rule)) return;
      const selectors = [...new Set(rule.selectors.flatMap(scopedSelectors))];
      if (selectors.join() !== rule.selectors.join()) rule.selectors = selectors;
    },
  };
}
