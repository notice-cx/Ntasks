# @ntasks/web

The Ntasks web app, built with React and Vite. `vite build` writes it to
`dist/`, and Cloudflare serves that folder as the Ntasks Worker's static
files: any page address with no file of its own returns `index.html`, and the
app shows the page.

The app links to its source code, as AGPL-3.0 section 13 requires of a copy
people use over a network. Keep that link in every version of the app.

## Commands

Run these from the repository root:

```sh
pnpm dev                          # the app served by the Worker, at http://localhost:8787
pnpm --filter @ntasks/web build   # write the build to dist/
pnpm --filter @ntasks/web dev     # Vite's dev server alone, at http://localhost:5173, without the Worker
```
