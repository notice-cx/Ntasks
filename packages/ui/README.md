# @notice-cx/ntasks-ui

The Ntasks web app as a React component: the board, a task's page, Focus,
Live, Projects, Members and Settings. The Ntasks Worker serves it as its own
web app ([`apps/web`](../../apps/web/README.md)), and another site renders it
inside one of its own pages, where it reads and writes as the person signed
in.

## Use it in a page

```sh
npm install @notice-cx/ntasks-ui react react-dom react-router-dom
```

React 19 and React Router 7 are peer dependencies: the app uses the host's
copies, so it shares the host's router.

```tsx
import { NtasksApp, type TokenSource } from '@notice-cx/ntasks-ui';
import '@notice-cx/ntasks-ui/styles.css';

const person: TokenSource = {
  token: () => tokens.current(), // the signed-in person's access token, or null
  signIn: () => tokens.signIn(), // what Sign in does
};

<Route
  path="/tasks/*"
  element={<NtasksApp apiOrigin="https://tasks.example.com" tokenSource={person} basePath="/tasks" />}
/>;
```

| Prop | Default | What it sets |
|---|---|---|
| `apiOrigin` | the page's own origin | The Ntasks the pages read and write, such as `https://tasks.example.com` |
| `tokenSource` | `sessionCookie(apiOrigin)` | How each request says who is asking ([Signing in](#signing-in)) |
| `basePath` | `/tasks` | The board's address, below the site's root; every other page is under it ([Addresses](#addresses)) |
| `theme` | `system` | `light`, `dark`, or `system`, which follows the system's preference while the page is open |
| `api` | none | Calls to read and write through in place of `apiOrigin` and `tokenSource`, such as `createFixtureTasksApi()` ([Invented tasks](#invented-tasks)) |
| `onTitle` | none | Receives each page's title, such as `web-b2r6 · Fix the reset link — Ntasks`, in place of the app setting the document's title, so the host keeps its own tab title |

### Addresses

With `basePath="/tasks"`:

| Page | Address |
|---|---|
| The board | `/tasks` |
| A task | `/tasks/<id>`, such as `/tasks/web-b2r6` |
| Focus | `/tasks/focus` |
| Live | `/tasks/live` |
| Projects, Members, Settings | `/tasks/projects`, `/tasks/members`, `/tasks/settings` |

A task id always holds a hyphen, so it is never the name of another page.
An address under `basePath` that is none of these shows No page.

### Routing

Inside a React Router 7 router, render `NtasksApp` as the element of the
route `<basePath>/*`, as above. Its links and its navigation go through the
host's router and history, and the router's `basename` applies to them as to
the host's own links. Without a router, `NtasksApp` makes its own on the
page's history and matches `basePath` itself.

### Signing in

```ts
interface TokenSource {
  token(): string | null | Promise<string | null>;
  signIn: string | (() => void);
}
```

`token()` is asked before every request, and its answer goes in the
`authorization: Bearer <token>` header; null sends no header. It answers
from memory and refreshes the token itself. A write sent while the page
closes, such as an answer still in its Undo window, waits for it.

When a request answers 401, the pages show "Sign in to see your tasks" with
a Sign in button. A `signIn` string is opened as an address; a function is
called.

The default, `sessionCookie(apiOrigin)`, sends no token: the browser sends
the Ntasks session cookie to the Ntasks origin, and Sign in opens
`<apiOrigin>/sign-in`. Only a page served from the Ntasks origin has that
cookie. A host on another origin is a connected app of that Ntasks: an owner
registers it, and the person signs in to the Ntasks from the host's page and
the host gets their token
([Connected apps](../../docs/sign-in.md#connected-apps)).

Every request goes to `apiOrigin` with `credentials: 'same-origin'`, so the
browser sends no cookie to another origin. Besides `authorization` it sends
`content-type`, `idempotency-key` on writes and `x-ntasks-workspace`, which
an Ntasks allows from the origin of a connected app's redirect address
([Calls from the app's page](../../docs/sign-in.md#calls-from-the-apps-page)).

### The API version

`API_VERSION` is the version of the Ntasks HTTP API these pages are made
for. An Ntasks names its own version in the `x-ntasks-api-version` header of
every answer, and `GET /api/version` answers `{ version, oldest }` before
anyone signs in ([The API, Versions](../../docs/api.md#versions)). An Ntasks
whose `version` is lower than `API_VERSION` lacks something the pages read
and needs an update; one whose `oldest` is higher than `API_VERSION` no
longer answers this package's version. When the pages start reading an
addition, `API_VERSION` becomes the version main had once that addition
merged ([The version a client asks for](../../docs/api.md#the-version-a-client-asks-for)).

### Styles

Import `@notice-cx/ntasks-ui/styles.css` once. Every rule in it applies only inside the
app's root element, `<div data-ntasks>`: the design system's tokens
([Design system](../../docs/design.md)), Tailwind's reset and the utilities
the pages use. The host's page keeps its own styles, and the app keeps its
own. Menus, popovers and the composer render inside the root, so they keep
its theme and tokens.

A host changes a token by setting the same variable on the root, in a
stylesheet loaded after this one: `[data-ntasks]` for the light theme and
`[data-ntasks].dark` for the dark theme.

```css
[data-ntasks] {
  --accent: #2745d4;
}
```

The reset and the utilities are in cascade layers, as Tailwind's are, so a
host's rule outside any layer that matches an element inside the root, such
as a global `button { … }`, takes precedence over them.

The stylesheet imports Inter and JetBrains Mono from their `@fontsource`
packages, which install with this one. The host's bundler copies the font
files, and a page downloads only the scripts it shows; the bundler must
resolve a CSS `@import` of a package, as Vite and webpack's `css-loader` do.

### Invented tasks

`@notice-cx/ntasks-ui/fixture` holds `createFixtureTasksApi()`: the calls answered from
invented tasks held in the page, in two workspaces, Example and Example Labs.
Every change lasts until the page reloads. Pass it as `api` in a development
server or a test:

```tsx
import { createFixtureTasksApi } from '@notice-cx/ntasks-ui/fixture';

<NtasksApp api={createFixtureTasksApi()} basePath="/tasks" />;
```

It holds invented data, so a page served to people imports it only in a
development build.

### Everything the package exports

| Import | Names |
|---|---|
| `@notice-cx/ntasks-ui` | `NtasksApp` and `NtasksAppProps`; `DesignGallery`, the design system's gallery, which needs no router and no sign-in; `TokenSource` and `sessionCookie`; `API_VERSION`; the types `TasksApi` and `Theme` |
| `@notice-cx/ntasks-ui/fixture` | `createFixtureTasksApi` and `FixtureOptions` |
| `@notice-cx/ntasks-ui/styles.css` | The stylesheet |

The type declarations are written for TypeScript's `bundler` module
resolution, Vite's default.

## Pages

| Address under `/tasks` | Shows |
|---|---|
| `/tasks` | The board: what waits for you first, answered on its row, then every task grouped by status (In progress, Open, Blocked, Parked, Done). The view (`?view=active`, `done` or `waiting`), the search and the filters are part of the address. `?new=1` opens the composer. |
| `/tasks/:id` | One task: its title, description, a decision's options, Done when, design, notes, links, epic tasks and activity, with a side panel of its facts. A fact this sign-in may change opens a menu of values; the others are plain words. |
| `/tasks/focus` | Your decisions one at a time, each on a card: an option's letter selects it, Enter answers or approves, → skips. |
| `/tasks/live` | Every task in progress, grouped by its holder's last activity: Active (changed or commented on within the hour), Quiet (until the Stalled after choice: 4 hours, 1 day, 3 days or 1 week, kept in this browser) and Stalled (after it, or with nothing recorded, the five most recent first and the rest under Show more). Each row shows the next step, the pull request or else the branch, the helper, the holder and how long since their last change. Stalled changes nothing on the task (`src/lib/live.ts`). |
| `/tasks/projects` | The workspace's projects, each with its prefix and open tasks. An owner creates one with New project (`N`): Name and Prefix, both required. |
| `/tasks/members` | For an owner: the workspace's members and pending invitations. Invite (`I`) takes a GitHub username and a role; each invitation has Revoke and each member Remove. Anyone else sees neither. |
| `/tasks/settings` | The workspace's icon, name and ID, with Copy ID, and its connected apps. An owner edits the name and saves it, registers an app, copies its client ID and removes it; anyone else reads the name and revokes their own sign-in to an app. |

Every page opens in a workspace (`src/components/WorkspaceGate.tsx`): the
one chosen last in this browser, kept in local storage, else the first
`GET /api/workspaces` lists. A sign-in that reaches none sees one step
instead: a deployment admin (`deploymentAdmin` in `GET /api/access/me`)
creates a workspace and goes on to its Projects page; anyone else sees No
workspace. Opening another workspace sends an answer still in its Undo window
in the workspace it was given in, drops every read of the last workspace, and
draws the pages again.

Every page sits in one frame (`src/App.tsx`): the sidebar
(`src/components/AppSidebar.tsx`) with the workspace's icon and name, Waiting
for you, Tasks, Live with its count of active tasks, Focus, each project and
each person or agent with open work, those active within the hour first and
marked with a dot, then Projects, Members (for an owner), Settings and the
source-code link. With two or more workspaces, the name is a menu that
switches between them and opens Settings. A rename shows in the sidebar and
the menu at once. The frame reads every project's board once, for the
sidebar's counts and the page alike, and runs the one change feed
(`BoardsProvider` in `src/hooks/useBoard.tsx`). On any page, `C` opens the
composer, `/` puts the cursor in the board's search, `F` opens Focus and `L`
opens Live.

Every page draws with the design system's tokens and the components in
`src/components/ui/`; [the design system](../../docs/design.md) gives the
rules. `test/ui-lexicon.test.ts` and `test/ui-noun.test.ts` fail on an
internal word in the copy.

The Worker's own pages (sign-in, agent approval) are server-rendered HTML,
so they carry their own copy of the tokens
(`workers/api/src/access/page-look.ts`, which `test/design.test.tsx` checks
against `src/index.css`).

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

Every read and write goes through one module, `src/api/client.ts`, and
`src/api/connection.ts` sends its requests to `apiOrigin` with the token
source's token. It speaks the `/api/tasks` format NoticeOS's Tower reads,
which the Ntasks API keeps. A person's answers go to the decision routes
([the API](../../docs/api.md#a-persons-decisions)): Approve to
`POST /api/gates/:id/resolve`, an option to `/choose`, Answer to `/respond`,
Close as on a question to `/dismiss`, and a disputed approval to `/dispute`.
Only a person may send them; anyone else gets `403` with
`insufficient_scope`, and the app shows the server's own sentence.

Every call in a workspace names it in the `x-ntasks-workspace` header, and
takes the workspace selected when the call starts, so a write still running
after a switch lands where it began. The calls about the sign-in itself,
`GET /api/workspaces`, `POST /api/workspaces` and `GET /api/access/me`, name
none, and `PATCH /api/workspaces` names its workspace in its body. A refused
form shows the server's words under the field it is about: the refusal's
`field`, else the field its sentence starts with.

A refused read is shown at once, never retried. While a page is visible it
asks the API's change feed every 30 seconds what changed since the boards it
shows (`src/hooks/useChangeFeed.ts`), and reads a project's board again only
when a change landed in that project; a poll that finds nothing costs almost
no database reads. `test/worker-contract.test.ts` feeds the Worker's own task
answers through the board, so the two cannot drift apart unnoticed.

`src/api/fixture.ts` is `@notice-cx/ntasks-ui/fixture`'s source. In Example the
sign-in is an owner, and in Example Labs a member. The development server and
the tests use it, so the pages can be built and checked without a running
API.

## Commands

Run these from the repository root:

```sh
pnpm --filter @notice-cx/ntasks-ui dev           # the pages over invented tasks, at http://localhost:5173, with the gallery at /design
pnpm --filter @notice-cx/ntasks-ui test          # everything under test/: the pages, the copy rules and a host page over the source
pnpm --filter @notice-cx/ntasks-ui build         # dist/: index.js, fixture.js, ntasks-ui.css and types/
pnpm --filter @notice-cx/ntasks-ui check:host    # after the build: the packed package in an empty Vite and React project
```

`vite.config.ts` builds the package in Vite's library mode: one module per
entry and one for the code each page loads when it is first opened. The
dependencies stay out of the bundle, and the host installs them;
`@ntasks/domain`, the task model, is not published, so the bundle holds it.
`scope-styles.config.ts` scopes the stylesheet to `[data-ntasks]`, and
`scripts/declarations.ts` writes the type declarations, with the task model's
beside them. `scripts/check-host.ts` packs the package as npm would publish
it, installs the tarball from the file into a project made from `host/`, and
typechecks, builds and tests that project; CI runs it after `pnpm build`.

Inside this repository, the export condition `ntasks-source` names the
package's source, and `apps/web`'s typecheck and tests resolve with it, so
they need no build of the package first; its `vite build` takes the built
package. `publishConfig.exports` leaves the condition out of the published
manifest.

## Releasing

The package publishes to npm, at https://registry.npmjs.org, as
`@notice-cx/ntasks-ui`, under the owner's npm organization `notice-cx`.

A release is the owner approving the CI run of the release pull request,
merging the pull request, then pressing **Approve and deploy**. Agents never
approve, merge or turn on auto-merge for a release pull request.

After each push to `main`, the Release PRs workflow
(`.github/workflows/release-please.yml`) runs
[release-please](https://github.com/googleapis/release-please). It keeps one
release pull request, titled `chore: release main`, for this package and
the `ntasks` command together, so the two never conflict. It lists each package
with changes to release and its next version, and releases only those. While a
`feat`, `fix`, `perf` or `revert` commit or a breaking change made since this
package's last release changes a file under `packages/ui`, the pull request
includes it: it raises `version` in `package.json` and adds those commits to this
folder's `CHANGELOG.md`. Before 1.0.0, a `feat` commit or a breaking change
raises the minor version and any other commit the patch version
(`release-please-config.json`).

When the pull request lists `@notice-cx/ntasks-ui`, merging it creates the tag
`ui-v<version>` and its GitHub release, then starts the Release UI package
workflow (`.github/workflows/release-ui.yml`) on that tag. A pull request that
lists only `ntasks` starts no Release UI package run; its steps are in
[tools/cli](../../tools/cli/README.md#releasing). The workflow waits for the
owner to approve the `npm` environment. It then runs every check, the host
check, then `npm publish --provenance` of the tarball `pnpm pack` writes.

The owner's steps:

1. On the pull request `chore: release main`, open the
   **Files changed** tab, click **Awaiting approval** at the top right, then
   **Approve workflows to run**. GitHub holds the pull request's CI run until
   someone approves it, because a workflow, not a person, opened the pull
   request.
2. When its checks pass, click **Merge when ready**, then **Confirm merge when
   ready**, at the bottom of the **Conversation** tab.
3. When the pull request lists `@notice-cx/ntasks-ui`, its Release UI package
   run waits for review (GitHub emails the owner): open it, click **Review
   deployments**, tick **npm** and click **Approve and deploy**. When the pull
   request also releases `ntasks`, its Release run waits the same way.

When more changes reach `main` before the pull request merges, release-please
rebuilds it, and the new CI run waits for approval again: repeat step 1.

To run a failed or rejected publish again, open **Actions**, choose **Release
UI package**, click **Run workflow**, pick the tag `ui-v<version>` under **Use
workflow from** and click **Run workflow**. The workflow stops if it is run on
a branch, or on a tag that does not name the version in `package.json`.

The workflow signs in to npm with npm's trusted publisher for this repository
when the package has one, and otherwise with the `NPM_TOKEN` secret, as the
`ntasks` command's release does; the token must be allowed to publish to
`notice-cx`. The trusted publisher names the workflow file `release-ui.yml` and
the environment `npm`. The run that the Release PRs workflow starts is a run of
`release-ui.yml` itself, not a workflow it calls, so it matches. A trusted
publisher must allow `npm publish` as well as `npm stage publish`: npm sets a
new one to allow staging only, and the workflow publishes directly.
Publishing is the owner's step
([AGENTS.md](../../AGENTS.md#never-without-the-owners-explicit-approval)).

## License

AGPL-3.0-only, as all of Ntasks. The sidebar links to the source code, as
AGPL-3.0 section 13 requires of a modified copy people use over a network.
Keep that link in every version of the pages.
