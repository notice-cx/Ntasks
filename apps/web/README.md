# @ntasks/web

The Ntasks web app, built with React, Vite and Tailwind CSS. `vite build`
writes it to `dist/`, and Cloudflare serves that folder as the Ntasks Worker's
static files: any page address with no file of its own returns `index.html`,
and the app shows the page.

The app links to its source code, as AGPL-3.0 section 13 requires of a copy
people use over a network. Keep that link in every version of the app.

## Pages

| Address | Shows |
|---|---|
| `/tasks` | The board: what waits for you first, answered on its row, then every task grouped by status (In progress, Open, Blocked, Parked, Done). The view (`?view=active`, `done` or `waiting`), the search and the filters are part of the address. `?new=1` opens the composer. |
| `/tasks/:id` | One task: its title, description, a decision's options, Done when, design, notes, links, epic tasks and activity, with a side panel of its facts. A fact this sign-in may change opens a menu of values; the others are plain words. |
| `/tasks/focus` | Your decisions one at a time, each on a card: an option's letter selects it, Enter answers or approves, → skips. |
| `/design` | The design system's gallery: every token, symbol and component, in light or dark. It reads no tasks and needs no sign-in. |

Every page sits in one frame (`src/App.tsx`): the sidebar
(`src/components/AppSidebar.tsx`) with Waiting for you, Tasks, Focus, each
project and each person or agent with open work, and the source-code link.
The frame reads every project's board once, for the sidebar's counts and the
page alike, and runs the one change feed (`BoardsProvider` in
`src/hooks/useBoard.tsx`). On any page, `C` opens the composer, `/` puts the
cursor in the board's search and `F` opens Focus.

The task pages are those of NoticeOS's Tower, carried over with its copy
tests (`test/ui-lexicon.test.ts` and `test/ui-noun.test.ts`). They draw in the
design system's tokens; its components are in `src/components/ui/` and its
rules in [the design system](../../docs/design.md).

An answer to a decision waits five seconds before it is sent, with Undo in the
toast, because an answer cannot be reversed once the server records it
(`src/lib/answer-queue.ts`).

## Task text

A task's description, Done when, notes, design and comments are Markdown,
drawn by `src/routes/tasks/task-markdown.tsx` with `react-markdown`: GitHub's
additions (tables, task-list checkboxes, strikethrough, bare links), code
blocks highlighted in a short list of languages, and a line break in the text
kept as a line break. People and agents write this text, so the page trusts
none of it:

- raw HTML is dropped, and a script's or style's contents with it;
- `rehype-sanitize`, with GitHub's rules, removes event-handler attributes,
  inline styles and any address that is not http(s), mailto or relative;
- a link to another site opens in a new tab with no opener and no referrer;
- an image on another site is not loaded; it shows as a link to the image.

A ticked box in Done when writes the text back with only that box changed.
`test/markdown.test.tsx` covers each case.

## Where the data comes from

Every read and write goes through one module, `src/api/client.ts`. It speaks
the `/api/tasks` format NoticeOS's Tower reads, which the Ntasks API keeps.
A person's answers go to the decision routes ([the API](../../docs/api.md#a-persons-decisions)):
Approve to `POST /api/gates/:id/resolve`, an option to `/choose`, Answer to
`/respond`, Close as on a question to `/dismiss`, and a disputed approval to
`/dispute`. Only a person signed in to the web app may send them; anyone
else gets `403` with `insufficient_scope`, and the app shows the server's own
sentence.

A visitor who is not signed in sees a Sign in step, which opens the Worker's
own sign-in page; a refused read is shown at once, never retried.
While a page is visible it asks the API's change feed every 30 seconds what
changed since the boards it shows (`src/hooks/useChangeFeed.ts`), and reads a
project's board again only when a change landed in that project; a poll that
finds nothing costs almost no database reads.
`test/worker-contract.test.ts` feeds the Worker's own task answers through the
board, so the two cannot drift apart unnoticed.

`src/api/fixture.ts` answers the same calls from invented tasks held in the
page. The development server and the tests use it, so the pages can be built
and checked without a running API. A production build never includes it.

## Commands

Run these from the repository root:

```sh
pnpm dev                              # the app served by the Worker, at http://localhost:8787
pnpm --filter @ntasks/web dev         # Vite's server alone, with invented tasks, at http://localhost:5173
pnpm --filter @ntasks/web test        # the pages' tests and the copy tests
pnpm --filter @ntasks/web build       # write the build to dist/
```
