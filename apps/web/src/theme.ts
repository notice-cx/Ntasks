/**
 * Light is the default theme; `.dark` on <html> switches every token, and it
 * follows the system's preference while the page is open. It goes on <html>
 * so the whole page, the toasts and the menus Radix draws outside the app's
 * root all switch together.
 */
export function followSystemTheme(root: HTMLElement, media: MediaQueryList): void {
  const apply = () => root.classList.toggle('dark', media.matches);
  apply();
  media.addEventListener('change', apply);
}
