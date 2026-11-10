import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme-without-fonts';
import { h, nextTick } from 'vue';
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import '@fontsource-variable/stack-sans-notch/index.css';
import '../../src/tokens.css';
import './custom.css';
import markSvg from '../../../web/public/brand/notice-icon.svg?raw';
import { inlineMark } from '../../lib/mark.ts';
import { onNewPage, recordPageview } from '../../lib/statcounter.ts';
import { MermaidDiagram } from './mermaid.ts';

const mark = inlineMark(markSvg, 'nt-mark');

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'nav-bar-title-before': () => h('span', { class: 'nt-mark-slot', innerHTML: mark }),
    }),
  enhanceApp({ app, router }) {
    app.component('MermaidDiagram', MermaidDiagram);
    if (typeof window === 'undefined') return;
    const opened = onNewPage(location.pathname, recordPageview);
    const after = router.onAfterRouteChange;
    router.onAfterRouteChange = async (to) => {
      await after?.(to);
      // The page's title changes on the next render; the counter records it.
      await nextTick();
      opened(location.pathname);
    };
  },
} satisfies Theme;
