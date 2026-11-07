# Sign-in

Ntasks is reachable from the internet, so every API and MCP call names who
sends it, and the Worker checks that sender before it does anything else.
This page describes who can sign in, how, what each one reaches, and how to
cut one off. It is written for contributors and for whoever deploys Ntasks.
Read [Architecture](architecture.md) first for where sign-in sits.

| Part | Where |
|---|---|
| Sign-in routes | [`workers/api/src/access/routes.ts`](../workers/api/src/access/routes.ts) |
| The sign-in, agent approval and expired-link pages, and their look | [`workers/api/src/access/pages.ts`](../workers/api/src/access/pages.ts), [`page-look.ts`](../workers/api/src/access/page-look.ts) |
| The token verifier | [`workers/api/src/access/verify.ts`](../workers/api/src/access/verify.ts) |
| What a caller may do | [`workers/api/src/access/principal.ts`](../workers/api/src/access/principal.ts) |
| Scopes, paths and discovery documents | [`workers/api/src/access/protocol.ts`](../workers/api/src/access/protocol.ts) |
| Tables | [`workers/api/migrations/0001_sign_in.sql`](../workers/api/migrations/0001_sign_in.sql) |
| Tests | [`workers/api/test/access/`](../workers/api/test/access/) |

Sign-in runs on [Better Auth](https://www.better-auth.com), an open-source
sign-in library, with its OAuth provider plugin, on the Worker's D1 database.

## Who can call Ntasks

| Caller | How it signs in | What it reaches |
|---|---|---|
| **The owner**, a person in a browser | Signs in with GitHub on `/sign-in`. The GitHub account's numeric id must be in `OWNER_GITHUB_IDS`. | Every project, the backup of the whole store (`tasks:backup`), a load into the empty store (`tasks:restore`), and a person's decisions (`tasks:decide`). Only the owner's own browser session counts as the owner's decision. |
| **An AI agent**, such as an MCP client | OAuth 2.1, the sign-in method of [MCP's authorization specification](https://modelcontextprotocol.io/specification/draft/basic/authorization). The owner approves the agent on `/agent-access` and chooses its projects. | The projects the owner chose, to read (`tasks:read`) or to read and change (`tasks:write`) tasks. |
| **A service**, such as a NoticeOS installation | A service credential the owner made, sent as a bearer token. | The projects named in the credential's grants, each to read or to read and change. A credential the owner made with the backup choice also reads the whole store through the backup route (`tasks:backup`, [API](api.md#backing-up-the-whole-store)), and one made with the restore choice may load rows into the store while it is empty (`tasks:restore`, [API](api.md#loading-an-empty-store)); either needs no grants. |

GitHub user ids are numbers, such as `1001`, shown at
`https://api.github.com/users/<login>`. Ntasks allowlists the id, not the
login, because a login can be renamed and then taken by someone else.

An agent or a service may pass on an answer the owner gave it, such as a
choice in a decision, but that is a relayed answer, not the owner's own
decision. `mayDecide(principal)` is true only for the owner's browser
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
| `NTASKS_ORIGIN` | The address people and agents reach Ntasks at, such as `https://ntasks.example.com`, with no path or trailing slash. `https` is required, except `http://localhost` and `http://127.0.0.1` for local runs. |
| `AUTH_SECRET` | A random value of at least 32 characters. It signs session cookies and sign-in state, and encrypts stored GitHub tokens and agents' client secrets. Make one with `openssl rand -base64 32`. Changing it signs everyone out, and an agent that registered with a client secret must register again. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | The GitHub OAuth app the owner signs in through. |
| `OWNER_GITHUB_IDS` | The GitHub user ids that may sign in, separated by commas. |

On a deployment, set each with `wrangler secret put <NAME>` from
`workers/api`. For `pnpm dev`, put them in `workers/api/.dev.vars`, which git
ignores:

```sh
NTASKS_ORIGIN=http://localhost:8787
AUTH_SECRET=<the output of openssl rand -base64 32>
GITHUB_CLIENT_ID=<from your GitHub OAuth app>
GITHUB_CLIENT_SECRET=<from your GitHub OAuth app>
OWNER_GITHUB_IDS=<your GitHub user id>
```

### Register the GitHub OAuth app

Each address Ntasks runs at needs its own GitHub OAuth app, because GitHub
sends the browser back to one callback address.

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

MCP clients follow these steps on their own; the owner sees steps 5 and 6.

1. The agent calls the MCP endpoint, `/api/mcp`, with no token. The answer is
   `401` with a `WWW-Authenticate` header naming the resource metadata.
2. It reads `/.well-known/oauth-protected-resource/api/mcp`, which names the
   authorization server, `<origin>/api/auth`.
3. It reads `/.well-known/oauth-authorization-server/api/auth`, which lists
   the endpoints below.
4. It registers itself at `POST /api/auth/oauth2/register` (dynamic client
   registration, RFC 7591). Registration must ask for PKCE.
5. It sends the owner's browser to `/api/auth/oauth2/authorize`. If the owner
   is not signed in, the browser goes to `/sign-in` first.
6. On `/agent-access` the owner sees the agent's name and address and what
   it asks to do, chooses its projects, and allows or denies it. Allowing
   records the project grants, then the consent.
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
returns the sender in the API's shape: its id, its actor name, its scopes and
its projects, `all` for the owner or each project an agent or a service was
granted. `challenge(request)` answers a request it refused. The API then
checks each project a request names with `mayReach` in
[`src/auth.ts`](../workers/api/src/auth.ts), and answers a project the sender
cannot reach as if it did not exist. Neither step reads the request's body.
Underneath, `verifyRequest(request, env)` returns the sender as a `Principal`,
or a refusal that `refusal()` turns into the answer.

| The request carries | The verifier checks, in one D1 query |
|---|---|
| A session cookie | The signature, an unexpired session, and that the person's GitHub id is still allowlisted. A change (`POST` and other methods that are not reads) must also come from `NTASKS_ORIGIN`, shown by its `Origin` header, so another site cannot submit a form with the owner's cookie. |
| An OAuth access token | That it is unexpired and unrevoked, its client is enabled, the owner's consent still exists, the owner is still allowlisted, and it was issued for the MCP endpoint. Its projects are the owner's grants, lowered to read when the token has only `tasks:read`. |
| A service credential | That it exists and is not revoked, and that its secret matches the stored hash, compared in constant time. |

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
for ([below](#a-service-acting-for-its-agents)); or the owner's GitHub name, with `person:` in front when
that name itself starts with `agent:`, `service:` or `person:`. An agent
chooses its own name when it registers and could choose the owner's, so an
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
- The owner and OAuth agents sign in as themselves; the header is ignored for
  them, whatever its value.

## Cutting a caller off

Each of these takes effect at the caller's next request.

| To cut off | Do this |
|---|---|
| An agent | `POST /api/access/agents/<client id>/revoke`, signed in as the owner. Its project grants and the owner's consent are deleted, and its access and refresh tokens are marked revoked. |
| A service | `POST /api/access/services/<credential id>/revoke`, signed in as the owner. |
| An owner | Remove their GitHub id from `OWNER_GITHUB_IDS`. Their sessions and the agents they approved are refused. |
| One token, from the agent itself | `POST /api/auth/oauth2/revoke` ([RFC 7009](https://www.rfc-editor.org/rfc/rfc7009)). |

## Routes

Every path below is in `assets.run_worker_first` in
[`wrangler.jsonc`](../workers/api/wrangler.jsonc). Three limits, each
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
and the owner's own sign-in, keep working.

| Route | Answer |
|---|---|
| `GET /.well-known/oauth-protected-resource/api/mcp` | The MCP endpoint's resource metadata (RFC 9728) |
| `GET /.well-known/oauth-authorization-server/api/auth`, `GET /.well-known/oauth-authorization-server` | The authorization server metadata (RFC 8414) |
| `GET /api/auth/oauth2/authorize`, `POST /api/auth/oauth2/token`, `POST /api/auth/oauth2/register`, `POST /api/auth/oauth2/revoke` | OAuth 2.1, answered by Better Auth |
| `GET /api/auth/callback/github` | Where GitHub sends the browser back after sign-in |
| `POST /api/auth/sign-out` | Ends the browser session |
| Any other path under `/api/auth/` | `404`: the library's other routes, such as client administration, stay private |
| `GET /sign-in`, `POST /sign-in` | The sign-in page, and its Sign in with GitHub and Sign out buttons |
| `GET /agent-access`, `POST /agent-access` | The page where the owner allows or denies an agent |
| `GET /api/access/me` | Who the request is from: `kind`, `name` and `projects` |
| `GET /api/access/agents` | The owner's connected agents, with their grants |
| `POST /api/access/agents/<client id>/revoke` | Revokes an agent |
| `GET /api/access/services` | The service credentials, without their secrets |
| `POST /api/access/services` | Makes a credential from `{"name": "...", "grants": [{"projectId": "...", "access": "read"}]}`, with `"backup": true`, one that may also read the backup route, and with `"restore": true`, one that may load the empty store; such a credential may leave `grants` out. The answer holds its token, `ntasks_service.<id>.<secret>`, which is never shown again. Neither choice changes after. |
| `POST /api/access/services/<credential id>/revoke` | Revokes a credential |

Only the owner's browser session may use the `/api/access/` routes that list,
make or revoke; an agent or a service gets `403` with `{"error":"owner_only"}`.

## Tables

| Table | Holds |
|---|---|
| `auth_user`, `auth_session`, `auth_account`, `auth_verification` | Better Auth's people, browser sessions, GitHub accounts and sign-in state. The GitHub token from sign-in is stored encrypted. |
| `auth_oauth_client`, `auth_oauth_consent`, `auth_oauth_access_token`, `auth_oauth_refresh_token` | The OAuth provider's registered agents, the owner's consents, and tokens stored as hashes |
| `auth_oauth_resource`, `auth_oauth_client_resource`, `auth_oauth_client_assertion` | The MCP endpoint as a protected resource, and other OAuth provider records |
| `access_agent_grants` | The projects each agent may reach for the owner who approved it |
| `access_service_credentials`, `access_service_grants` | Service credentials, with the SHA-256 of each secret, and their projects |
| `access_registration_days` | How many agents registered on each UTC day, for the daily registration budget |

These tables are in D1; the tasks and projects are in the task store, a
Durable Object with its own database. The task store holds no sign-in data:
it records the actor name and model the API passes it, and the retry
principal as an opaque string. D1 cannot reference the task store's
projects, so the grant tables hold a project's id, and the Worker checks
that the project exists, by asking the task store, before it records a
grant. The approval page lists projects the same way.
