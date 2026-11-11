# 12. The HTTP binding

Part of [the protocol](protocol.md). Draft, v0, 2026-11-10.

The HTTP binding is the set of JSON routes through which the server's own
interface and other programs reach a server. Each route below is one that
Ntasks serves today, mapped to the protocol's operations and conformance
levels. Ntasks's [API reference](../docs/api.md#the-http-routes) gives
every parameter, body and answer in full. The route paths and the
`x-ntasks-` header names are Ntasks's own
([OQ-22](open-questions.md#oq-22)).

## 12.1 Requests

| Part | Ntasks |
|---|---|
| Sign-in | A person's browser session, an agent's OAuth access token, or a service credential, as `Authorization: Bearer …` for the last two. A request with none gets `401` with a bearer challenge |
| Workspace | `x-ntasks-workspace: <workspace id>`; a sender that reaches one workspace may leave it out |
| A service acting for an agent | `x-ntasks-on-behalf-of: <agent name>`; the change is recorded as `service:<name>/<agent>` ([3.1](protocol.md#31-actor-and-provenance)) |
| Retries | `Idempotency-Key: <key>` on any write, a person's decisions included ([INV-3](protocol.md#inv-3)) |
| Bodies | One JSON object, sent as `application/json`, of at most 32 KB, with no key twice and no query. A browser may send a write only from the server's own origin |
| Answers | JSON, with `cache-control: no-store` |
| Query parameters | A read refuses one it does not take, or one given twice ([EXT-3](protocol.md#ext-3)) |

## 12.2 Routes by level

### Core

| Contract operation | Route | Body or parameters |
|---|---|---|
| List projects | `GET /api/tasks/projects` | none |
| List tasks | `GET /api/tasks` | `project`, optionally `status`, `closedDays` and `field.<key>`. Each task carries `ready` and, while it waits on a person, `proposalVersion` |
| List by label | `GET /api/tasks` with `label` | `project`, `label`, optionally `limit` and `after` |
| Search | `GET /api/tasks/search` | `q`, optionally `limit` |
| Read a task | `GET /api/tasks/:id` | `project` |
| Read history | `GET /api/tasks/:id/history` | `project`, optionally `limit` |
| Read the changes since | `GET /api/changes` | optionally `after`, `limit` and `project`. Every change is an event with a sequence number across the workspace |
| What the sender may do | `GET /api/tasks/capabilities` | none |
| File | `POST /api/tasks` | `projectId`, `title`, and the task's fields |
| Change, release, hand over, reopen | `PATCH /api/tasks/:id` | `projectId` and the fields to change. `assignee: ""` releases; a `status` on a closed task reopens it |
| Claim | `PATCH /api/tasks/:id` | `projectId` and `claim: true`, optionally `for` and `work` |
| Comment | `POST /api/tasks/:id/comments` | `projectId`, `text` |
| Close | `POST /api/tasks/:id/close` | `projectId`, `reason`, and optionally `resolution`, `duplicateOf`, `commit`, `pullRequest` and `link` |
| Move | `POST /api/tasks/move` | `tasks`, and `projectId`, `parent` or both, and optionally `withChildren` ([STATE-24](protocol.md#state-24)). A route under `/api/tasks/:id` whose path names a former id answers for the task in its project now |

Ntasks has no HTTP route that links two tasks, asks for an approval,
records a relayed answer or releases another holder's task; those are MCP
tools only ([OQ-23](open-questions.md#oq-23)).

### Human decisions and approvals

Only a person signed in to the server's own interface may call these
routes ([AUTH-1](protocol.md#auth-1), [AUTH-11](protocol.md#auth-11)). Any
other sender gets `403` with `insufficient_scope`, and nothing changes. Each
takes `proposalVersion`, the version the person's page showed, which an
acceptance requires and the others may leave out: when the proposal changed
since, the answer is refused with `409`, `task_refused` and
`field: "proposalVersion"`, and nothing is written.

#### A person's decisions

| Contract operation | Route | Body |
|---|---|---|
| Answer in words | `POST /api/tasks/:id/respond` | `projectId`, `response` |
| Pick an option | `POST /api/tasks/:id/choose` | `projectId`, `option` (`a` to `f`), optionally `note` |
| Dismiss | `POST /api/tasks/:id/dismiss` | `projectId`, optionally `reason`, `resolution` (any but `done`) and `duplicateOf` |
| Approve | `POST /api/gates/:id/resolve` | `projectId`, optionally `reason` |
| Mark a step of a request to do steps | `POST /api/gates/:id/steps` | `projectId`, `step` (its place, from 1), and at least one of `done`, `note` and `stuck` ([STATE-14](protocol.md#state-14)) |
| Accept as done | `POST /api/tasks/:id/accept` | `projectId`, `met` (the numbers of the criteria the person found met, `[]` when none is), `proposalVersion`, optionally `reason` ([STATE-15](protocol.md#state-15)) |
| Free a held task on the person's call | `POST /api/tasks/:id/release` | `projectId`, optionally `holder`, the holder the person's page showed ([AUTH-9](protocol.md#auth-9)) |
| Dispute a relayed approval or acceptance | `POST /api/tasks/:id/dispute` | `projectId` |

Each answers `{ task }`, the task as the decision left it. An answer, a
pick and an approval record the person as the answer's `recordedBy`, with
`relayed: false` ([3.6](protocol.md#36-decisions)). A dismissal closes the
task and records no answer, and a mark on a step records the person and the
time on the step.

### Delivery

| Contract operation | Route | Body |
|---|---|---|
| Close with a commit or pull request | `POST /api/tasks/:id/close` | `commit` or `pullRequest` with `resolution` `done` |
| Send a signal | `POST /api/delivery` | `repository`, `stage`, and at least one of `pullRequests` and `commits` |
| List by stage | `GET /api/tasks` with `stage` | `project`, `stage`, optionally `status=closed` and `closedDays` |
| Say whether a project deploys | `PATCH /api/tasks/projects` | `projectId`, `deploys`. Only the workspace's owner |

[Ntasks's API reference](../docs/api.md#delivery) has a GitHub Actions
workflow that sends both signals, and a
[receiver for GitHub's events](../docs/api.md#from-github) that
sends them from GitHub's own events, signed with a secret instead of a
sign-in. A deploy it receives also marks the projects of the tasks it names
as deploying, once for each project, before it moves them.

### Live work

| Contract operation | Route | Body |
|---|---|---|
| Record work in hand on a claim | `PATCH /api/tasks/:id` | `claim: true`, `for`, and `work` with the details `claim_task` takes |
| List by activity | `GET /api/tasks` with `activity` | `project`, and `activity`: one or more of `active`, `quiet` and `stalled`, separated by commas. The answer counts each group in `activities` ([STATE-21](protocol.md#state-21)) |
| Pin and unpin a comment | `POST /api/tasks/:id/comments` | `projectId`, `text`, and either or both of `pin: true`, which pins the new comment, and `unpin`, the ids of the task's pinned comments to unpin |

A task read answers its `for`, `work`, `lastActivityAt` and `activity`, as
of the answer's `readAt` ([STATE-20](protocol.md#state-20)), `pinned` on
each comment, and `parent`, its parent context, or null when it has no
parent ([STATE-17](protocol.md#state-17)). A claim answers the task alone, so a
claim's `overlaps` ([STATE-19](protocol.md#state-19)), recording work details
on a comment, claiming by pull request and the held-task list are MCP only.

### Outside the protocol

`GET /api/tasks/agent-stats`, the custom-field routes `GET /api/fields`,
`POST /api/fields` and `POST /api/fields/:key/retire`, the workspace and
member routes, `GET /api/backup` and the `/api/restore` routes are
Ntasks's own.

## 12.3 Refusals

Schema: [`refusal`](schemas/refusal.schema.json).

**HTTP-1.** <a id="http-1"></a>A refused request MUST change nothing, and
its body MUST carry an `error` code. It SHOULD carry a `detail` sentence a
person can read, and `field` naming the body field at fault when there is
one. Ntasks's refusals from a task route carry `detail`; its refusals at
sign-in (`401`, `403` `cross_site_request`) and of a method (`405`) carry
the code alone.

| Status and `error` | When |
|---|---|
| `400` `invalid_request` | A parameter, the body or a field is missing, unknown, repeated or out of range |
| `400` `workspace_required` | The sender reaches several workspaces and the request names none |
| `401` `unauthorized` | The request carries no credential. The `www-authenticate` header tells an MCP client where to sign in |
| `401` `invalid_token` | The credential is malformed, unknown, expired or revoked |
| `403` `insufficient_scope` | The sender lacks the scope the route needs, such as a decision from an agent or a service |
| `403` `cross_site_request` | A change signed in with a browser session has no `Origin` header, or one other than the server's, such as another site's page sends |
| `403` `forbidden` | The sender may read the project but not change it, or a change signed in with a bearer token carries an `Origin` other than the server's |
| `404` `not_found` | The workspace, the project or a task does not exist, or the sender does not reach it ([AUTH-10](protocol.md#auth-10)) |
| `405` `method_not_allowed` | The path does not take the method; the `allow` header names the ones it takes |
| `409` `task_refused` | The task's state refuses the write, such as a close of a task someone else holds |
| `409` `idempotency_conflict` | The `Idempotency-Key` was first used for a different write |
| `503` `unavailable` | The task kept changing while the write was made; nothing was written ([INV-4](protocol.md#inv-4)) |
| `503` `sign_in_not_configured` | The deployment's sign-in is not set up, so it refuses every request |
