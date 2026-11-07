# @ntasks/screenshots

Makes the pictures of the web app in the repository's README and in
[the design system](../../docs/design.md), in light and dark, from the web
app's invented example tasks (`apps/web/src/api/fixture-data.ts`).

```sh
pnpm screenshots          # every picture
pnpm screenshots design   # only the ones named: board, task, phone, design
```

Run it from the repository root after a change to a page the pictures show.
It writes WebP files to `docs/images/`:

| File | Shows |
|---|---|
| `board-light.webp`, `board-dark.webp` | The Tasks board, 1100 pixels wide: the sidebar, Waiting for you, then every group to Done |
| `task-light.webp`, `task-dark.webp` | The page of task `web-b2r6`, whose description uses headings, lists, a code block and a task-id link |
| `phone-light.webp`, `phone-dark.webp` | The Tasks board, 390 pixels wide |
| `design-light.webp`, `design-dark.webp` | The design gallery at `/design`, 1440 pixels wide and as tall as the page |

The desktop pictures are drawn at 1.5 times those sizes and the phone pictures
at twice, so their text stays sharp on a high-density screen at the width the
README shows them.

## What it needs

- Google Chrome or Chromium on this machine. The script looks in the usual
  places on macOS and Linux; set `CHROME_PATH` to use another.
- Port 5197 free: the script serves the web app there with Vite while it
  draws.

The script talks to the browser over the Chrome DevTools Protocol with Node's
own WebSocket. It adds no dependency, and CI never runs it, so CI never
downloads a browser. CI does run `test/`, which checks the protocol client and
the script's waits with a stand-in socket and no browser.

The web app serves its own fonts, so the pictures look the same on every
machine, apart from small differences in how each system draws text.
