/**
 * The Notice mark (apps/web/public/brand/notice-icon.svg) for inlining in a
 * page. The file colours itself from the system's light or dark preference
 * with a <style> that would reach every path on the page once inlined, so the
 * inlined copy drops it and takes the text colour instead, which follows the
 * page's own theme.
 */
export function inlineMark(svg: string, className: string): string {
  return svg
    .replace(/<style>[\s\S]*?<\/style>/, '')
    .replace(/<svg\b/, `<svg class="${className}" fill="currentColor" aria-hidden="true" focusable="false"`)
    .trim();
}
