# The Ntasks website

The site at [ntasks.notice.cx](https://ntasks.notice.cx): the landing page at
`/`, the Markdown in [`docs/`](../../docs/) rendered as the docs at
`/docs/`, and the Shared Work Protocol in [`spec/`](../../spec/) at
`/spec/`, the last two with search, a sidebar and light and dark themes.
All three take the look of [www.notice.cx](https://www.notice.cx), the
Notice website this site belongs to: its paper palette in light, its night palette in dark, Inter, and
the wordmark in Stack Sans Notch.

| Path | Holds |
|---|---|
| `protocol/` | The Shared Work Protocol: VitePress reads `spec/` in place and serves it at `/spec/` with the docs' theme, and copies `spec/schemas/` to `/spec/v0/schemas/`, the address each schema's `$id` names |
| `index.html`, `404.html`, `src/` | The landing page and the 404 page for addresses outside `/docs/`, built with Vite. The page's script runs the theme switch, the copy buttons and the walkthrough tabs, and starts each loop diagram when it scrolls into view; the page reads without it. The diagrams themselves are CSS in `src/landing.css` |
| `.vitepress/` | The docs: [VitePress](https://vitepress.dev) reads `docs/` in place, with its default theme in those colours and fonts |
| `lib/` | The rules both builds share: how the docs' Markdown renders, the sidebar, the link check |
| `src/tokens.css` | The colours and fonts both builds use, taken from www.notice.cx |
| `public/` | Headers, robots rules, social cards and favicon fallbacks, copied into the build as they are |
| `design/` | The editable social-card layout and [image/export notes](design/README.md) |
| `lib/social.ts`, `lib/discovery.ts` | Shared link-preview and favicon metadata, structured data, and the generated `llms.txt` documentation directory |
| `lib/statcounter.ts` | The [Statcounter](https://statcounter.com) counter every page carries, with the project's id and security code. It counts each page a visitor opens, the docs' and spec's in-place page changes included, and its script loads only at ntasks.notice.cx, so a local build or preview counts no visit unless it is opened with JavaScript off |
| `wrangler.jsonc` | The Cloudflare Worker that serves the build. It has no script, only the files |

## Commands

From the repository root:

```sh
pnpm site:build   # build into apps/site/dist/, then check every link
pnpm site:dev     # serve the docs at http://localhost:5173/docs/ while you edit docs/
pnpm --filter @ntasks/site run dev:spec   # serve the spec at http://localhost:5173/spec/ while you edit spec/
```

`pnpm --filter @ntasks/site run dev:landing` serves the landing page while you
edit it. To see the built site as Cloudflare serves it, run
`pnpm --filter @ntasks/site run preview` after a build: it starts
`wrangler dev` on the files in `dist/`, locally, with no Cloudflare account.

## How docs/ renders

The pages stay readable on GitHub, so the site adapts them as it renders:

- **The sidebar** is [`docs/index.md`](../../docs/index.md): each `##`
  heading is a group, and each linked page under it an entry, in order. A
  page `docs/index.md` does not list still builds, under **More**. List a new
  page there.
- **Headings** get the ids GitHub gives them, so a link such as
  `sign-in.md#the-setup-page` reaches the same heading on both.
- **A relative link that leaves `docs/`**, such as `../SECURITY.md` or
  `../workers/api/src/`, opens that file or folder on GitHub, on `main`.
- **A `<picture>` with a `prefers-color-scheme: dark` source** becomes two
  images, and the site shows the one for its own theme switch.
- **A `mermaid` code block** is drawn as a diagram in the page's theme.

`pnpm site:build` fails on a link to a page, heading, image or repository
file that does not exist. CI runs it on every pull request.

## Publishing

A Workers Builds connection on the `ntasks-site` Worker publishes the site on
every push to `main` that changes `apps/site/`, `docs/`, `spec/` or
`pnpm-lock.yaml`. It is separate from the app's connection, which reads the
`wrangler.jsonc` at the repository root. Its settings, in the Cloudflare
dashboard under the Worker's **Settings → Build**:

| Setting | Value |
|---|---|
| Git repository | `notice-cx/Ntasks`, branch `main` |
| Root directory | `apps/site` |
| Build command | `pnpm install --frozen-lockfile && pnpm build:site` |
| Deploy command | `npx wrangler deploy` |
| Build watch paths, include | `apps/site/*`, `docs/*`, `spec/*`, `pnpm-lock.yaml` |

Each build shows on its commit as the check `Workers Builds: ntasks-site`. A
failing check means the site still serves the previous build.

To publish by hand, such as after a failed build, run `wrangler deploy` from
this folder on a clean checkout of `main`'s latest commit. The owner
approved this publish for the site once; any other command that reaches
Cloudflare still needs approval each time
([AGENTS.md](../../AGENTS.md#never-without-the-owners-explicit-approval)):

```sh
pnpm site:build
pnpm --filter @ntasks/site exec wrangler deploy
```

The first deploy creates the Worker `ntasks-site` and, from the `routes`
entry in `wrangler.jsonc`, the custom domain `ntasks.notice.cx`: Cloudflare
adds its DNS record and certificate in the `notice.cx` zone, which must be on
the same Cloudflare account. The site is served only there, never at a
`workers.dev` address.
