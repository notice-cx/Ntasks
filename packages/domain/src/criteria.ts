/**
 * A task's "done when" criteria, read from its acceptance text. Acceptance
 * stays free Markdown; when a person accepts a task as done on their own
 * call, each line or list item of it is one criterion they find met or waive.
 * The Worker records the criteria from this and the web app shows them from
 * it, so both number them the same way.
 */

/** A list item's marker, and a task-list box after it: `- `, `* `, `+ `, `1. ` or `1) `, then `[ ] ` or `[x] `. */
const ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/u;
/** A Markdown heading, which titles criteria and is none itself. */
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/u;

/**
 * The criteria in `acceptance`, in order: each list item, and each other line
 * that is not blank or a heading. An indented line that is not a list item
 * continues the criterion before it, as a list item wrapped over two lines does.
 */
export function criteriaOf(acceptance: string): string[] {
  const criteria: string[] = [];
  for (const line of acceptance.split(/\r?\n/u)) {
    if (line.trim() === '' || HEADING.test(line)) continue;
    const item = ITEM.exec(line);
    if (item === null && /^\s/u.test(line) && criteria.length > 0) {
      criteria[criteria.length - 1] += ` ${line.trim()}`;
      continue;
    }
    const text = (item === null ? line : line.slice(item[0].length)).trim();
    if (text !== '') criteria.push(text);
  }
  return criteria;
}
