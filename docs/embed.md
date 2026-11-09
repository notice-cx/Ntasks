# Embed the web app

The npm package [`@ntasks/ui`](../packages/ui/README.md) holds the web app's
pages as one React component, `NtasksApp`. Another site renders it inside one
of its own pages: the board, a task's page, Focus, Live, Projects, Members and
Settings appear under an address the site picks, and every read and write
goes to an Ntasks as the person signed in, never as the site. The Worker's
own web app ([`apps/web`](../apps/web/README.md)) renders the same component
on the Worker's origin.

## What a host does

1. **Signs the person in to the Ntasks.** The person's access token comes
   from the Ntasks, to the host as one of its OAuth clients
   ([Sign-in](sign-in.md)). The host passes the token to the pages; it never
   vouches for the person with a credential of its own.
2. **Checks the version.** `GET /api/version` on the Ntasks answers
   `{ version, oldest }` before anyone signs in. When `version` is lower than
   the package's `API_VERSION`, the Ntasks lacks something the pages read and
   needs an update ([Versions](api.md#versions)).
3. **Renders the app** at the route `<basePath>/*` of its React Router, with
   the package's stylesheet:

```tsx
import { NtasksApp } from '@ntasks/ui';
import '@ntasks/ui/styles.css';

<Route
  path="/tasks/*"
  element={
    <NtasksApp
      apiOrigin="https://tasks.example.com"
      tokenSource={{ token: () => tokens.current(), signIn: () => tokens.signIn() }}
      basePath="/tasks"
    />
  }
/>;
```

The board is then at `/tasks` and a task at `/tasks/<id>`. The stylesheet
applies only inside the app's root element, `[data-ntasks]`, so the host's
page keeps its own styles. The package's README lists every prop, the
addresses, the token source, the styles and the invented tasks a host's
development server and tests can use ([`@ntasks/ui`](../packages/ui/README.md#use-it-in-a-page)).

## Releases

`@ntasks/ui` is published to npm from this repository when the owner pushes
a `ui-v<version>` tag ([Releasing](../packages/ui/README.md#releasing)).
