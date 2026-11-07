# Sign-in

Ntasks is reachable from the internet, so every API and MCP call names who
sends it, and the Worker checks that sender before it does anything else.
This page describes who can sign in, how, which workspaces and projects each
one reaches, and how to cut one off. It is written for contributors and for
whoever deploys Ntasks. Read [Architecture](architecture.md) first for where
sign-in sits and what a workspace is.

| Part | Where |
|---|---|
| Sign-in routes | [`workers/api/src/access/routes.ts`](../workers/api/src/access/routes.ts) |
| The sign-in, agent approval and expired-link pages, and their look | [`workers/api/src/access/pages.ts`](../workers/api/src/access/pages.ts), [`page-look.ts`](../workers/api/src/access/page-look.ts) |
| The token verifier | [`workers/api/src/access/verify.ts`](../workers/api/src/access/verify.ts) |
| What a caller may do | [`workers/api/src/access/principal.ts`](../workers/api/src/access/principal.ts) |
| Members and invitations | [`workers/api/src/access/members.ts`](../workers/api/src/access/members.ts) |
| Scopes, paths and discovery documents | [`workers/api/src/access/protocol.ts`](../workers/api/src/access/protocol.ts) |
| Workspaces: the one a request reaches, and the sender as its store sees it | [`workers/api/src/workspaces.ts`](../workers/api/src/workspaces.ts) |
| Tables | [`workers/api/migrations/`](../workers/api/migrations/) |
| Tests | [`workers/api/test/access/`](../workers/api/test/access/) |

Sign-in runs on [Better Auth](https://www.better-auth.com), an open-source
sign-in library, with its OAuth provider plugin, on the Worker's D1 database.

## Who can call Ntasks

| Caller | How it signs in | What it reaches |
|---|---|---|
| **A person**, in a browser | Signs in with GitHub on `/sign-in`. The GitHub account must be a deployment admin (its numeric id is in `OWNER_GITHUB_IDS`), a member of a workspace, or invited to one ([below](#members-and-invitations)). | Each workspace they belong to, as its owner or a member. In it, every project, to read and change tasks (`tasks:read`, `tasks:write`), and a person's decisions (`tasks:decide`). An owner also holds the backup of the workspace's store (`tasks:backup`), a load into its empty store (`tasks:restore`), and creating its projects (`workspace:manage`). Only a person's own browser session counts as their decision. |
| **An AI agent**, such as an MCP client | OAuth 2.1, the sign-in method of [MCP's authorization specification](https://modelcontextprotocol.io/specification/draft/basic/authorization). A person approves the agent on `/agent-access` and chooses its projects among those of their workspaces. | The projects the person chose, to read (`tasks:read`) or to read and change (`tasks:write`) tasks, in each workspace the person still belongs to. |
| **A service**, such as a NoticeOS installation | A service credential a workspace's owner made, sent as a bearer token. | Its credential's one workspace: the projects named in the credential's grants, each to read or to read and change. A credential made with the backup choice also reads the workspace's whole store through the backup route (`tasks:backup`, [API](api.md#backing-up-the-whole-store)), and one made with the restore choice may load rows into that store while it is empty (`tasks:restore`, [API](api.md#loading-an-empty-store)); either needs no grants. |

GitHub user ids are numbers, such as `1001`, shown at
`https://api.github.com/users/<login>`. Ntasks allowlists the id, not the
login, because a login can be renamed and then taken by someone else.

A deployment admin creates workspaces (`POST /api/workspaces`,
[API](api.md#workspaces)) and is the owner of each one they create. An owner
invites other people by their GitHub username
([below](#members-and-invitations)). A request reaches one workspace: a
service its credential's, and a person or an agent the one it names in the
`x-ntasks-workspace` header or an MCP tool call's `workspace` argument, or
the only one it reaches.

An agent or a service may pass on an answer a person gave it, such as a
choice in a decision, but that is a relayed answer, not the person's own
decision. `mayDecide(principal)` is true only for a person's browser
session, so the API can record the two apart: only that session holds
`tasks:decide`, which the decision routes need, and an agent records an
answer it holds with `reconcile_task` ([API](api.md#recording-an-owner-answer)).
An agent's sign-in also names the person who approved it, so a comment that
person wrote counts as their own words when the agent cites it; a service
names no person.

## Settings

Sign-in reads five secrets. If any is missing or malformed, sign-in is off:
every sign-in path answers `503` with `{"error":"sign_in_not_configured"}`,
and every call that needs a signed-in sender is refused.

| Secret | Holds |
|---|---|
| `NTASKS_ORIGIN` | The address people and agents reach Ntasks at, such as `https://ntasks.example.com`, with no path or trailing slash. `https` is required, except `http://localhost` and `http://127.0.0.1` for local runs. A Worker on `workers.dev` is reached at `https://<Worker name>.<your subdomain>.workers.dev`. |
| `AUTH_SECRET` | A random value of at least 32 characters. It signs session cookies and sign-in state, and encrypts stored GitHub tokens and agents' client secrets. Make one with `openssl rand -base64 32`. Changing it signs everyone out, and an agent that registered with a client secret must register again. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | The GitHub OAuth app people sign in through. |
| `OWNER_GITHUB_IDS` | The GitHub user ids of the deployment's admins, separated by commas: the people who create workspaces, and who may sign in without belonging to one. |

The [Deploy to Cloudflare button](../README.md#deploy-your-own) asks for each
one, from the names in [`.dev.vars.example`](../.dev.vars.example), with the
descriptions under `cloudflare.bindings` in the root `package.json`. On a
deployment made another way, set each with `wrangler secret put <NAME>` from
the repository root. `wrangler deploy` refuses a Worker that lacks one of
them. For `pnpm dev`, copy `.dev.vars.example` to `.dev.vars` at the
repository root, which git ignores, and fill it in:

```sh
NTASKS_ORIGIN=http://localhost:8787
AUTH_SECRET=<the output of openssl rand -base64 32>
GITHUB_CLIENT_ID=<from your GitHub OAuth app>
GITHUB_CLIENT_SECRET=<from your GitHub OAuth app>
OWNER_GITHUB_IDS=<your GitHub user id>
```

### Register the GitHub OAuth app

Each address Ntasks runs at needs its own GitHub OAuth app, because GitHub
sends the browser back to one callback address. Register it before you press
the Deploy to Cloudflare button, which asks for its client ID and secret.

1. On GitHub, open Settings, then Developer settings, then OAuth Apps, and
   choose New OAuth App.
2. Set **Homepage URL** to the value of `NTASKS_ORIGIN`.
3. Set **Authorization callback URL** to `NTASKS_ORIGIN` followed by
   `/api/auth/callback/github`, such as
   `https://ntasks.example.com/api/auth/callback/github`.
4. Register the app, then generate a client secret. Put the client id and
   the secret in `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

Ntasks asks GitHub only for the account's profile and email address.

## How an AI agent connects

MCP clients follow these steps on their own; the person sees steps 5 and 6.

1. The agent calls the MCP endpoint, `/api/mcp`, with no token. The answer is
   `401` with a `WWW-Authenticate` header naming the resource metadata.
2. It reads `/.well-known/oauth-protected-resource/api/mcp`, which names the
   authorization server, `<origin>/api/auth`.
3. It reads `/.well-known/oauth-authorization-server/api/auth`, which lists
   the endpoints below.
4. It registers itself at `POST /api/auth/oauth2/register` (dynamic client
   registration, RFC 7591). Registration must ask for PKCE.
5. It sends the person's browser to `/api/auth/oauth2/authorize`. If they
   are not signed in, the browser goes to `/sign-in` first.
6. On `/agent-access` the person sees the agent's name and address and what
   it asks to do, chooses its projects among those of each workspace they
   belong to, and allows or denies it. Allowing records the project grants,
   each with its workspace, then the consent. The page reads the projects of
   each of the person's workspaces from that workspace's task store.
7. The agent exchanges the code for an access token and a refresh token at
   `POST /api/auth/oauth2/token`.
8. It calls the MCP endpoint with `Authorization: Bearer <access token>`.
   When the access token expires, after one hour, it uses the refresh token,
   which lasts 30 days.

Access tokens are opaque random values, stored only as their SHA-256 hash.
The Worker is both the authorization server and the only resource server,
and every call reads the database to see revocations and grants, so a
signed token would save no database read.

## Checking every request

The Worker signs every API and MCP request in with `signInAuthenticator(env)`
([`src/index.ts`](../workers/api/src/index.ts)). `authenticate(request)`
returns the sender: its id, its actor name, and each workspace it reaches
(`reachesOf`), with its role there for a person, and its scopes and projects
there: `all` for a person, or each project an agent or a service was
granted. `challenge(request)` answers a request it refused. The Worker then
picks the request's workspace (`chooseWorkspace` in
[`src/workspaces.ts`](../workers/api/src/workspaces.ts)) and hands the
workspace's store the sender scoped to it (`scopedTo`): its id, name, and its
scopes and projects in that workspace alone. The API checks each project a
request names with `mayReach` in [`src/auth.ts`](../workers/api/src/auth.ts),
and answers a workspace or a project the sender cannot reach as if it did not
exist. None of these steps reads the request's body. Underneath,
`verifyRequest(request, env)` returns the sender as a `Principal`, or a
refusal that `refusal()` turns into the answer.

| The request carries | The verifier checks, in one D1 query |
|---|---|
| A session cookie | The signature, an unexpired session, and that the person is still a deployment admin or a member of a workspace. The same query reads the person's memberships, with each workspace's name. A change (`POST` and other methods that are not reads) must also come from `NTASKS_ORIGIN`, shown by its `Origin` header, so another site cannot submit a form with the person's cookie. |
| An OAuth access token | That it is unexpired and unrevoked, its client is enabled, the person's consent still exists, the person is still a deployment admin or a member of a workspace, and it was issued for the MCP endpoint. Its projects are the person's grants, by workspace, lowered to read when the token has only `tasks:read`; a grant in a workspace the person no longer belongs to reaches nothing. |
| A service credential | That it exists and is not revoked, and that its secret matches the stored hash, compared in constant time. The same query reads its workspace's name. |

So picking the workspace takes no D1 query beyond the one that signs the
sender in; that query reads about two more rows for each of the sender's
memberships or grants.

The verifier never builds Better Auth, which costs CPU time; only the
sign-in routes do. A refused request gets:

| Reason | Answer |
|---|---|
| No credential | `401` with a bearer challenge |
| A malformed, unknown, expired or revoked credential | `401` with `error="invalid_token"` in the challenge |
| A cookie-signed change from another site | `403` with `{"error":"cross_site_request"}` |
| Sign-in is off | `503` with `{"error":"sign_in_not_configured"}` |

`principal.id` is stable and opaque, such as `service:<credential id>`; the
API passes it to the task engine as the retry principal. `actorOf(principal,
model)` makes the engine's `Actor`, the name the task's history records:
`agent:` followed by the agent's registered name; `service:` followed by the
credential's name, and by `/<agent>` when the service names the agent it acts
for ([below](#a-service-acting-for-its-agents)); or the person's GitHub name, with `person:` in front when
that name itself starts with `agent:`, `service:` or `person:`. An agent
chooses its own name when it registers and could choose a person's, so an
actor that starts with `agent:` is always an agent and one that starts with
`service:` always a service.

## A service acting for its agents

One service credential can serve several agents, as a NoticeOS installation
serves the agents on one machine. To record which agent each request is for,
the service sends that agent's name in the `x-ntasks-on-behalf-of` header,
with its credential:

```http
Authorization: Bearer ntasks_service.<id>.<secret>
x-ntasks-on-behalf-of: outcome-review-filer
```

- The name is 1 to 128 of the characters `A-Z a-z 0-9 . _ : / -`.
- The actor the task's history records, and the assignee a claim sets,
  become `service:<credential name>/<agent name>`, so "assigned to me" means
  that agent's tasks.
- The retry principal becomes `service:<credential id>/<agent name>`, so two
  agents that send the same idempotency key make two writes.
- The name grants nothing: the request reaches the credential's projects, no
  more.
- A name with another character, or longer than 128 characters, gets `400`
  with `{"error":"invalid_request"}` and a sentence saying why. So does a name
  that would make the actor or the retry principal longer than 128
  characters, the engine's limit. Names of up to 55 characters always fit.
- People and OAuth agents sign in as themselves; the header is ignored for
  them, whatever its value.

## Members and invitations

A GitHub account may sign in when one of these holds:

- it is a deployment admin: its numeric id is in `OWNER_GITHUB_IDS`;
- it is already a member of a workspace;
- its GitHub login holds an open invitation to a workspace: one nobody has
  accepted, no owner has revoked and that is less than 7 days old.

Any other account is sent back to `/sign-in?error=not_invited`, and the page
shows the reason: the account is not a member of a workspace here, and a
workspace owner can invite its GitHub username. A refused sign-in gets no
session, and creates no account unless its invitation went while it ran.

An owner of a workspace manages its people with the routes below, naming
the workspace in the `x-ntasks-workspace` header when they belong to
several.

- **Inviting.** `POST /api/access/invitations` with
  `{"githubLogin": "...", "role": "member"}` invites a GitHub login as a
  `member` or an `owner`; `role` is `member` when left out. Spaces and a
  leading `@` are dropped, and the login is compared without case. A
  workspace holds at most one open invitation for a login. An invitation
  admits its login for 7 days (`expires_at`); after that it admits nobody,
  leaves the list, and the login can be invited again.
- **Joining.** When the account that holds the login next signs in with
  GitHub, each open invitation for that login becomes a membership with the
  invitation's role, bound to the account's user, and the invitation records
  who accepted it (`accepted_by`) and when (`accepted_at`). A person who is
  already a member keeps their membership, and an invitation as owner makes
  them an owner. A person who is signed in already joins by signing out and
  in again.
- **Renamed logins.** The login is matched only at sign-in, against the
  profile GitHub returns then. After that the membership belongs to the
  account, so renaming the login, or someone else taking the old one,
  changes nothing. Until then the invitation admits whoever holds the login
  on GitHub when they sign in, for at most its 7 days, so revoke an
  invitation that is no longer wanted.
- **Revoking.** `POST /api/access/invitations/<invitation id>/revoke`
  revokes an open invitation. A revoked invitation admits nobody.
- **Removing.** `POST /api/access/members/<user id>/remove` removes a member.
  From their next request, their session and their agents no longer reach
  the workspace; they keep their other workspaces. In the same step, so that
  nothing they control brings them back:
  - the project grants their agents hold in the workspace are deleted, and an
    agent left with no grant anywhere loses its approval, so inviting them
    again shows each agent's approval page again;
  - the open invitations they sent in the workspace are revoked, and so are
    open invitations there for a login they joined under;
  - the service credentials they made in the workspace are revoked: they hold
    those tokens. Make new ones for services that still need access.
- **The last owner.** A workspace keeps at least one owner: removing its
  only owner gets `409` with `{"error":"last_owner"}`. No route changes a
  role; to make a member an owner, invite their login as `owner`, and it
  takes effect when they next sign in.

A person who is neither a deployment admin nor a member of any workspace is
signed out: their sessions and their agents are refused, and they sign in
again only with a new invitation.

## Cutting a caller off

Each of these takes effect at the caller's next request.

| To cut off | Do this |
|---|---|
| An agent | `POST /api/access/agents/<client id>/revoke`, signed in as the person who approved it. Its project grants in every workspace and the person's consent are deleted, and its access and refresh tokens are marked revoked. |
| A service | `POST /api/access/services/<credential id>/revoke`, signed in as the owner of the credential's workspace, naming that workspace when they belong to several. |
| A person, from one workspace | `POST /api/access/members/<user id>/remove`, signed in as an owner of the workspace ([above](#members-and-invitations)). Their session and their agents stop reaching it. |
| A person, from all of Ntasks | Remove them from each of their workspaces, and their GitHub id from `OWNER_GITHUB_IDS` when it is there. Their sessions and the agents they approved are refused. |
| One token, from the agent itself | `POST /api/auth/oauth2/revoke` ([RFC 7009](https://www.rfc-editor.org/rfc/rfc7009)). |

## Routes

Every path below is in `assets.run_worker_first` in
[`wrangler.jsonc`](../wrangler.jsonc). Three limits, each
Cloudflare's rate limiting binding, answer `429` once reached:

- Every sign-in path but the resource metadata takes about 30 requests a
  minute from one address (`SIGN_IN_LIMIT`).
- Agent registration takes about 3 requests a minute from one address
  (`REGISTER_ADDRESS_LIMIT`), and about 10 a minute from all addresses
  together (`REGISTER_LIMIT`). A registration refused for its address does
  not count toward the shared limit, so one address cannot use all of it.
  Anyone may register, and each registration writes to D1; on the free plan,
  reaching the daily write limit stops every query until 00:00 UTC. A
  caller with several addresses can still use up the shared limit, and then
  every new agent's registration gets `429` until the minute passes. That is
  the cost of the limit: a minute without new registrations instead of a day
  without the database. Agents already registered are not affected.

These limits are approximate. Cloudflare counts each one separately in each
of its locations, and a location can let a few more requests through before
it refuses, so registrations from many locations can add up to more than 10
a minute in all.

So agent registration also has a daily budget that holds across every
location: at most 100 agents register in one UTC day
(`REGISTRATIONS_PER_DAY` in `src/access/grants.ts`). The count is kept in D1,
in `access_registration_days`. A registration takes its place in the count
before the client is created, in one statement that checks and counts, so
registrations arriving at once never take more than the budget. Every
registration that gets that far counts, whether or not it then succeeds, so
failed attempts cannot cause more writes than the budget allows. Once it is
spent, registration answers `429` with `{"error":"registration_budget_spent"}`
and a `Retry-After` of the seconds until 00:00 UTC, and writes nothing. A
registration writes a handful of rows, so the budget keeps registrations to
well under 1% of the free plan's 100,000 rows written a day.

Since anyone may register, someone can spend the day's budget on purpose.
New agents then cannot register until 00:00 UTC; agents already registered,
and people's own sign-in, keep working.

| Route | Answer |
|---|---|
| `GET /.well-known/oauth-protected-resource/api/mcp` | The MCP endpoint's resource metadata (RFC 9728) |
| `GET /.well-known/oauth-authorization-server/api/auth`, `GET /.well-known/oauth-authorization-server` | The authorization server metadata (RFC 8414) |
| `GET /api/auth/oauth2/authorize`, `POST /api/auth/oauth2/token`, `POST /api/auth/oauth2/register`, `POST /api/auth/oauth2/revoke` | OAuth 2.1, answered by Better Auth |
| `GET /api/auth/callback/github` | Where GitHub sends the browser back after sign-in |
| `POST /api/auth/sign-out` | Ends the browser session |
| Any other path under `/api/auth/` | `404`: the library's other routes, such as client administration, stay private |
| `GET /sign-in`, `POST /sign-in` | The sign-in page, and its Sign in with GitHub and Sign out buttons |
| `GET /agent-access`, `POST /agent-access` | The page where a person allows or denies an agent |
| `GET /api/access/me` | Who the request is from: `kind`, `name`, `deploymentAdmin` (whether a person's GitHub id is in `OWNER_GITHUB_IDS`; false for an agent or a service) and `projects`: `all` for a person, or each project an agent or a service was granted, as `{ workspaceId, projectId, access }` |
| `GET /api/access/agents` | The person's connected agents, with their grants, each as `{ workspaceId, projectId, access }` |
| `POST /api/access/agents/<client id>/revoke` | Revokes an agent |
| `GET /api/access/services` | The workspace's service credentials, without their secrets |
| `POST /api/access/services` | Makes a credential in the workspace from `{"name": "...", "grants": [{"projectId": "...", "access": "read"}]}`, with `"backup": true`, one that may also read the backup route, and with `"restore": true`, one that may load the empty store; such a credential may leave `grants` out. Every grant names a project of the workspace, and the name is the credential's alone in the workspace. The answer holds its token, `ntasks_service.<id>.<secret>`, which is never shown again. Neither choice changes after. |
| `POST /api/access/services/<credential id>/revoke` | Revokes a credential of the workspace |
| `GET /api/access/members` | `{ members, invitations }`: the workspace's members, by name, each as `{ userId, name, githubLogin, role }`, where `githubLogin` is the login the member was invited under, or `null` for one who joined without an invitation, such as the workspace's creator; and its open invitations that have not expired, newest first, each as `{ invitationId, githubLogin, role, createdAt, expiresAt }` |
| `POST /api/access/invitations` | Invites a GitHub login to the workspace from `{"githubLogin": "...", "role": "member"}` and answers `201` with `{ invitation }`, shaped as `GET /api/access/members` lists it |
| `POST /api/access/invitations/<invitation id>/revoke` | Revokes an open invitation of the workspace: `{ "revoked": true }` |
| `POST /api/access/members/<user id>/remove` | Removes a member of the workspace and their agents' grants there: `{ "removed": true }` |
| `GET /api/workspaces`, `POST /api/workspaces` | The workspaces the sender reaches, and a new one a deployment admin creates ([API](api.md#workspaces)) |

Only a person's browser session may use the `/api/access/` routes that list,
make or revoke; an agent or a service gets `403` with `owner_only`. The
service credential, member and invitation routes act in the request's
workspace: the one the `x-ntasks-workspace` header names, or the person's
only one. Only its owners may use them. A refusal of these routes is JSON
with `error`, the rule that refused, and `detail`, a sentence saying why; a
refusal about one body field names it in `field`.

| Answer | When |
|---|---|
| `400` with `workspace_required` | The person belongs to several workspaces and the request names none. |
| `403` with `owner_only` | The sender is an agent or a service, or a member who is not an owner of the workspace. |
| `400` with `invalid_request` | The body is not a JSON object, holds an unknown field, or a field is malformed: `githubLogin` is not a GitHub login, or `role` is not `owner` or `member`. |
| `404` with `not_found` | The workspace has no such open invitation, or no such member. |
| `409` with `invitation_exists` | The login already has an open invitation to the workspace (`field` is `githubLogin`). |
| `409` with `last_owner` | The member to remove is the workspace's only owner. |

A refusal of a service credential's body, such as an unknown project, holds
its sentence in `message` instead of `detail`.

## Tables

| Table | Holds |
|---|---|
| `auth_user`, `auth_session`, `auth_account`, `auth_verification` | Better Auth's people, browser sessions, GitHub accounts and sign-in state. The GitHub token from sign-in is stored encrypted. |
| `auth_oauth_client`, `auth_oauth_consent`, `auth_oauth_access_token`, `auth_oauth_refresh_token` | The OAuth provider's registered agents, people's consents, and tokens stored as hashes |
| `auth_oauth_resource`, `auth_oauth_client_resource`, `auth_oauth_client_assertion` | The MCP endpoint as a protected resource, and other OAuth provider records |
| `workspaces` | Each workspace: `id`, a lowercase UUID, `name`, `created_by` and `created_at` |
| `workspace_members` | Who belongs to each workspace: `workspace_id`, `user_id`, `role` (`owner` or `member`) and `created_at`, one row for each person in each workspace |
| `workspace_invitations` | A GitHub login invited to a workspace: `id`, `workspace_id`, `github_login`, `role`, `created_by`, `created_at`, and `accepted_by` and `accepted_at` once it became a membership, or `revoked_at`. A workspace has at most one open invitation for a login, compared without case. Sign-in looks up the open invitations of the account's login. |
| `access_agent_grants` | The projects each agent may reach for the person who approved it: `user_id`, `client_id`, `workspace_id`, `project_id`, `access` and `created_at` |
| `access_service_credentials`, `access_service_grants` | Service credentials, each in one workspace (`workspace_id`), with the SHA-256 of each secret, the backup and restore choices, and their projects. A name is unique within its workspace. |
| `access_registration_days` | How many agents registered on each UTC day, for the daily registration budget |

These tables are in D1; the tasks and projects are in the workspaces' task
stores, Durable Objects each with its own database. A task store holds no
sign-in data: it records the actor name and model the API passes it, and the
retry principal as an opaque string. D1 cannot reference a task store's
projects, so the grant tables hold a workspace's id and a project's id, and
the Worker checks that the project exists, by asking that workspace's task
store, before it records a grant. The approval page lists projects the same
way.
