# @ntasks/web

The Ntasks web app: one page that renders [`@notice-cx/ntasks-ui`](../../packages/ui/README.md)
on the Worker's own origin, signed in with the Worker's session cookie.
`vite build` writes it to `dist/`, and Cloudflare serves that folder as the
Ntasks Worker's static files: any page address with no file of its own
returns `index.html`, and the page shows the app.

`src/shell.tsx` holds the page's addresses:

| Address | Shows |
|---|---|
| `/tasks` and everything under it | The workspace's task views, individual task pages, and Settings |
| `/projects/<project>` and `/projects/<project>/tasks` | The project's Overview and Tasks views |
| `/design` | The design system's gallery: every token, symbol and component, in light or dark. It reads no tasks and needs no sign-in. |
| `/live`, `/projects`, `/members`, `/settings` | The same page under `/tasks`, with the query and the fragment kept |
| Any other address | The board, at `/tasks` |

The Worker's own pages (sign-in, agent approval) load Inter from `/fonts/`,
where the build copies the files they name from the pinned
`@fontsource-variable/inter` package (`packages/ui/server-fonts.config.ts`).

The app links to its source code, as AGPL-3.0 section 13 requires of a copy
people use over a network. Keep that link in every version of the app.

## Commands

Run these from the repository root:

```sh
pnpm dev                                      # the app served by the Worker, at http://localhost:8787
pnpm --filter @ntasks/web test                # the addresses and the font copy
pnpm --filter "@ntasks/web..." run build      # @notice-cx/ntasks-ui, then this page, to dist/
```

The pages themselves, over invented tasks and without a running API, are
`pnpm --filter @notice-cx/ntasks-ui dev`.
