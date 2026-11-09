import { defineComponent, h, onMounted, ref, watch } from 'vue';
import { useData } from 'vitepress';

// A ```mermaid block in docs/, drawn in the page's theme. GitHub draws the
// same blocks itself. Until the diagram is drawn, and without JavaScript,
// the block's source shows instead. Mermaid loads only on a page that has
// a diagram.

function token(style: CSSStyleDeclaration, name: string): string {
  return style.getPropertyValue(name).trim();
}

export const MermaidDiagram = defineComponent({
  name: 'MermaidDiagram',
  props: { code: { type: String, required: true } },
  setup(props) {
    const { isDark } = useData();
    const source = decodeURIComponent(props.code);
    const svg = ref('');
    let drawn = 0;

    async function draw() {
      const attempt = ++drawn;
      const { default: mermaid } = await import('mermaid');
      // Mermaid's base theme derives its shades from hex colours, which the
      // tokens are.
      const style = getComputedStyle(document.documentElement);
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        fontFamily: token(style, '--font-sans'),
        themeVariables: {
          darkMode: isDark.value,
          fontSize: '14px',
          background: token(style, '--background'),
          primaryColor: token(style, '--surface'),
          primaryBorderColor: token(style, '--border-strong'),
          primaryTextColor: token(style, '--ink'),
          secondaryColor: token(style, '--accent-soft'),
          tertiaryColor: token(style, '--canvas'),
          lineColor: token(style, '--ink-3'),
          textColor: token(style, '--ink-2'),
          clusterBkg: token(style, '--canvas'),
          clusterBorder: token(style, '--border'),
          edgeLabelBackground: token(style, '--background'),
        },
      });
      const { svg: drawing } = await mermaid.render(`mermaid-${crypto.randomUUID()}`, source);
      if (attempt === drawn) svg.value = drawing;
    }

    onMounted(() => void draw());
    watch(isDark, () => void draw(), { flush: 'post' });

    return () =>
      svg.value
        ? h('div', { class: 'mermaid-diagram', innerHTML: svg.value })
        : h('pre', { class: 'mermaid-diagram mermaid-source' }, source);
  },
});
