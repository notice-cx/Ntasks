# @ntasks/screenshots

Makes the pictures of the web app in the repository's README, in light and
dark, from the web app's invented example tasks
(`apps/web/src/api/fixture-data.ts`).

```sh
pnpm screenshots
```

Run it from the repository root after a change to a page the pictures show.
It writes six WebP files to `docs/images/`:

| File | Shows |
|---|---|
| `board-light.webp`, `board-dark.webp` | The Tasks board, 1280 pixels wide: the decisions, then the first rows of the task list |
| `task-light.webp`, `task-dark.webp` | The page of task `web-b2r6`, whose description uses headings, lists, a code block and a task-id link |
| `phone-light.webp`, `phone-dark.webp` | The Tasks board, 390 pixels wide |

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

The pictures use the fonts this machine has: Inter when it is installed,
otherwise the system's sans-serif. Pictures made on another machine can differ
slightly.
