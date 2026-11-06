/**
 * Dark is the default theme; `.light` on <html> switches every token, and it
 * follows the system's preference while the page is open. It goes on <html>
 * because the token aliases in index.css are declared there and resolve
 * against that element's brand values.
 */
export function followSystemTheme(root: HTMLElement, media: MediaQueryList): void {
  const apply = () => root.classList.toggle('light', !media.matches);
  apply();
  media.addEventListener('change', apply);
}
