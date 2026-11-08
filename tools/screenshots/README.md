# @ntasks/screenshots

Makes the pictures of the web app in the repository's README and in
[the design system](../../docs/design.md), and the animated walkthroughs of
its features, in light and dark, from the web app's invented example tasks
(`apps/web/src/api/fixture-data.ts`).

```sh
pnpm screenshots          # every still picture
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

## Walkthroughs

```sh
pnpm screenshots walkthroughs          # every walkthrough
pnpm screenshots walkthroughs decide   # only the ones named: decide, live-work, shipped, approve, setup
```

Each walkthrough is an animated WebP of one feature: a drawn cursor moves to
what a person would press and presses it, and the picture starts on the
whole page, then zooms in on the feature. They are written to `docs/images/`:

| Files | Shows |
|---|---|
| `walkthrough-decide-light.webp`, `walkthrough-decide-dark.webp` | The docs project's board. The cursor picks the recommended option of the decision `docs-r4s9` in Waiting for you; the row leaves the list, and `docs-k8f2`, which waited on it, moves from Blocked to Open, where pointing at it shows Claim |
| `walkthrough-live-work-light.webp`, `walkthrough-live-work-dark.webp` | The Tasks board's In progress row of `web-k3m9.2`, with the helper its holder works for and its last activity. The cursor opens it, and its page shows the assignee for the helper, the last activity, the next step, the branch and the pull request |
| `walkthrough-shipped-light.webp`, `walkthrough-shipped-dark.webp` | The Waiting for you view's Waiting for merge and Waiting for deploy groups, then the Done view: closed tasks marked Built, Merged and Live, and one marked No proof |
| `walkthrough-approve-light.webp`, `walkthrough-approve-dark.webp` | The approval `web-g7p2`, whose description names its action, environment, scope and verification. The cursor presses Approve, and the task shows it closed as Done with Approved. Then the approval `web-r2v9`, which Claude recorded for a person, with the person's words and its Dispute button |
| `walkthrough-setup-light.webp`, `walkthrough-setup-dark.webp` | The Worker's setup page of a new deployment: the cursor types into the AUTH_SECRET field, which shows the value masked, and presses Create the GitHub App. It ends on the press |

Every frame is 960 × 540 pixels. The camera, the part of the page a frame
shows, moves and zooms with easing, and Chrome draws that part of the page
at the scale it is shown, so zoomed text stays sharp. The script captures
15 frames a second, joins frames that do not change into one longer frame,
holds the last frame for 1.5 seconds, and loops. Each walkthrough lasts
between 5 and 9 seconds, and each file is under 1.5 MB.

The cursor is an arrow the script draws into the page; each of its moves and
presses is also sent to Chrome as mouse input at the same point, so the page
shows its hover states and reacts as it would to a person. The script leaves
out the time the page waits on something no frame needs, such as an answer's
five-second Undo window, and the next frame follows at once.

Chrome encodes each frame as WebP; `src/animated-webp.ts` joins the frames
into one animated WebP as the
[WebP container specification](https://developers.google.com/speed/webp/docs/riff_container)
lays it out. A frame after the first holds only the rectangle of pixels that
changed, and a frame the camera moves through is encoded at a lower quality,
since it shows for 1/15 of a second. After writing a file, the script
decodes it with Chrome's `ImageDecoder` and stops if Chrome does not read
every frame.

The `shipped` walkthrough first ticks "Changes go live by a deploy" for the
docs project on the Projects page, which no frame shows, so the docs
project's merged task waits for a deploy.

## What it needs

- Google Chrome or Chromium on this machine. The script looks in the usual
  places on macOS and Linux; set `CHROME_PATH` to use another.
- Port 5197 free: the script serves the web app there with Vite while it
  draws.

The script talks to the browser over the Chrome DevTools Protocol with Node's
own WebSocket. It adds no dependency, and CI never runs it, so CI never
downloads a browser. CI does run `test/`, which checks the protocol client and
the script's waits with a stand-in socket, and the animated WebP writer's
chunks and sizes with small invented frames, all with no browser.

The web app serves its own fonts, so the pictures look the same on every
machine, apart from small differences in how each system draws text.
