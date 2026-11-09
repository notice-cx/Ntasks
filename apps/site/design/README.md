# Website images and social assets

The landing page uses `src/images/work-in-order.webp` in its hero and
`src/images/shared-worktable.webp` beside Get started. The photographs were
generated with OpenAI image generation. The hero depicts Claude, ChatGPT
and a person on task cards; the supporting image depicts a shared worktable.
The small versions are 768 × 512; the full versions are 1536 × 1024. Both
use WebP at quality 82. The app screenshots remain real captures.

`social-card.html` is the source for the JPEG social assets in `public/`:

| File | Dimensions | Use |
|---|---|---|
| `social.jpg` | 1200 × 630 | Open Graph and X large-image link previews, including Messages |
| `social-square.jpg` | 1080 × 1080 | Square posts and manual social sharing |
| `social-story.jpg` | 1080 × 1920 | Portrait story posts |

Run the landing development server and open `/design/social-card.html`.
Capture the page at each size above with a device scale of 1, once its local
fonts and image have loaded. The layout changes at the square and portrait
sizes. It reads the site's tokens, installed fonts, Notice mark and hero
image; edit those sources rather than drawing a second brand system here.
The design source is not included in the site build.

`public/social.webp` retains the old link-preview URL and is a WebP export
of `social.jpg`. Favicons use the existing Notice mark: SVG, 32 px and 96 px
PNG, a 16/32/48 px ICO, and the existing 180 px Apple touch icon. The 96 px
and ICO files are resized from `apps/web/public/brand/notice-icon-180.png`.

The shared metadata in `lib/social.ts` supplies image dimensions, MIME type
and alt text, and the icons for both the landing page and docs. Each docs
page keeps its own title, description and canonical URL. `lib/discovery.ts`
supplies WebSite/SoftwareApplication JSON-LD, docs page/breadcrumb JSON-LD,
and an `llms.txt` directory generated from `docs/index.md`. The directory is
an aid for readers and agents, not a promise of search ranking or inclusion.

The HTML is readable without client JavaScript. `robots.txt` allows crawlers
and points at the generated sitemap. Both 404 pages are marked `noindex`.
The build checks that referenced social images and favicons exist locally;
it never requests production URLs. Platform rendering and cached previews
can only be checked against an approved deployment.

Reference contracts: [Open Graph](https://ogp.me/),
[Messages rich previews](https://developer.apple.com/documentation/technotes/tn3156-create-rich-previews-for-messages),
[Google AI search guidance](https://developers.google.com/search/docs/appearance/ai-features),
and [Google favicon guidance](https://developers.google.com/search/docs/appearance/favicon-in-search).
