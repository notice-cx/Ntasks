import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import './tokens.css';
import './landing.css';

// The landing page's theme switch, copy buttons and walkthrough tabs. The
// page reads fully without this script.

// The key VitePress keeps the docs' theme choice under, so the landing page
// and the docs show the same theme: 'dark', 'light', or 'auto' for the
// system's preference.
const THEME_KEY = 'vitepress-theme-appearance';
const systemDark = matchMedia('(prefers-color-scheme: dark)');

function savedTheme(): string {
  try {
    return localStorage.getItem(THEME_KEY) ?? 'auto';
  } catch {
    return 'auto';
  }
}

function applyTheme(): void {
  const saved = savedTheme();
  const dark = saved === 'dark' || (saved !== 'light' && systemDark.matches);
  document.documentElement.classList.toggle('dark', dark);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-switch]')) {
    button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
}

function switchTheme(): void {
  const dark = !document.documentElement.classList.contains('dark');
  // Choosing the system's own theme follows the system again from then on.
  const next = dark === systemDark.matches ? 'auto' : dark ? 'dark' : 'light';
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Without storage the choice lasts until the page is left.
    document.documentElement.classList.toggle('dark', dark);
    return;
  }
  applyTheme();
}

applyTheme();
systemDark.addEventListener('change', applyTheme);
window.addEventListener('storage', (event) => {
  if (event.key === THEME_KEY) applyTheme();
});
for (const button of document.querySelectorAll('[data-theme-switch]')) {
  button.addEventListener('click', switchTheme);
}

const copiedStatus = document.querySelector('[data-copied-status]');
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  button.addEventListener('click', () => {
    const text = button.dataset.copy ?? '';
    navigator.clipboard.writeText(text).then(
      () => {
        button.classList.add('copied');
        if (copiedStatus) copiedStatus.textContent = 'Copied';
        setTimeout(() => {
          button.classList.remove('copied');
          if (copiedStatus) copiedStatus.textContent = '';
        }, 2000);
      },
      () => {
        // The clipboard refused; the command stays selectable on the page.
      },
    );
  });
}

// The walkthrough tabs, as the ARIA tabs pattern describes: arrow keys,
// Home and End move between tabs, and the chosen tab's panel shows.
for (const list of document.querySelectorAll<HTMLElement>('[data-tabs]')) {
  const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const select = (chosen: HTMLButtonElement, focus: boolean) => {
    for (const tab of tabs) {
      const selected = tab === chosen;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      if (panel) panel.hidden = !selected;
    }
    if (focus) chosen.focus();
  };
  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab, false));
    tab.addEventListener('keydown', (event) => {
      const at = tabs.indexOf(tab);
      const to =
        event.key === 'ArrowRight'
          ? tabs[(at + 1) % tabs.length]
          : event.key === 'ArrowLeft'
            ? tabs[(at - 1 + tabs.length) % tabs.length]
            : event.key === 'Home'
              ? tabs[0]
              : event.key === 'End'
                ? tabs.at(-1)
                : undefined;
      if (to) {
        event.preventDefault();
        select(to, true);
      }
    });
  }
}
