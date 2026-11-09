import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme-without-fonts';
import { h } from 'vue';
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import '@fontsource-variable/stack-sans-notch/index.css';
import '../../src/tokens.css';
import './custom.css';
import markSvg from '../../../web/public/brand/notice-icon.svg?raw';
import { inlineMark } from '../../lib/mark.ts';
import { MermaidDiagram } from './mermaid.ts';

const mark = inlineMark(markSvg, 'nt-mark');

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'nav-bar-title-before': () => h('span', { class: 'nt-mark-slot', innerHTML: mark }),
    }),
  enhanceApp({ app }) {
    app.component('MermaidDiagram', MermaidDiagram);
  },
} satisfies Theme;
