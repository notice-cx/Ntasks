# @ntasks/screenshots

Makes the pictures of the web app in the repository's README and in
[the design system](../../docs/design.md), in light and dark, from the web
app's invented example tasks (`apps/web/src/api/fixture-data.ts`).

```sh
pnpm screenshots          # every picture
pnpm screenshots design   # only the ones named: board, task, focus, phone, sign-in, agent-access, design
```

Run it from the repository root after a change to a page the pictures show.
It writes WebP files to `docs/images/`:

| File | Shows |
|---|---|
| `board-light.webp`, `board-dark.webp` | The Tasks board, 1100 pixels wide: the sidebar, Waiting for you, then every group to Done |
| `task-light.webp`, `task-dark.webp` | The page of task `web-b2r6`, 1100 pixels wide, whose description uses headings, lists, a code block and a task-id link |
| `focus-light.webp`, `focus-dark.webp` | Focus on the decision `web-d4x1`, 1100 pixels wide: its card with three options |
| `phone-light.webp`, `phone-dark.webp` | The Tasks board, 390 pixels wide |
| `sign-in-light.webp`, `sign-in-dark.webp` | The Worker's sign-in page, 560 pixels wide |
| `agent-access-light.webp`, `agent-access-dark.webp` | The Worker's agent approval page for an invented agent and the two example projects, 560 pixels wide |
| `design-light.webp`, `design-dark.webp` | The design gallery at `/design`, 1440 pixels wide and as tall as the page |

The desktop pictures are 1100 pixels wide so that their text stays readable
at the 800 pixels the README shows them. They are drawn at 1.5 times their
size, and the phone pictures at twice, so their text stays sharp on a
high-density screen.

The sign-in and approval pages are the Worker's, not the app's: the script
calls `workers/api/src/access/pages.ts` for their HTML and draws it in place
of the app's document, so the fonts they load come from the app's dev server
at the addresses the Worker's static files use.

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
