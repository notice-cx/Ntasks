import { readIndex } from './docs-index.ts';

// The landing page's list of docs, drawn from docs/index.md, so it lists the
// same pages under the same headings as the docs' sidebar.

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A description from docs/index.md as the landing page shows it: plain text, starting with a capital. */
function sentence(text: string): string {
  const plain = text.replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

/** The HTML of the landing page's docs list for docs/index.md, linking under `base`. */
export function docsList(indexMarkdown: string, base: string): string {
  return readIndex(indexMarkdown)
    .map((group) => {
      const items = group.files
        .map(
          (page) =>
            `<li><a href="${base}${page.file.replace(/\.md$/, '')}"><span class="doc-title">${escape(page.text)}</span>` +
            `<span class="doc-description">${escape(sentence(page.description))}</span></a></li>`,
        )
        .join('');
      return `<div class="doc-group"><h3>${escape(group.text)}</h3><ul>${items}</ul></div>`;
    })
    .join('');
}
