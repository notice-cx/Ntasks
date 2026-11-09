# Ntasks documentation

Ntasks is a task list that people and AI coding agents share. Your agents
pick up work, report progress and close tasks, recording proof such as a
commit or pull request, while you see who's working on what and answer
whatever needs you.

<!-- The docs site's sidebar lists the pages below, in this order and under
these headings (apps/site/lib/docs-index.ts). List a new page here. -->

## Start here

- [Why Ntasks](why-ntasks.md): the problems Ntasks solves, with their sources.
- [Concepts](concepts.md): projects, tasks, dependencies, claims, decisions
  and approvals, and how Ntasks differs from Beads.

## Run Ntasks

- [Deploy and run Ntasks](deploy.md): deploying to Cloudflare, the first run
  and local development.
- [Connect an agent](agents.md): the setup command, each agent by hand, and the
  Ntasks skill.
- [The web app](web-app.md): every page, with animated walkthroughs.
- [Embed the web app](embed.md): rendering the web app's pages inside another
  site's page with the npm package `@ntasks/ui`.

## Reference for contributors

- [Architecture](architecture.md): the parts, how a request is routed, the
  free-plan budget and the rules every change keeps.
- [The API](api.md): the MCP endpoint and its tools, and the HTTP routes.
- [Sign-in](sign-in.md): who can call Ntasks, the setup page, agents' OAuth
  and service credentials.
- [The task store](task-store.md): the database of each workspace and the
  engine contract.
- [Design system](design.md): the web app's tokens, symbols and components.
