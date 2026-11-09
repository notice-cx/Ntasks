import type { HeadConfig } from 'vitepress';
import { SITE_ORIGIN } from './site.ts';

export const iconHead: HeadConfig[] = [
  ['link', { rel: 'icon', href: '/favicon.ico', sizes: '16x16 32x32 48x48' }],
  ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
  ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' }],
  ['link', { rel: 'icon', type: 'image/png', sizes: '96x96', href: '/favicon-96.png' }],
  ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' }],
];

/** The landing page and docs share the same branded link-preview image. */
export const socialHead: HeadConfig[] = [
  ['meta', { property: 'og:locale', content: 'en_US' }],
  ['meta', { name: 'robots', content: 'max-image-preview:large' }],
  ['meta', { property: 'og:image', content: `${SITE_ORIGIN}/social.jpg` }],
  ['meta', { property: 'og:image:type', content: 'image/jpeg' }],
  ['meta', { property: 'og:image:width', content: '1200' }],
  ['meta', { property: 'og:image:height', content: '630' }],
  [
    'meta',
    {
      property: 'og:image:alt',
      content: 'Ntasks. One task list for you and your AI agents. Task cards in a wooden organizer.',
    },
  ],
  ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ['meta', { name: 'twitter:image', content: `${SITE_ORIGIN}/social.jpg` }],
  [
    'meta',
    {
      name: 'twitter:image:alt',
      content: 'Ntasks. One task list for you and your AI agents. Task cards in a wooden organizer.',
    },
  ],
];

/** Renders the same head entries VitePress accepts into a static Vite page. */
export function headHtml(head: HeadConfig[]): string {
  return head
    .map(
      ([tag, attributes, content]) =>
        `<${tag} ${Object.entries(attributes ?? {})
          .map(([key, value]) => `${key}="${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`)
          .join(' ')}${content === undefined ? ' />' : `>${content}</${tag}>`}`,
    )
    .join('\n');
}
