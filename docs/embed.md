# Embed the web app

The npm package [`@notice-cx/ntasks-ui`](../packages/ui/README.md) holds the web app's
pages as one React component, `NtasksApp`. Another site renders it inside one
of its own pages: the board, a task's page, Focus, Live and Settings, with its
Projects and Members tabs, appear under an address the site picks, and every read and write
goes to an Ntasks as the person signed in, never as the site. The Worker's
own web app ([`apps/web`](../apps/web/README.md)) renders the same component
on the Worker's origin.

## What a host does

1. **Signs the person in to the Ntasks.** The host is a connected app of the
   Ntasks: an owner registers it, and the person signs in to the Ntasks from
   the host's page, which receives their access token
   ([Connected apps](sign-in.md#connected-apps)). The host passes the token
   to the pages; it never vouches for the person with a credential of its
   own. A browser lets the host's page read the Ntasks's answers,
   `/api/version` included, and send writes only from the origin of an
   enabled connected app's redirect address
   ([Calls from the app's page](sign-in.md#calls-from-the-apps-page)). That
   rule binds browsers, not the token: the token works from anywhere, so the
   host keeps it as it keeps any credential.
2. **Checks the version.** `GET /api/version` on the Ntasks answers
   `{ version, oldest }` before anyone signs in. The pages work when
   `oldest <= API_VERSION <= version`, with the package's `API_VERSION`. A
   lower `version` means the Ntasks lacks something the pages read and needs
   an update; a higher `oldest` means it no longer answers this version of the
   package, which needs an update ([Versions](api.md#versions)).
3. **Renders the app** at the route `<basePath>/*` of its React Router, with
   the package's stylesheet:

```tsx
import { NtasksApp } from '@notice-cx/ntasks-ui';
import '@notice-cx/ntasks-ui/styles.css';

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
development server and tests can use ([`@notice-cx/ntasks-ui`](../packages/ui/README.md#use-it-in-a-page)).

## Releases

`@notice-cx/ntasks-ui` is published to npm from this repository when the owner pushes
a `ui-v<version>` tag ([Releasing](../packages/ui/README.md#releasing)).
