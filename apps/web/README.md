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
| `/tasks` | The board: the decisions waiting on you, then every task, with filters that are part of the address. `?new=1` opens the composer. |
| `/tasks/:id` | One task: its state, description, Done when, links, epic tasks and history, with its facts editable in place. |
| `/tasks/focus` | Your decisions one at a time, answered with a press or a key: an option's letter, Enter to approve, → to skip. |

The pages are the task pages of NoticeOS's Tower, carried over with its design
tokens (`src/index.css`) and its copy tests (`test/ui-lexicon.test.ts` and
`test/ui-noun.test.ts`).

An answer to a decision waits five seconds before it is sent, with Undo in the
toast, because an answer cannot be reversed once the server records it
(`src/lib/answer-queue.ts`).

## Where the data comes from

Every read and write goes through one module, `src/api/client.ts`. It speaks
the `/api/tasks` format NoticeOS's Tower reads, which the Ntasks API keeps.

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
