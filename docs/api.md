# The API

The Worker answers under `/api` in two ways, both over the same task engine:

- **The MCP endpoint** at `/api/mcp` is for AI agents. The
  [Model Context Protocol](https://modelcontextprotocol.io) (MCP) is the
  standard way an agent calls the tools a server offers.
- **The HTTP routes** under `/api/tasks` and `/api/changes` are for the web
  app.

`/api/workspaces` lists the workspaces a sender reaches, creates one and
renames one ([below](#workspaces)). `/api/version` answers the API's version
([below](#versions)). Two more serve a workspace's store as a
whole: `/api/backup` hands it out for a backup
([below](#backing-up-the-whole-store)), and `/api/restore` loads an import or
a backup into an empty store ([below](#loading-an-empty-store)).

Both read tasks and change them: they file, claim, change, comment on and
close tasks, link one task to another and ask a person for an approval. A
repository's automation and the agents that merge and deploy say where a
closed task's change is: built, merged or live ([below](#delivery)). A
person signed in to the web app makes their own decisions through the HTTP
routes: answering a task that waits on them, choosing one of its options,
declining it, approving an approval and disputing an approval an agent
recorded ([below](#a-persons-decisions)). An agent records an answer the
owner gave it elsewhere with `reconcile_task`
([below](#recording-an-owner-answer)). Both also give agent statistics: who
is working on what, and how fast work closes, by model.

Agents written for NoticeOS's task tools work against Ntasks unchanged: the
tool names, their arguments, the fields of their results and the sentences of
their refusals are the ones NoticeOS used, except that a refusal that sent a
person to NoticeOS's Tower sends them to the web app.
Ntasks adds optional arguments for what NoticeOS's tools lacked, such as a
task's notes; every argument NoticeOS's tools take is unchanged, and
[`write-tools.test.ts`](../workers/api/test/api/write-tools.test.ts) compares
the tools' schemas with NoticeOS's own. The HTTP routes take the bodies and
give the answers NoticeOS's task pages used, with the same additions. The
HTTP routes only add, and every answer under `/api` names their version
([below](#versions)), so a page made for one version of Ntasks keeps working
with every later one.

## Signing in

Every request under `/api` names who sends it, and the Worker checks it
before anything else. Each request reaches one workspace
([below](#workspaces)). In it, a sender holds **scopes**, the kinds of call it
may make: `tasks:read` to read and `tasks:write` to change tasks. A person
signed in to the web app also holds `tasks:decide`, which a person's
decisions need, and so does a person through a
[connected app](sign-in.md#connected-apps) they allowed it; no agent or
service holds it, whatever it was granted. A
workspace's owner also holds `tasks:backup`, `tasks:restore` and
`workspace:manage`, which creating a project and renaming the workspace need.

| Answer | When |
|---|---|
| `401` | Nobody is signed in. |
| `403` with `insufficient_scope` | The sender lacks the scope an HTTP route needs in the request's workspace. An MCP tool refuses the same call with a sentence instead. A decision from anyone but a person who holds `tasks:decide` says so in `detail`, which a client relaying a person's click can show as it is. |

A sender also reaches certain **projects** of the workspace. A person
reaches every project of a workspace they belong to; an agent or a service
reaches only the projects it was granted, each for reading or for writing
too. Lists and the change feed leave the other projects out, and a request
that names one gets the same answer as a project that does not exist, so a
sender learns nothing of projects it cannot reach.
For the same reason, a link between a task the sender reaches and a task in a
project it cannot reach is left out of every task the API answers with, and
of the task's history and the change feed. The other task's project is the
one whose prefix starts its id.
A write to a project granted for reading only is refused: `403` with
`forbidden` on an HTTP route, and a `refused: …` sentence from an MCP tool.

The Worker signs every request in as [Sign-in](sign-in.md) describes: a
person's browser session, a person's access token from a
[connected app](sign-in.md#connected-apps), an agent's OAuth access token,
or a service credential. A request with none, or with one that is invalid, revoked or
expired, gets `401` with a bearer challenge that tells an MCP client where to
sign in. The one exception is a request with no credential that names the
deployment's public workspace in the `x-ntasks-workspace` header: it reads
that workspace with `tasks:read` alone
([The public workspace](sign-in.md#the-public-workspace)). A service names the agent each request is for in the
`x-ntasks-on-behalf-of` header, and the request is recorded as that agent's
([A service acting for its agents](sign-in.md#a-service-acting-for-its-agents)). The sign-in routes under `/api/auth` and `/api/access` answer as
[Sign-in](sign-in.md#routes) describes.

A page at another origin reads the API's answers only when it is a
connected app's page, with its bearer token and without cookies
([Calls from the app's page](sign-in.md#calls-from-the-apps-page)). A
change sent from any other site's page is refused with `403`.

## Workspaces

One Ntasks deployment holds several **workspaces**, each the set of projects
its people, agents and services share, kept in its own task store
([Architecture](architecture.md#workspaces)). A workspace's id is a UUID.

Which workspace a request reaches:

| The sender | Reaches |
|---|---|
| A service | Its credential's one workspace. It may leave the header out; a header naming another workspace gets `404`. |
| A person or an agent, over HTTP | The workspace the `x-ntasks-workspace` header names, or the only one it reaches when the header is left out. Which one that is changes when its memberships or grants change, so a client that writes names the workspace. |
| Anyone, over MCP | The workspace a tool call's `workspace` argument names, or the only one the sender reaches when the argument is left out. Every MCP tool but `list_workspaces` and `get_task_guide` takes it, as NoticeOS's tools did, and the header is not read. |
| A visitor, with no credential | The public workspace, which it names in the header, over HTTP and over MCP alike ([Sign-in](sign-in.md#the-public-workspace)). |

A person reaches the workspaces they belong to, an agent the workspaces where
it was granted a project, and a service its credential's workspace.

| Answer | When |
|---|---|
| `400` with `{ "error": "workspace_required", "detail": … }` | The header is left out and the sender reaches several workspaces. |
| `404` with `{ "error": "not_found", "detail": … }` | The header names a workspace the sender does not reach, whether or not it exists, or the sender reaches none. |
| `refused: workspace <id> is not one of yours; list_workspaces lists yours.` | An MCP tool call names a workspace the sender does not reach. |
| `invalid arguments: workspace (required: you reach 2 workspaces; name one by its workspaceId: …)` | An MCP tool call names none and the sender reaches several. The sentence lists each workspace's id and name. |
| `invalid arguments: workspace (a workspaceId from list_workspaces)` | An MCP tool call names a workspace with something other than text. |

| Route | Body | Answer |
|---|---|---|
| `GET /api/workspaces` | none | `{ workspaces }`: each workspace the sender reaches, ordered by name, with its `workspaceId`, `name` and the sender's `role`: `owner` or `member` for a person, `null` for an agent or a service |
| `POST /api/workspaces` | `name`, one line of 1 to 128 characters, and optionally `workspaceId`, a lowercase UUID | `201` with `{ workspace: { workspaceId, name, role: "owner" } }`. Only a deployment admin may send it, and becomes the new workspace's owner; anyone else gets `403` with `admin_only`. A workspace that takes over a NoticeOS workspace's tasks can keep that workspace's id, so agent instructions that name it keep working. |
| `PATCH /api/workspaces` | `workspaceId` and `name`, which `POST` checks the same way | `{ workspace }`, as `GET` lists it, with the new name. Only an owner of the workspace may send it; anyone else who reaches it gets `403` with `insufficient_scope`. The name is only shown: the task store, the `x-ntasks-workspace` header and the MCP tools' `workspace` argument name a workspace by its id, so a rename changes nothing else. |

`POST /api/workspaces` refuses a bad `name` or `workspaceId` with `400` and
`invalid_request`, and an id another workspace has with `409` and
`workspace_exists`; each refusal names the body field in `field`. `PATCH
/api/workspaces` refuses a bad `name` the same way, and answers a
`workspaceId` the sender does not reach, whether or not it exists, with `404`
and `not_found`. These routes, like `GET /api/access/me`, do not read the
`x-ntasks-workspace` header, so a client that sends a workspace the sender no
longer reaches still gets its list. They are answered beside sign-in, so they
count against its limit of about 30 requests a minute from one address
([Sign-in](sign-in.md#routes)).

A workspace's owners manage its people with four routes in the request's
workspace, which [Sign-in](sign-in.md#members-and-invitations) describes with
their refusals. A member, an agent or a service gets `403` with
`owner_only`.

| Route | Body | Answer |
|---|---|---|
| `GET /api/access/members` | none | `{ members, invitations }`: each member as `{ userId, name, githubLogin, role }`, and each open invitation that has not expired as `{ invitationId, githubLogin, role, createdAt, expiresAt }` |
| `POST /api/access/invitations` | `githubLogin`, a GitHub username, and optionally `role`, `owner` or `member` (the default) | `201` with `{ invitation }`. The account holding that login joins the workspace with that role when it next signs in. |
| `POST /api/access/invitations/<invitation id>/revoke` | none, or `{}` | `{ "revoked": true }` |
| `POST /api/access/members/<user id>/remove` | none, or `{}` | `{ "removed": true }`. The member's session and their agents stop reaching the workspace; a workspace's only owner cannot be removed. |

## The MCP endpoint

`POST /api/mcp` takes one JSON-RPC message of at most 256 KB and answers it. It speaks both
versions of the protocol in use: the 2026-07-28 revision, where every request
names its version, and the earlier revisions that agree a version in an
`initialize` handshake. It keeps no session and streams nothing. A browser
may call it only from the Worker's own origin. The Worker answers the list
of tools, `list_workspaces` and `get_task_guide` from the sender's sign-in,
and runs every other tool in the task store of the workspace the call names.

The server's instructions, which an agent reads when it connects, carry the
start of the task guide and its rules for writing a task. The instructions an
`initialize` answers with also list, before those rules, the open tasks the
sender holds in the workspaces it reaches, so a new session starts from the
work it has in hand: at most ten, most recently active first, one line each
with the task's id, title, helper, branch, next step and last activity. Past
ten, or past the room the list has, one more line gives how many more there
are and the `list_tasks` call that lists them; a sender who holds none gets no
list. The list ends within the first 4,096 characters of the instructions,
which Claude Code shows and cuts after, so the rules after it are what a
client cuts first; `get_task_guide` returns them whole. It is read with one
statement per workspace, through the store's index of holders. The handshake
waits at most 1.5 seconds for those reads: a store that fails or has not
answered by then leaves its tasks out, and the rest are listed.

| Tool | What it returns | Arguments |
|---|---|---|
| `list_workspaces` | Every workspace the sender reaches, ordered by name, each with its `workspaceId`, `name`, `status`, the sender's `role` in NoticeOS's words (`owner` for its owner, otherwise `operator` with `tasks:write` or `viewer`) and `access`, the scopes the sender holds there; and the guide's version | none |
| `get_task_guide` | The rules for task work as Markdown, with a version that changes whenever the text does | none |
| `reconcile_task` | The task's `id`, `status`, `assignee`, `resolution`, `awaitingHuman`, `answer` and `version`, `closeAcceptance` when it recorded one, and `replayed` ([below](#recording-an-owner-answer)) | `workspace`, `task`, `action`, `proposal_version`, as the action needs `option`, `met`, `quote`, `source`, `explanation`, `evidence`, `duplicate_of`, `holder`, `inactive`, `activity_check` and `progress`, and optionally `project`, `model`, `idempotency_key` and `detail` |
| `list_projects` | Each project's `projectId`, key, name and prefix, and `deploys`: whether its changes go live by a deploy | `workspace` |
| `get_agent_stats` | Agent statistics: `readAt`, `projects` (how many were read), `broken` (always empty: one store answers every project of a workspace) and `stats` ([below](#agent-statistics)) | `workspace`, and optionally `project`; without it, every project the sender reaches there |
| `list_tasks` | Tasks most urgent first, or in the order `sort` names: every open one and those closed in the last 7 days, as summaries, a page at a time | `workspace`, and optionally `project`, `query`, `status`, `ready`, `assignee` (`"me"` for your own), `parent`, `labels`, `type`, `created_after`, `created_before`, `updated_after`, `updated_before`, `closed_days` (1 to 56), `stage`, `stalled` (`true` for only [stalled](#work-in-hand) tasks), `activity` (one or more of `active`, `quiet` and `stalled`: tasks in progress by [how recently their holder worked on them](#work-in-hand)), `limit` (1 to 200, default 50), `offset`, `sort` (`priority`, `created`, `updated`, `closed` or `title`), `direction` (`asc` or `desc`; left out, priority reads most urgent first, title A to Z and the dates newest first) and `fields` (with `project`) |
| `get_task` | One task in full, with its recorded `answer`; its comments; its `proposal`, the text a person answers, and `proposalVersion`, which an answer names ([below](#recording-an-owner-answer)); for an epic, also `openChildren`; for a task with a parent, also `parent` ([below](#what-a-parent-holds-for-its-tasks)). With `tasks`, `tasks`: the same for each, without `parent`, or `{ id, error }` for one it cannot read | `workspace`, `task` or `tasks` (1 to 50 task ids), and optionally `project` |
| `get_task_history` | The task's changes newest first, each field with its old and new value, or whole versions with `snapshots` | `workspace`, `task`, and optionally `project`, `limit` (1 to 200, default 50) and `snapshots` |
| `create_task` | The new task's `id`, `status` and `version`, `assignee`, `resolution` and `delivery` when it was filed claimed or done, `replayed`, the approval it opened if any, `lint` when it finds something, `possibleDuplicates` when it finds some ([below](#filing-claiming-and-closing-in-one-call)), and `warnings` when a link was left out, a text cites something a reader cannot check, or work done has no proof | `workspace`, `title`, and optionally `project`, `description`, `type`, `priority`, `labels`, `parent`, `acceptance`, `notes`, `design`, `estimate_minutes`, `depends_on`, `blocks`, `related`, `discovered_from`, `duplicates`, `supersedes`, `external_links`, `fields`, `approval`, `choices`, `card`, `change_class`, `metadata`, `claim`, `done`, `model`, `idempotency_key` and `detail` |
| `create_tasks` | `results`: one for each task, in the call's order, with its `index` and either what `create_task` answers or the `error` that refused it; `warnings` as `create_task` gives them; and `retry` when a task was refused | `workspace`, `tasks` (1 to 25, each with `create_task`'s task fields), and optionally `project`, `model` and `idempotency_key` |
| `claim_task` | The task's `id`, `status` (now `in_progress`), `assignee` (now the sender), `for` and `work` when the call names them, and `version`, and `replayed`; for a task with a parent, also `parent` ([below](#what-a-parent-holds-for-its-tasks)); with `touches`, `overlaps` when other work in progress changes the same ([below](#work-that-changes-the-same-files)) | `workspace`, `task` or `pr`, and optionally `project`, `model`, `for`, `session`, `worktree`, `branch`, `commit`, `next`, `touches`, `idempotency_key` and `detail` |
| `update_task` | The task's `id` and `version`, each field the call changed as `get_task` names it, except `description`, `acceptance`, `notes` and `design`, `replayed`, `lint` when it finds something, and `warnings` when a link was left out or a text cites something a reader cannot check | `workspace`, `task`, at least one of `status`, `priority`, `title`, `description`, `assignee`, `parent`, `defer`, `acceptance`, `notes`, `design`, `estimate_minutes`, `add_labels`, `remove_labels`, `related`, `duplicates`, `supersedes`, `add_external_links`, `remove_external_links`, `fields`, `choices`, `card` and `change_class`, and optionally `project`, `model`, `idempotency_key` and `detail` |
| `comment_on_task` | The `task` and the comment's `commentId`, `pinned: true` when it pinned it, `overlaps` as `claim_task` answers it, and `replayed`; with `detail: "full"`, the whole comment. With `tasks`, `results`: the same for each, or `{ task, error }` | `workspace`, `task` or `tasks` (1 to 50 task ids), `text`, and optionally `project`, `pin`, `unpin` (with `task` only), `model`, `for`, `session`, `worktree`, `branch`, `pr`, `commit`, `next`, `touches`, `idempotency_key` and `detail` |
| `link_tasks` | `{ task, to, type }`, and `replaced`, the link it replaced, when there was another; or `{ task, to, removed: true }` | `workspace`, `task`, `to`, `type` or `remove: true`, and optionally `project` and `model` ([below](#linking-two-tasks)) |
| `request_human_approval` | The approval the task now waits on, as `{ id, status, title, reason }`, `created`: whether this call opened it, and `lint` with advice when its title or description breaks the [rules for writing a task](concepts.md#writing-a-task) | `workspace`, `task`, either `title` (one line of at most 70 characters) and `description` (Markdown, at most 2,048 characters) or `reason` (at most 400 characters, its first line the title), and optionally `project` and `model` |
| `request_human_action` | The request the task now waits on, as `request` with its `id`, `status`, `title` and number of `steps`, `created`: whether this call opened it, and `lint` with advice when its title breaks the [rules for writing a task](concepts.md#writing-a-task) or a step's text holds a command. Asking again with the same title and steps returns the open one | `workspace`, `task`, `title` (one line of at most 70 characters), `context` (Markdown: what doing the steps changes and how the agent will confirm the result), `steps` (1 to 20, each with `text` and optionally `command`), and optionally `project` and `model` |
| `close_task` | The task's `id`, `status` (now `closed`), `resolution`, `delivery` when the close records one, and `version`, `replayed`, `unblocked`, and `warnings` when the reason cites something a reader cannot check or work done has no proof. With `tasks` or `with_children`, `results`: the same for each task closed, or `{ id, error }`, then `unblocked` and `warnings` | `workspace`, `task` or `tasks` (1 to 50 task ids), `reason`, and optionally `project`, `resolution` (`done` when left out), `duplicate_of`, `commit`, `pr`, `link`, `with_children`, `model`, `idempotency_key` and `detail` |
| `report_delivery` | `{ moved }`: each task the signal moved, as `{ id, stage }` ([below](#delivery)) | `workspace`, `repository`, `stage`, at least one of `pull_requests` and `commits`, and optionally `model` |
| `list_fields` | The project's key and its custom fields, retired ones included, in the order they were defined: each one's `key`, `name`, `type`, `options`, `createdAt` and `retiredAt` | `workspace`, `project` |
| `define_field` | The field, and `replayed` | `workspace`, `project`, `key`, `name`, `type`, `options` for a choice field, and optionally `model` and `idempotency_key` |
| `retire_field` | The field as retired, and `replayed` | `workspace`, `project`, `field` (its key), and optionally `model` and `idempotency_key` |

`workspace`, which the table lists first for every tool that takes it, may
be left out by a sender who reaches one workspace ([above](#workspaces)).

`project` names a project by its `projectId`, its key or its prefix, as
`list_projects` lists them. A tool that names a task takes the project from
the task id's prefix, so it needs no `project`. `create_task` and
`create_tasks` without one file into the project of the parent, or of the
first task named in `depends_on`, `blocks` or `discovered_from`, and
otherwise into the only project the sender may change; a sender who may
change several is refused with a list of their keys and prefixes. A task in a
project the sender cannot reach is refused as one that does not exist.

`model` names the model the agent runs as. Every write takes it, and the task
records it beside the sender's name.

A write answers with the task's id, its version, which goes up with each
change, and the fields it changed, as the table says. `detail: "full"` makes
it answer with the whole task as `get_task` shows it, as `task`, and
`comment_on_task` with the whole comment, as `comment`.

`list_tasks` without a `project` reads every project of the workspace that the
sender reaches, and each task then names its project.

`notes` and `design` are Markdown, at most 8,192 characters each, and
`estimate_minutes` is a whole number of minutes from 0 to 525,600 (a year).
`get_task` returns them as `notes`, `design` and `estimateMinutes`, and
`list_tasks` returns `estimateMinutes` on each task that has one, beside
`updatedAt`, when the task last changed, so a ready task's size and age show
without reading it in full; like `description`, `notes` and `design` are left
out of `list_tasks`.

`for`, `session`, `worktree`, `branch`, `pr`, `commit`, `next` and
`touches` record the holder's work in hand
([concepts](concepts.md#claiming-a-task)). `for` is one line of at most 64
characters; `pr` is an http or https URL; `touches` is a list of at most 16
lines of at most 200 characters each, and `[]` takes it off; the others are
one line each, `branch` at most 255 characters, `commit` 128 and the rest
512. Each replaces the value the task has. On `comment_on_task` only the
task's holder may send them, and only while the task is open; details that
change nothing leave the task's version as a plain comment does. Closing or
releasing the task clears them. `get_task` returns `for`, `work` (the
details recorded, by name) and `lastActivityAt`, when the holder last
changed or commented on the task, which is null while nobody holds it.
`list_tasks` returns `for` and `lastActivityAt`, and `get_task` of an epic
returns `openChildren`: each child that is not closed, with its `id`,
`title`, `status`, `assignee`, `for` and `lastActivityAt`.
`get_task_history` records each change of them as `assigneeFor` and `work`.

`duplicates` names earlier tasks for the same work, and `supersedes` the
tasks this one replaces. `get_task` lists them among `dependencies`, with
those types, and lists the links other tasks hold onto this one among
`dependents`.

### Work that changes the same files

`touches` names the files or other things the work changes: a path, a
folder, a migration number or a table. When a claim or a comment records
`touches`, its answer lists in `overlaps` each other task of the project that
is in progress or blocked, held by someone, whose `touches` meet these. Two
entries meet when they are the same path, or one is a folder holding the
other; a leading `./` and a trailing `/` are ignored. Each overlap has:

| Field | Holds |
|---|---|
| `id`, `title`, `assignee`, `status` | The other task |
| `pr` | Its pull request, from its holder's work details, or null |
| `touches` | Its entries that meet this task's |
| `mergeOrder` | `after` when this task merges after it, `before` when it merges after this task, null while no `merges-after` link says |

An overlap is advice: the claim or comment is never refused because of it.
The holders agree which pull request lands first and record it with
`link_tasks` type `merges-after` ([below](#linking-two-tasks)).

### What a parent holds for its tasks

A comment with `pin: true` is pinned on its task: on an epic, a fact the
epic's tasks need ([concepts](concepts.md#epics)). `unpin` names up to 32
pinned comments of the same task to unpin, such as the facts the new comment
corrects; a comment that is not pinned on the task is refused, and the call
then adds nothing. Pinning and unpinning leave the task's version as a plain
comment does, and its history records them in the comment's `commented`
change as `pinned: true` and `unpinned`, the ids. Every comment `get_task`
returns says whether it is `pinned`.

`get_task` of one task with a parent, `claim_task` and `GET /api/tasks/:id`
answer `parent`:

| Field | Holds |
|---|---|
| `id`, `title`, `type`, `status` | The parent |
| `pinned` | Its 10 newest pinned comments, newest first, each with `id`, `author`, `text` and `createdAt` |
| `pinnedTotal` | How many comments are pinned on it |
| `closedSiblings` | Its 5 most recently closed other children, most recently closed first, each with `id`, `title`, `resolution`, `closedAt`, `closedBy`, `closeReason`, and its proof: `commit`, `pullRequest` and `closeLink`, null when it has none |
| `closedSiblingsTotal` | How many of its other children are closed |

`get_task` of the parent shows every comment, and `list_tasks` with `parent`
and `status: ["closed"]` lists every closed child.

A task links to another task once. A task named in two link arguments of
one `create_task`, `create_tasks` entry or `update_task` is linked once, as
the more specific kind: `depends_on` or `blocks`, then `discovered_from`,
`supersedes`, `duplicates` and `related`. The answer's `warnings` names each
link left out. A task named in both `depends_on` and `blocks` is refused,
since the two tasks would wait on each other.

`warnings` also names each text that cites something its next reader cannot
check: `description` and `acceptance` in `create_task`, each `create_tasks`
entry (as `tasks[2].description`) and `update_task`, `done.evidence` in a
task filed done, and `reason` in `close_task`. Two things are named: a path on one machine, under `/tmp`,
`/private/tmp`, `/var/folders` or a home folder (`/Users/<name>`,
`/home/<name>` or `~/`); and an exact count of tests that passed or failed,
such as `123 passed` or `Tests: 5 failed`. Each warning says what to cite
instead: a path in the repository, a commit or a link, or the command that
runs the tests. The write lands either way.

`external_links` and `add_external_links` are each an array of objects, and
each object has a `url`, an http or https URL of at most 2,048 characters, a
`title`, one line of at most 512 characters, and optionally a `kind`:
`pull-request`, `document` or `other`. `remove_external_links` is an array of
URLs. A task links to at most 32 pages, and to a URL once: a URL is kept as
the URL standard writes it, so `HTTPS://Example.com` and
`https://example.com/` are one URL, and adding a URL the task has gives that
link the new title and kind. `get_task` and `list_tasks` return them as
`externalLinks`, ordered by URL, each with its `url`, `title` and `kind`,
which is null when none was given.

Each project defines its own **custom fields**, and its tasks carry values
of them. A field has a `key`, which names it in values and filters: a
lowercase letter, then up to 63 lowercase letters, digits, underscores or
hyphens. It has a `name`, one line of at most 128 characters, and a `type`.
A value of each type is:

| Type | Value |
|---|---|
| `text` | Text of 1 to 1,024 characters |
| `number` | A number |
| `date` | A date as `YYYY-MM-DD` |
| `single-choice` | One of the field's `options` |
| `multiple-choice` | A list of the field's `options`, none twice, kept in the field's order |
| `url` | An http or https URL of at most 2,048 characters, kept as the URL standard writes it |
| `yes-no` | `true` or `false` |

A choice field has 1 to 64 options, each one line of at most 128
characters. A project defines at most 64 fields, retired ones included, and
a key names one field for good: defining a key the project has used, retired
or not, is refused. A field keeps its key, type and options.

`fields` in `create_task`, `create_tasks` and `update_task` is an object of
values by field key, and in `update_task` `null` takes a value off.
`get_task` and `list_tasks` return a task's values as `fields`. A value that
is not of its field's type is refused with a sentence that names the field and
its type, such as
`invalid arguments: fields.points must be a number: Points is a number field`.
`fields` in `list_tasks` lists only the tasks holding each value, by key; for
a multiple-choice field, the value is one option, which the task's options
include. It needs `project`, since each project defines its own fields.

A retired field takes no new values: a task keeps the value it has, filters
still find it, its history keeps every change, and `update_task` can take it
off with `null`. Retiring a retired field changes nothing.

In `update_task`, `""` releases the task (`assignee`), takes it out of its
parent (`parent`) or clears its defer date (`defer`), and `null` takes off its
`choices`, `card`, `change_class` or `estimate_minutes`. A status on a closed
task opens it again.
In `create_tasks`, a parent or a link may name another task of the same
call by its place, counting from zero: `#0` for the first, `#1` for the
second, earlier or later in the call.

A refused call answers with a tool result marked as an error. Its first
line is one sentence the agent can act on:

- `invalid arguments: …` names the argument by its path and what it must be,
  such as `invalid arguments: limit (1–200)` or
  `invalid arguments: tasks[2].depends_on[0] (a task id such as abc-1x2)`.
  An argument the tool does not take is named with the one it most likely
  means, such as `invalid arguments: unknown argument id; this tool takes task`.
- `refused: …` names what is missing and where to find it, such as
  `refused: project p1 names no project in this workspace; list_projects lists each one's projectId, key and prefix.`,
  or what in the task's state stops the change and what to do instead.
- `conflict: …` says the idempotency key was first used for a different
  change ([retrying a write](#retrying-a-write)).
- `unavailable: …` says the task store did not complete the change.

Its last line names the task the call named, as `Task abc-1x2.`, when the
sentence does not, and then says whether a retry is safe: `Nothing was
written; retrying is safe.`, or, only after `unavailable: …`, `The change may
have been written; read the task before retrying.`

A client whose copy of the tool list is older than an argument sends an
object argument, such as `card`, as text. The tools read it as JSON, and the
answer starts with `staleClient`, a sentence telling the agent to reconnect.

## The rules a write keeps

These are the rules NoticeOS's task tools kept, and the HTTP writes keep them
too.

- **A claim** takes an open task. It is refused when someone else holds the
  task, when the task is closed, and when its status is `blocked`, `deferred`
  or `in_progress` with nobody holding it.
- **A close** is refused when someone else holds the task, when an approval it
  waits on is still open, when it has children that are not closed, and when
  the task is a person's decision: an approval, or a task labelled `human`.
  A task it depends on may still be open. A close as `done` keeps the task's
  card as it stood, with the commit hash its reason names, and `get_task`
  returns it as `cardShipped`. A close as `duplicate` links the two tasks as
  `related`.
- **A change** may not replace a task's choices once a person has chosen, or
  its card once it has shipped. Taking the `human` label off a person's
  decision is refused. A task someone is working on goes to someone else only
  from its holder.
- **A link** between two tasks is one: `link_tasks` replaces the kind or the
  direction it has, and asking for the link it has changes nothing. A
  `related`, `duplicates`, `supersedes` or `merges-after` link may name a task in another
  project the sender reaches; every other link stays inside the project. A
  link that would make tasks wait on each other in a loop is refused. A link
  to or from a person's decision changes and goes only when the person
  decides; a new one may be added.
- **An approval** asked again with the same title and description, or the
  same reason, returns the open one, with `created: false`. The same
  description under another title opens another approval. A `description`
  with a line that starts `Reason:` is refused: an approval imported from
  Beads asks only what follows that line, and every answer reads it so.
- **Who did it**: the task records the sender's name as its filer, holder,
  closer or the author of a comment, and the `model` argument beside it. The
  server records who wrote a card and when, and a card's kill date is also the
  task's due date.
- **A custom field** is defined and retired by a sender who may change the
  project, as any write needs. Listing a project's fields needs only reading
  it.
- **Lint**: `create_task`, `create_tasks` and `update_task` return `lint`
  when it finds something: the sections the task's type expects that it still
  lacks, and advice. Advice names a title over 70 characters or holding a
  command, a file path or a commit hash; a description that writes a command
  inline, or has a fenced block with no language tag or a `$` prompt; a
  description whose first line repeats the title; an ask to a person, an
  approval or a task labelled `human`, that names no link, control to press
  or command; and lettered options to pass as `choices`. Nothing is refused
  for it.

## Filing, claiming and closing in one call

Each step of a piece of work is one call, and a step taken on many tasks is
one call too.

- **Filing.** `claim: true` on `create_task`, or on an entry of
  `create_tasks`, files the task claimed by the sender: assigned to it and in
  progress. `done` files work already finished closed as done by the sender,
  held by nobody: an object with `evidence`, the reason
  `close_task` takes, and optionally `commit`, `pr` and `link`, as
  `close_task` takes them. A task is filed claimed or done, not both; one
  that opens an approval, waits on an approval still open or is labelled
  `human` is not filed done. Either way
  the task and its claim or close are one write, with one history event.
- **Possible duplicates.** A new task's answer names `possibleDuplicates`
  when it finds some: up to three open tasks in its project whose titles
  share more than half the words of the longer title, most alike first, each
  as `{ id, title, status }`. They are scored over the project's open tasks
  as one board read, which the store serves from memory when nothing was
  written since it last read them; a call's own tasks are not each other's.
- **A batch.** `create_tasks` files each task it can: a task refused gets its
  sentence as its result and the rest are still filed. A task that names a
  refused one with `#n` is refused too, and tasks that name each other in a
  loop are refused, each naming the loop. Tasks are filed in the call's
  order, except that a task is filed after the tasks it names with `#n`.
  A call that cannot file any task, such as one naming a project the sender
  cannot change, is refused whole.
- **Claiming by pull request.** `claim_task` with `pr` and no `task` claims
  the open task whose work details name that pull request, or that links to
  it with an external link of kind `pull-request`, in the project the call
  names or in every project the sender reaches. A GitHub pull request is
  matched as one page whatever tab its URL shows. No such task, or several,
  is refused, naming them.
- **Closing many.** `close_task` with `tasks` closes each with the same
  `reason`, resolution and proof, and `with_children: true` first closes
  every open task under each one named, deepest first, in a project the
  sender may change. One call closes at most 50 tasks in all, counting the
  tasks under them; a call that would close more is refused whole, naming
  how many, before anything is written. Each task closed or
  refused is a result of its own: a task someone else holds is refused alone.
  `unblocked` lists, as `{ id, title }`, each task that waited on the closed
  ones through a `blocks` link and is now ready.
- **Commenting on and reading many.** `comment_on_task` with `tasks` records
  the same comment, and work details, on each; `get_task` with `tasks` reads
  each. A task refused or not found is a result of its own.

A call that names `task` keeps answering as before; `task` and `tasks`
together are refused.

### Proof of work done

A close as `done` shows what proves the work: `commit` or `pr`, which start
the task's [delivery](#delivery), or `link`, an http or https URL that shows
work no commit or pull request shows, such as a document. `get_task`
returns the link as `closeLink`. A task, bug, feature or chore closed as
done with none of the three, where the work details its holder recorded
count as they do for delivery, reads `proof: "none"` in `get_task` and
`list_tasks`, and its close answers with a warning that names the proof
`close_task` takes. Nothing is refused for it. A decision, an approval and an
epic close without proof.

### Done on a person's call

A person can close a task as done on their own call, even when some of its
acceptance is unmet. Each line or list item of `acceptance` is one
criterion, numbered from 1 (`criteriaOf` in
[`packages/domain`](../packages/domain/src/criteria.ts)): a list item without
its marker or task-list box, or any other line that is not blank or a
heading, with an indented line joined to the item it wraps. The person names
the criteria that are met, and the rest are recorded as waived. Only a person
does this, in the web app or through a connected app
([`POST /api/tasks/:id/accept`](#a-persons-decisions)); an agent records an
acceptance the owner gave elsewhere with `reconcile_task` action `accepted`
([above](#recording-an-owner-answer)). `close_task` takes no criteria: an
agent's close as done names its proof.

The task answers the acceptance as `closeAcceptance`, null on any other
task:

| Field | Holds |
|---|---|
| `by` | The person who accepted it |
| `app` | The client id of the connected app they accepted it through; absent in the web app and when relayed |
| `relayed` | `{ by, source, quote }`: the sender that recorded it with `reconcile_task`, where the owner said it and their words; absent when the person accepted it themselves |
| `criteria` | Each criterion as `{ text, met }`, in order, `met: false` for one the person waived |

A task accepted as done has proof, so it reads `proof: null`. Its history
records the acceptance in the close, and a reopen clears it.

## Linking two tasks

Two tasks hold at most one link. `link_tasks` sets it: `task` links to `to`
as `type`, read as `get_task` lists it among the task's `dependencies`, and
among `to`'s `dependents`:

| `type` | `task` … `to` |
|---|---|
| `blocks` | waits on: `task` is not ready until `to` closes |
| `related` | relates to, holding nothing back |
| `discovered-from` | was found from the work of |
| `duplicates` | is the same work as, filed later |
| `supersedes` | replaces |
| `merges-after` | merges after: `task`'s pull request lands only once `to`'s has. Both stay ready |

A link the pair already has, either way round, is replaced in the same write,
so changing `blocks` to `related` is one call. `remove: true` removes the
pair's link, whichever way it points. Asking for a link the pair has, or to
remove one it does not have, changes nothing. A link the other task holds in
another project is changed from that task's side. `link_tasks` takes no
idempotency key, since asking again changes nothing.

## Recording an owner answer

`reconcile_task` records an answer the owner already gave, or maintains a
person's request (a **human request**: an approval, or a task labelled
`human`) with evidence. It never makes a decision itself, and retiring a
request grants no permission. [`owner-answers.ts`](../workers/api/src/owner-answers.ts)
holds its rules. Each call is one write: the record of the disposition, kept
in the task's metadata as `noticeos_maintenance` with every earlier one in its
`events`, a comment holding it, the close or the hand-back, and the comments
and hand-backs of the tasks waiting on an approval.

| `action` | What it does |
|---|---|
| `answer` | Records the owner's answer. On an approval it approves it: the approval closes as `done` and records `permission: approved-scope-only`. Each task waiting on it that is labelled `human`, is neither a decision nor an approval, and offers no options goes back to agents: open, unassigned, without the label, with a comment to keep within the approval. Other waiting tasks keep their labels. On any other task it records the `option` the owner chose, if any, takes off the `human` label and returns the task to agents, unassigned; an agent then closes it with implementation evidence. |
| `declined` | On an approval or a request to do steps only: closes it as `wont-do`, tells each task waiting on it that the action must not happen, or that the steps are not done, and hands back the same waiting tasks as `answer`. |
| `accepted` | On any open task but an approval or a request to do steps, from a sender that acts for a person (a service, which acts for nobody, is refused): the owner accepts it as done on their own call. `met` lists the numbers of the criteria they found met, counting each line or list item of `acceptance` from 1, `[]` when none is; the rest are recorded as waived. The task closes as `done` with the reason `explanation`, or `Accepted as done`, and its `closeAcceptance` names the owner as `by` and the sender in `relayed`, with the quote and the source ([Done on a person's call](#done-on-a-persons-call)). |
| `owner_performed` | On an approval or a request to do steps only: the owner did the action, or the steps, themselves. On an open one it closes it as `done` and hands back the same waiting tasks as `answer`; on a closed approval it records the report. Either way it records `permission: none`. A request's steps stay as the person left them: ticks come only from the person. |
| `completed`, `obsolete`, `superseded`, `duplicate` | Retires the request with evidence: `already-handled`, `no-longer-needed` or `duplicate`. A duplicate approval must ask exactly what the one it names asks, and a duplicate request to do steps must have the same context and steps; the tasks waiting on it wait on that one instead. A decision is never retired as `completed`. |
| `routine` | Takes the `human` label off a task that needs no person, returning it to agents. |
| `release` | Releases a task whose holder stopped working on it: `holder` names the holder, `inactive: true`, `activity_check` how that was checked, and `progress` what they left. A task in progress becomes open; a blocked or deferred one keeps its status. |

Every call names `proposal_version`: the `proposalVersion` that `get_task`
returned, the first 32 hexadecimal characters (128 bits) of the SHA-256 of
the task's `proposal`, so nobody can write two proposals with one version. A
task's proposal is its id, title, description, acceptance, type and options,
and on a request to do steps the text and command of each step, without the
person's marks, so a tick leaves it as it was; an approval's description is
the action it asks for, with its environment, scope and verification. A call whose version is not the task's
current one is refused, so a task edited after the owner saw it cannot borrow
the answer.

An owner answer (`answer`, `declined`, `owner_performed` or `accepted`) names the owner's
exact words in `quote`, where they said it in `source`, such as
`claude-code:session/<id>`, a conversation URL or `comment:<id>`, and on a
task with choices the `option` they chose; it leaves `option` out when they
chose none, and on an approval. Nothing reads the quote: a quote such as
`maybe?` or `Approve web-g1` is recorded as given. `explanation` and
`evidence` are optional with an answer and required for every other action.

An answer's record keeps the fields NoticeOS reads, with NoticeOS's meaning:
`response`, the quote; `question`, what the proposal asked (an approval's
request, a decision's question, else the task's title); `scope`, what the
answer covers (an approval's request, the chosen option's label, else the
quote); `source`; `by`, who recorded it; `verification`; and on an approval
`outcome`, `approved`, `performedBy` for an owner-performed action, and
`disputed` once disputed.

An answer is recorded as relayed by the sender (`verification:
agent-recorded`), whoever it is: an agent, a service, or a person calling the
MCP endpoint. A pick it records names as the chooser the person the sender
acts for, or the sender when it acts for nobody, as a service does. The owner
can dispute a relayed approval ([below](#a-persons-decisions)): the approval
opens again, the tasks waiting on it are told to stop, and an answer from the
disputed source cannot approve it again. A relayed acceptance is disputed the
same way: the task opens again, and an answer from the disputed source cannot
close it again.

A request to do steps takes no `answer`: the owner's report that they did
the steps is `owner_performed`.

A closed approval takes no further answer but `owner_performed`, and that
only while the approval it follows is in force and covers the approval's
request as it stands; any other answer recorded there would replace the
owner's. A person's own approval in the web app is final: no dispute
withdraws it, including after an agent relays on the closed approval that
the owner did the action. Once the gate is opened again, its next answer is
the one it stands on, and a relayed one can be disputed.

An approval, relayed or direct, permits exactly the request of the proposal
version it answered: its action, environment, scope and verification. It
grants nothing beyond that request, and nothing to any other approval: a task
that waits on several approvals stays held until each is approved. The
permission lasts while the gate stays closed as `done` with `permission:
approved-scope-only` in its record. A dispute withdraws it: the record's
`permission` becomes `none`, the gate opens again, and the tasks waiting on it
are told to stop. The owner's report that they did the action
(`owner_performed`) records `permission: none`: it permits no agent to do the
action.

A refused owner answer names the argument at fault first, such as
`refused: proposal_version: The proposal changed after the owner saw it; show it again.`,
and ends as every refusal does, with `Nothing was written; retrying is safe.`

`get_task` and the HTTP task reads return the task's latest recorded answer
as `answer`, or null:

| Field of `answer` | Holds |
|---|---|
| `option` | The option chosen: a letter on a task with choices, or null when the answer chose none. On an approval, `decline` for a refusal, and `approve` both for an approval and for the owner's report that they did the action. On a request to do steps, `done` for the owner's report that they did them and `decline` for a refusal. It names the latest answer, not a standing permission: a disputed approval keeps `approve` and has `disputedBy` set. Whether the approved action may proceed is shown by the gate, as above |
| `quote` | The owner's words, or null when a person answered in the web app without words: a pick with no note, or an approval with no reason |
| `source` | Where the owner said it, as the relaying sender named it; null for an answer made in the web app |
| `recordedBy` | The person who answered in the web app or through a connected app, or the agent or service that relayed the answer |
| `relayed` | `false` for a person's own answer, in the web app or through a connected app, `true` for any other |
| `app` | The client id of the [connected app](sign-in.md#connected-apps) the person answered through, or null |
| `proposalVersion` | The proposal version it answered |
| `at` | When it was recorded |
| `disputedBy` | The person who disputed it, or null |

## Agent statistics

`get_agent_stats` and `GET /api/tasks/agent-stats` count the work of agents
by the model each named, in the shape NoticeOS's Agents page reads
([`agent-stats.ts`](../workers/api/src/agent-stats.ts)): the tasks in
progress and blocked now, and those closed since the start of the day 56 days
ago. A close counts for the model its closer named, and otherwise for the
model of the agent that claimed it; a model nobody named, or a name Ntasks
does not recognize, counts as `Other`. Approvals and epics are left out.

| Field of `stats` | Holds |
|---|---|
| `workers` | One row for each model with work this week or in hand: `inHand`, `blocked`, closes on each of the last 7 days (`days`), this week's (`week`) and the week before's (`lastWeek`), and the median hours from claim to close (`medianHours`) |
| `velocity` | Closes in each of the last eight weeks, from Monday, by the three models that closed the most |
| `race` | This week's closes by model, with points by priority |
| `trophies` | The most closes, the fastest close, the longest run of days and the most urgent closes |
| `week`, `lastWeek`, `inHand`, `blocked`, `medianHours` | The same, for every model together |

The answer holds counts, model names and times: no task's text, id or metadata.

## Wins

`GET /api/tasks/wins` answers the Productivity page
([`wins.ts`](../workers/api/src/wins.ts)): what a workspace got done that
matters over seven days, day by day. A win is one of these:

- **Shipped**: a change that reached merged or live ([delivery](#delivery)),
  at the time it merged, or went live where no merge was recorded. A pull
  request is one win however many tasks closed with it; a change with none
  counts by its commit.
- **Decided**: a person's answer to a task's choices, at the time they
  answered, whether or not the task has closed since.
- **Finished**: an epic closed as done, with how many of its direct children
  closed as done.

Approvals closed as done are counted in `totals.approved` and not listed. A
close as won't do, duplicate, can't reproduce, already handled or no longer
needed is never a win, and nothing counts tasks closed. A change that merges
more than 28 days after its task closed is not found.

Each day runs from midnight to midnight in `timeZone`, an IANA time zone
such as `America/Los_Angeles`, or in UTC when the request names none; the web
app sends the person's own. Without `before`, the seven days are today and
the six before it. `before`, a day as `YYYY-MM-DD`, reads the seven days
before it, back to 56 days ago; `earlier` in each answer is the `before` that
reads the seven days before those, and null at the oldest.

| Field | Holds |
|---|---|
| `readAt`, `from`, `to` | When it was read, and the first instant and the instant after the last that it covers: midnights in `timeZone` |
| `timeZone` | The time zone the days are cut in |
| `earlier` | The `before` for the seven days before these, or null |
| `projects` | How many projects were read |
| `shippedBefore` | Whether any change in these projects shipped before `from`. When none did, merges may not have been recorded yet |
| `totals` | `shipped`, `decided`, `finished` and `approved` over the seven days |
| `days` | Each day, oldest first: `day` and its `shipped`, `decided` and `finished` |
| `wins` | Every win, newest first. Each has `kind` (`shipped`, `decided` or `finished`), `at` and `projectId`. A shipped win has `stage` (`merged` or `live`), `pullRequest`, `commit` (null when it has a pull request) and `tasks`, each `{ id, title }`; a decided one `id`, `title`, `option`, `label` and `by`, the person who answered; a finished one `id`, `title` and `done` |

## Delivery

A task's **delivery** says where its change is, so a closed task shows
whether its work still waits for a merge or a deploy. It has three stages:

| Stage | Means |
|---|---|
| `built` | The task closed as `done` with a commit or a pull request: the change exists. |
| `merged` | The change is merged. |
| `live` | A deploy shipped the change. |

A close as `done` with `commit` (7 to 64 hexadecimal characters) or `pr` (the
pull request's URL) over MCP, or `commit` or `pullRequest` over HTTP, starts
the task at `built`; either is refused with any other resolution. One the
close leaves out comes from the work details its holder recorded (`commit`,
when it is a commit's hexadecimal name, and `pr`), which the close clears. A
close as done with neither leaves the task with no delivery, and a reopen
clears it; the task's history keeps each delivery and each move.

Only work that ships code waits for a merge, so two closes start no
delivery:

- A decision or an approval ships no code. Its close records no delivery,
  and a pull request it names becomes its `link` when it names none. The same
  holds for one filed as done with `create_task`.
- A close that names `link`, and neither `commit` nor `pr`, shows its work by
  that link, so the work details' commit and pull request start no delivery
  either.

A **signal** moves tasks on: `report_delivery` over MCP, or
`POST /api/delivery` over HTTP, which takes the same fields. It names a
`repository` (`owner/name`), a `stage` (`merged` or `live`), and pull
requests and commits, at most 100 of each. A pull request is its URL, or its
number in the repository, which names
`https://github.com/<repository>/pull/<number>`; a GitHub pull request's URL
is kept as that page whatever tab it shows. The signal moves each closed task
whose pull request, commit or merge commit matches one it names, in the
projects of the workspace the sender may change, to its stage:

- Two commits match when one starts with the other.
- A task never moves back, so a repeated signal moves nothing.
- A `merged` signal that names exactly one commit records it as the task's
  merge commit, which a later `live` signal matches.
- A project says whether its changes go live by a deploy (`deploys`,
  `false` when it is made). Its owner sets it on the web app's Projects page
  or with `PATCH /api/tasks/projects`. For a project that does not deploy,
  merged is the last stage: a `live` signal moves its tasks to `merged`.

The answer lists each task moved, as `{ id, stage }`; a task in a project
the sender may only read is left as it is. `get_task` returns a task's
delivery as `delivery`, with its `stage`, `commit`, `pullRequest`,
`mergeCommit`, `builtAt`, `mergedAt` and `liveAt`, and leaves it out when the
task has none; `list_tasks` returns it on each task that has one.
`list_tasks` with `stage` lists the closed tasks at that stage, whenever they
closed unless `closed_days` is given. With `stage`, or with a `status` that
includes `closed`, its answer carries `stages`: how many of the tasks it lists
are `built`, `merged` and `live`.

A repository's automation sends the signals in one of two ways: a
[GitHub App or webhook](#from-github), which needs no workflow, or a
workflow that calls `POST /api/delivery` with a
[service credential](sign-in.md) granted the project for writing. This
GitHub Actions workflow sends `merged` when a pull request merges and `live`
when the deploy job finishes; `NTASKS_URL` and `NTASKS_TOKEN` are the
repository's secrets, and `deploy` stands for the repository's own deploy
job:

```yaml
name: Delivery
on:
  pull_request:
    types: [closed]
  push:
    branches: [main]
jobs:
  merged:
    if: github.event.pull_request.merged
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl --fail -X POST "$NTASKS_URL/api/delivery" \
            -H "Authorization: Bearer $NTASKS_TOKEN" -H 'content-type: application/json' \
            -d '{"repository":"${{ github.repository }}","stage":"merged",
                 "pullRequests":["${{ github.event.pull_request.number }}"],
                 "commits":["${{ github.event.pull_request.merge_commit_sha }}"]}'
        env:
          NTASKS_URL: ${{ secrets.NTASKS_URL }}
          NTASKS_TOKEN: ${{ secrets.NTASKS_TOKEN }}
  deploy:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - run: echo "The repository's own deploy steps go here."
  live:
    needs: deploy
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl --fail -X POST "$NTASKS_URL/api/delivery" \
            -H "Authorization: Bearer $NTASKS_TOKEN" -H 'content-type: application/json' \
            -d '{"repository":"${{ github.repository }}","stage":"live","commits":["${{ github.sha }}"]}'
        env:
          NTASKS_URL: ${{ secrets.NTASKS_URL }}
          NTASKS_TOKEN: ${{ secrets.NTASKS_TOKEN }}
```

The merge commit the first job sends is the commit the push to `main`
carries, so the `live` signal matches the tasks the merge moved. Ntasks's own
repository sends no signals, since no deployment of it exists.

### From GitHub

GitHub can send the signals itself, so a task moves to `merged` and `live`
when its pull request merges and its deploy passes, whether or not the agent
that did the work is still running. The workspace's owner connects GitHub
once, on the web app's Settings page, under GitHub:

1. Press **Connect GitHub**.
2. On GitHub, press **Create GitHub App**. GitHub makes a GitHub App for the
   workspace and sends the browser back to Ntasks, which keeps the app's
   webhook secret and private key, and opens the app's install page for the
   person's own GitHub account.
3. Press **Install**, with **All repositories** chosen.

Each organization takes one more install: in Settings, press **Install on
an organization**, pick the organization, and press **Install**. No secret
is copied, no webhook is added by hand, and no name is typed.

The app reads pull requests, checks, deployments and the repository's
metadata, and receives the `pull_request`, `check_run` and
`deployment_status` events of every repository it is installed on, at
`POST /api/github/<workspace id>`. Each becomes a signal for every project
of the workspace:

| GitHub event | Signal |
|---|---|
| `pull_request`, closed and merged into the repository's default branch | `merged`, naming the pull request and its merge commit |
| `check_run`, completed with `success` on the default branch, when it is a deploy | `live`, naming the commit the check ran on. A commit the merge queue landed counts too: GitHub names its check suite for the queue's branch, `gh-readonly-queue/<default branch>/…`, and a build there counts only for tasks merged before it started, since one that started earlier was a preview |
| `deployment_status` with `success`, when it is a deploy | `live`, naming the deployed commit |

A **deploy** is a check run whose name starts with `Workers Builds:` or
`Cloudflare Pages`, the checks Cloudflare's builds report; a deployment to
the production environment, which GitHub marks as `production_environment`
or which is named `production`; or a name typed by hand
([below](#set-up-by-hand)). The first time a deploy is seen, Settings lists
its name under **Deploys**, with a box that switches it off; a deploy
switched off moves no task.

A deploy also turns on **Changes go live by a deploy** for the projects of
the tasks it names, so their tasks go live without anyone ticking it. It does
so once for each project: an owner who turns the setting off again on the
Projects page keeps it off.

A merge GitHub made before the task closed sends its event too early to move
the task, so the workspace's task store also asks GitHub itself, as the app:

- about 5 seconds after a task closes as done with a pull request;
- when an owner installs the app, for the tasks already waiting for a merge,
  such as the ones closed before GitHub was connected.

Each check reads the pull requests of the newest tasks waiting for a merge in
repositories an installation reaches, and moves each one merged into its
repository's default branch to `merged`, with its merge commit. An
installation on all of its account's repositories reaches every one; for an
installation on selected repositories, the check lists them first, up to 200,
and reads only pull requests in the ones listed. It makes at most 45 requests to GitHub, within the free plan's 50
requests to other servers, so a check reads up to about 40 pull requests and
the next close checks the rest. It signs in to GitHub with the app's private
key.

- A delivery is read only when its `X-Hub-Signature-256` header is the
  HMAC-SHA-256 of its body under the app's webhook secret, or the secret
  saved by hand, compared in constant time. Without the header the answer
  is `401` with `signature_required`. With a signature that does not match,
  for a workspace with no app and no secret or one that does not exist, it
  is `401` with `bad_signature`, the same answer in each case.
- Anyone can install a GitHub App made public, which an app must be to be
  installed on an organization as well as an account. So the app's events
  are read only from an installation that an owner of the workspace made:
  GitHub's `installation` event names the GitHub account that made it, and
  Ntasks records the installation when that account is one an owner signs in
  with. Made by anyone else, it answers `403` with `not_an_owner`, and every
  event from an installation not recorded answers `403` with
  `unknown_installation`. An installation removed or suspended in GitHub is
  forgotten.
- A signed delivery answers `200` with `{ moved }`, as `POST /api/delivery`
  does, and a merge also with `closed` when it closed a task in progress and
  `kept` when it left one in progress, each only when it lists a task
  ([below](#work-still-in-progress-when-its-pull-request-merges)).
  When its event moves nothing, such as GitHub's `ping`, an
  installation, a pull request closed without merging, a check that is not a
  deploy, or another event, the answer also holds `ignored`, a sentence
  saying why. GitHub shows each answer under the app's, or the webhook's,
  Recent Deliveries.
- Each move and each close is recorded in the task's history under
  `service:GitHub`.
- A task never moves back, and a task a merge closed is no longer in
  progress, so a delivery sent again, by GitHub or with Redeliver, moves and
  closes nothing twice.
- A pull request's URL names its repository, so a merge moves only the tasks
  of that pull request, whichever repository sends it.
- A deploy moves the tasks whose commit or merge commit is the commit it ran
  on. A build that ships several merges at once names only the last, so the
  tasks of the merges before it stay at `merged`.
- A delivery is at most 1 MB, sent as `application/json` or as GitHub's form
  (`application/x-www-form-urlencoded`).
- The app's webhook secret and private key are kept in D1, encrypted under a
  key derived from `AUTH_SECRET`. After `AUTH_SECRET` changes they no longer
  decrypt and every delivery is refused, until the owner presses
  **Disconnect**, deletes the old app on its GitHub page and connects again.

#### Work still in progress when its pull request merges

A merge into the repository's default branch also closes the work it
finishes when the agent that did it has stopped. Each task in progress whose
work in hand names the pull request
(`pr` on `claim_task` or `comment_on_task`) closes as done before the merge
moves anything:

- Its proof is the pull request and the merge commit, and the same delivery
  then moves it to `merged`.
- It is closed by `service:GitHub`, not by its holder, with a reason that
  names the pull request and the merge commit. A comment keeps what the
  holder's work in hand recorded, such as its branch and next step, since a
  close clears it.
- A task stays in progress when it is an epic, a person's request, labelled
  `keep-open`, waiting on an approval or a request to do steps that is still
  open, or has open tasks under it. Label a task `keep-open` when its pull
  request covers only part of it; its holder then closes it.
- Only a delivery Ntasks checked came from GitHub closes a task. A merge
  sent to `POST /api/delivery` or with `report_delivery` closes nothing.

The answer lists the tasks the merge closed as `closed`, and each task it
left in progress as `kept`, with `why`. Each list is left out when it is
empty, so an answer can hold either one, both or neither. A merge that GitHub
reports with no merge commit closes nothing, and lists each such task under
`kept`.

#### Set up by hand

Where an app cannot be installed, a webhook added by hand sends the same
events. The owner sets it up in Settings, under GitHub, **Set up by hand**,
or with `POST /api/access/github` ([Sign-in](sign-in.md#routes)):

- **Payload URL**: the address to enter in GitHub.
- **Secret**: 32 to 255 letters, digits and punctuation, with no spaces.
  Make a secret fills in a new random one to copy into GitHub. Ntasks keeps
  it encrypted under a key derived from `AUTH_SECRET`, and never shows it
  again. After `AUTH_SECRET` changes, the saved secret no longer decrypts,
  every delivery is refused, and the owner saves the secret again.
- **Deploy checks**: names that count as a deploy besides the ones detected,
  such as a check run named `deploy` or an environment named `live`. At
  most 20.

Then, in GitHub:

1. Open the new webhook page. For every repository of an organization, an
   organization owner opens
   `https://github.com/organizations/<organization>/settings/hooks/new`.
   For one repository, its admin opens
   `https://github.com/<owner>/<repository>/settings/hooks/new`. A personal
   account has no webhook of its own, so each of its repositories gets one,
   all with the same Payload URL and secret.
2. Set **Payload URL** to the one Settings shows, **Content type** to
   `application/json`, and **Secret** to the saved secret.
3. Under **Which events would you like to trigger this webhook?**, choose
   **Let me select individual events**, tick **Pull requests**, **Check
   runs** and **Deployment statuses**, and untick **Pushes**.
4. Leave **Active** ticked and press **Add webhook**.

GitHub then sends a `ping`; under Recent Deliveries its answer says
`GitHub reaches Ntasks`. An answer of `401` means the secret in GitHub and
the one saved in Settings differ.

## Retrying a write

A write that would repeat its effect takes an idempotency key, a string of 8
to 128 letters, digits, dots, underscores, colons or hyphens: the optional
`idempotency_key` argument of `reconcile_task`, `create_task`,
`create_tasks`, `claim_task`, `update_task`, `comment_on_task`, `close_task`,
`define_field` and `retire_field`, and the optional `Idempotency-Key` header
of an HTTP write, a person's decisions included. A retry with the same key and the
same arguments answers what the first call answered, with the tasks as they
stand now and `replayed: true`, and changes nothing. The same key with other
arguments, for another task or in another project is refused. A key is kept
for seven days, for each sender and each tool. A call that finds nothing to
change, such as a title set to the title the task has, still keeps its key,
so a retry of it answers again rather than writing that title over a newer
one.

An MCP write sent without `idempotency_key` is keyed by the SHA-256 of its
workspace, its sender, the tool and its arguments with their keys sorted,
`detail` left out. Without a key, an identical call repeats the first answer
only while every task that answer wrote is unchanged since; a create also
stops repeating after 24 hours. So a call interrupted and sent again writes
once, and claiming, releasing and claiming a task again claims it twice. A
comment leaves its task unchanged, so the same comment sent again with
nothing changed between is answered with the first one. `create_tasks`
repeats its whole answer or none of it: when one task it filed has changed,
the call files every task again; a task it refused is tried again. A call
that names `tasks` keeps a record for each task: under its key and the task,
or without a key, under the key the same call naming that task alone would
have, so each task it closed or commented on answers once, as that call would.
A key of the caller's own is also held to the whole call: sent again with
other arguments, such as other tasks, it is refused before any task is
written.

`link_tasks`, `request_human_approval` and `request_human_action` take no
key, because asking again changes nothing.

A write that another write beats to the same task reads the task again,
checks the rules again and tries again, up to three times. After that it
answers `unavailable: …`, or `503` over HTTP, and has changed nothing.

## Versions

The HTTP API has a version: a whole number that goes up by one each time a
route, a query parameter, a body field, a field of an answer or a value a
field can hold is added.

Each version is one file in
[`workers/api/api-versions/`](../workers/api/api-versions/), and the version
is the number of files there. A file is named with the UTC time it was
written, then what its version adds, such as
`2026-11-10T0137Z-stalled-tasks.json`. In name order, the order GitHub lists
them in, the files are versions 1, 2, 3 and on. Each file's `added` says what
its version added, and the rest records the fields it added
([below](#the-recorded-contract)).

| Where | What it holds |
|---|---|
| The `x-ntasks-api-version` header | The version, on every answer under `/api`: a route's answer, a refusal, a `401` and a `404` alike |
| `GET /api/version` | `{ version, oldest }`: the version, and `oldest`, the earliest version a client may be made for. It answers `GET` and `HEAD` before sign-in, so a client can check it before it sends a person to sign in. |

The API only adds. A route, a query parameter, a body field and a field of an
answer that one version has, every later version keeps, with the same name,
meaning and type: none is renamed, removed or given another type, and a field
that was never `null` or left out does not become so. A client made for
version N therefore works with every Ntasks that answers version N or later,
and `oldest` stays 1.

A client made for version N compares it with the version an answer names:

- **Lower than N**: the Ntasks is older than the client. The client shows the
  person that this Ntasks must be updated to version N, instead of failing on
  a field it does not answer yet.
- **N or higher, with `oldest` at most N**: the client works.
- **`oldest` higher than N**: the Ntasks no longer answers something the
  client uses, and the client must be updated.

A client can also use a route or a field only when the version shows it is
there, so one client works with older deployments too. A client treats a
value it does not know, such as a status added later, as it treats any value
it has no special case for.

The MCP tools keep their own contract ([above](#the-mcp-endpoint)); the version
counts the HTTP routes.

### The version a client asks for

A client made for an addition asks for the version main has once that
addition has merged, or a later one: the number of files in `api-versions/`
then. Main only gains files, so every Ntasks built from main that answers
that version or a later one was built after the addition merged, and has it.

A file's place in name order can be lower than the first version that had
it. Two additions open at the same time both merge, and when the one written
first merges second, its file sorts before the other's: its place is one
lower than the version main had when it merged, and the other's place moves
up by one. The rule above never names a version too low.

### A change that would break a client

Removing or renaming a route, a parameter or a field, or giving one another
type, breaks every client made for an earlier version. It is the owner's
decision, never a refactor. Where it can, such a change is made as an
addition: the new field beside the old one, which keeps its answer. A
removal raises the version, and raises `oldest` to that version, so a client
made for an earlier one finds out that it is too old.

### The recorded contract

Each file in `api-versions/` records the fields its version added to each
route's answer, and the type of each. A field several answers hold, such as
a task, is recorded once, as a shape. Together the files are the record.
[`http-contract.test.ts`](../workers/api/test/api/http-contract.test.ts)
signs in as a person, sends every route the record names through the Worker,
and compares the answers with the record, so it fails when an answer:

- leaves out a recorded field, or gives it a type the record does not allow;
- holds a field the record lacks. The failure names the line that records it.

A recorded field is never edited or removed, and the test refuses a field
recorded twice.

### Adding a version

A change that adds to the HTTP API adds one file to `api-versions/`, and
changes no other file's record and no number:

1. Name the file with the current UTC time and what it adds, such as
   `2026-11-12T0930Z-task-due-dates.json`. This prints the time:

   ```bash
   date -u +%Y-%m-%dT%H%MZ
   ```

2. Write `added`, one line saying what the version adds, and record each
   field it adds, with the line the test's failure prints:

   ```json
   {
     "added": "`stalled` on a task, `POST /api/tasks/:id/release`, and `release` among a person's `operations` in `GET /api/tasks/capabilities`",
     "shapes": { "task": { "stalled": "boolean" } },
     "routes": { "POST /api/tasks/:id/release": { "task": "@task" } }
   }
   ```

The Worker counts the files, so the version goes up by one when the change
merges, whichever other additions merge before or after it. Two changes
that each add a version touch no line in common and merge in either order;
[`api-versions.ts`](../workers/api/test/node/api-versions.ts) merges two such
changes in both orders to show it.

The Worker's bundler cannot list a folder, so
[`scripts/api-versions.ts`](../workers/api/scripts/api-versions.ts) writes
the files' names, in order, to `workers/api/src/api-versions.generated.json`,
which git ignores. `pnpm install` runs it, and so do the Worker's build,
`pnpm dev`, its deploy, its typecheck and its tests.

The record covers every HTTP route this page and
[Sign-in](sign-in.md#routes) list, except three. The OAuth routes under
`/api/auth` follow the OAuth standards. The routes under `/api/restore` take
only rows made with the store's own migrations, so their bodies follow the
store's tables rather than the API's version. `GET
/api/access/github/app/created` answers a browser that GitHub sends back
with a redirect, not JSON.

## The HTTP routes

Every route answers JSON with `cache-control: no-store` and the
[`x-ntasks-api-version` header](#versions). Each acts in the
workspace the request reaches ([above](#workspaces)): a person or an agent who
reaches several names it in the `x-ntasks-workspace` header.

### Reads

A read refuses a query parameter it does not take, or one given twice, so a
misspelt filter fails instead of being ignored.

| Route | Parameters | Answer |
|---|---|---|
| `GET /api/tasks/projects` | none | `{ projects }`: each `projectId`, `logicalKey`, `displayName`, `prefix` and `deploys` |
| `GET /api/tasks/capabilities` | none | What the web app may offer: for a sender who holds `tasks:write` and may change some project, `writable: true`, the write `operations` (`create`, `update`, `comment`, `close`, and for a person who holds `tasks:decide`, in the web app or through a connected app, also `respond`, `dismiss`, `resolve`, `choose`, `dispute`, `step`, `accept` and `release`) and the `editableFields` an update may change; for any other sender, `writable: false` and none |
| `GET /api/tasks` | `project`, optionally `status` (comma-separated), `closedDays` and `field.<key>` | A board: the project's tasks in those statuses and those closed in the last 7 days, the open epics with how many of their children are closed, `closedSince`, and `lastSeq`, the latest change the board reflects. `closedDays` (1 to 56) reaches further back and is taken only with `status=closed`. Each `field.<key>` parameter, such as `field.severity=high`, keeps only the tasks holding that value of the custom field, as `fields` in `list_tasks` does; a number field reads the parameter as a number, and a yes-no field reads `true` or `false`. Each task carries `proposalVersion` while it waits on a person, and null otherwise. |
| `GET /api/tasks` with `label` | `project` and `label` (one label), optionally `limit` (1 to 200, default 100) and `after` | Every task of the project carrying the label, in every status and closed at any time, ordered by id, with `label` and `next`. `next` is the last task's id when more remain, and null on the last page; ask again with `after` set to it. `status`, `closedDays` and `field.<key>` are refused with `label`, and `limit` and `after` without it. |
| `GET /api/tasks` with `stage` | `project` and `stage`, a comma-separated list of `built`, `merged` and `live`; optionally `status=closed` and `closedDays` | The board's answer, holding the project's closed tasks at those stages, whenever they closed unless `closedDays` is given ([delivery](#delivery)) |
| `GET /api/tasks` with `activity` | `project` and `activity`, a comma-separated list of `active`, `quiet` and `stalled`; optionally `status` naming `in_progress` and `field.<key>` | The board's answer, holding the project's tasks in progress in those groups of [activity](#work-in-hand), and `activities`, which counts the tasks in progress in each group. A board read with `status` naming `in_progress` answers `activities` too. `stage` is refused with `activity`. |
| `GET /api/tasks/search` | `q`, 1 to 512 characters, and optionally `limit` (1 to 200, default 100) | `{ readAt, closedSince, total, tasks }`: the tasks of every project the sender reaches whose id, title, description, acceptance or labels hold every word of `q`, ignoring case, among the open ones and those closed in the last 7 days, most urgent first, as `list_tasks` searches with `query`. When `q` is a task id whose prefix names a project the sender reaches, that task comes first, closed at any time. Each task carries `project`, its project's key; `total` counts every match, and `tasks` holds the first `limit`. |
| `GET /api/tasks/:id` | `project` | The task, its comments, its `proposal` and its `proposalVersion`, as `get_task` returns them ([recording an owner answer](#recording-an-owner-answer)), and `parent`: what its parent holds for it, or null when it has none ([above](#what-a-parent-holds-for-its-tasks)) |
| `GET /api/tasks/:id/history` | `project`, optionally `limit` (1 to 200, default 100) | `{ changes }`, newest first |
| `GET /api/changes` | optionally `after` (default 0), `limit` (1 to 200, default 100) and `project` | `{ events, lastSeq }` |
| `GET /api/fields` | `project` | `{ project, fields }`: the project's key and its custom fields, as `list_fields` lists them |
| `GET /api/tasks/agent-stats` | optionally `project` | `{ readAt, projects, broken, stats }`, as `get_agent_stats` answers ([agent statistics](#agent-statistics)): of the project, or of every project the sender reaches |
| `GET /api/tasks/wins` | optionally `project`, `before` and `timeZone` | The wins of seven days ([wins](#wins)): of the project, or of every project the sender reaches |

### Writes

Each write takes one JSON object of at most 32 KB, sent as
`application/json`, with no key twice, and no query. A browser may send one
only from the Worker's own origin, or from a
[connected app](sign-in.md#calls-from-the-apps-page)'s page with the app's
bearer token. Each runs the same write as the MCP tool
that does the same thing, so it keeps [the same rules](#the-rules-a-write-keeps).

| Route | Body | Answer |
|---|---|---|
| `POST /api/tasks` | `projectId`, `title`, and optionally `description`, `type`, `priority`, `labels`, `parent`, `acceptance`, `notes`, `design`, `estimateMinutes`, `dueAt`, `externalLinks`, `fields`, `metadata`, `card` and `changeClass` | `{ id, project }`: the new task's id and its project's key |
| `PATCH /api/tasks/:id` | `projectId` and at least one of `status`, `priority`, `title`, `description`, `assignee`, `parent`, `defer`, `acceptance`, `notes`, `design`, `estimateMinutes`, `dueAt`, `addLabels`, `removeLabels`, `addExternalLinks`, `removeExternalLinks`, `fields`, `card` and `changeClass`; or `projectId` and `claim: true` to take the task, optionally with `for` and `work`, an object of the work details `claim_task` takes | `{ task }`, the task as changed |
| `POST /api/tasks/:id/comments` | `projectId`, `text`, optionally `pin: true` and `unpin`, the ids of pinned comments of the task to unpin | `{ comment }` |
| `POST /api/tasks/:id/close` | `projectId`, `reason`, and optionally `resolution`, `duplicateOf`, `commit`, `pullRequest` and `link` | `{ task }`, the task as closed |
| `POST /api/delivery` | `repository`, `stage`, and at least one of `pullRequests` and `commits` | `{ moved }`: each task the signal moved, as `{ id, stage }` ([delivery](#delivery)) |
| `POST /api/github/:workspaceId` | A delivery from the workspace's GitHub App or webhook, signed with its secret instead of signed in, as GitHub sends it | `{ moved }`, `closed` and `kept` when a merge closed or kept work in progress, and `ignored` when it moves nothing ([from GitHub](#from-github)) |
| `POST /api/fields` | `projectId`, `key`, `name`, `type`, and `options` for a choice field | `{ field }`, the field defined |
| `POST /api/fields/:key/retire` | `projectId` | `{ field }`, the field as retired |
| `POST /api/tasks/projects` | `name`, one line of 1 to 128 characters; `prefix`, 1 to 32 lowercase letters or digits, which starts every task id of the project; and optionally `key`, the name people know the project by, one line of 1 to 128 characters, which is the prefix when left out | `201` with `{ project }`: its `projectId`, `logicalKey`, `displayName` and `prefix`, as `GET /api/tasks/projects` lists them. It needs `workspace:manage`, which only the workspace's owner holds; anyone else gets `403` with `insufficient_scope`. |
| `PATCH /api/tasks/projects` | `projectId` and `deploys`, `true` or `false` | `{ project }`, as `GET /api/tasks/projects` lists it. Like creating a project, it needs `workspace:manage`. |

A refused project names the body field at fault in `field`: `400` with
`invalid_request` for a `name`, `prefix` or `key` that breaks its rule, and
`409` with `project_exists` for a prefix or key another project of the
workspace has. Two workspaces may each have a project with the same prefix.
The route keeps no retry record: sent again with an `Idempotency-Key`, it
answers `201` with the project that already has exactly this name, prefix and
key, and `replayed: true`.

A new task's `metadata` holds where it came from, under the keys NoticeOS
used for that: `noticeos_source`, `noticeos_asset`, `noticeos_kind`,
`noticeos_rule`, `noticeos_key`, `noticeos_panel_asset`,
`noticeos_panel_date`, `noticeos_panel_version` and
`noticeos_task_map_asset`. In a change, `""` releases the task, takes it out
of its parent or clears its defer date, and `null` takes off its card, change
class, estimate or due date.

`dueAt` is a date, `YYYY-MM-DD`, or an ISO time with its offset, and the task
answers it as `dueAt` in UTC. Writing a card with a kill date also sets the
task's `dueAt` to that date, so one body gives either a card with a kill date
or a `dueAt`, not both. After that each changes on its own: a later change
can set or clear `dueAt` and leave the card as it is, and taking the card off
leaves `dueAt`, so the two dates can differ until a card with a kill date is
written again.

`externalLinks` and `addExternalLinks` are each an array of objects, and each
object has a `url`, a `title` and optionally a `kind`, with the limits that
[`external_links`](#the-mcp-endpoint) has over MCP. `removeExternalLinks` is
an array of URLs.

`fields` is an object of custom field values by key, as `fields` is over MCP,
and in a change `null` takes a value off. The task answers its values as
`fields`.

A task answers its [delivery](#delivery) as `delivery`, null when it has
none, the link its close named as `closeLink`, a person's acceptance as
`closeAcceptance` ([above](#done-on-a-persons-call)), and `proof`: `"none"` for
work closed as done without proof ([above](#proof-of-work-done)), and null
otherwise.

A task answers its holder's work in hand as `for`, `work`,
`lastActivityAt`, `stalled` and `activity`, as `get_task` does.

### Work in hand

A task is **stalled** when it is in progress and held, and its holder has
done nothing on it for a day, or never recorded anything (`isStalled` in
[`packages/domain`](../packages/domain/src/task.ts)). Every task read answers
`stalled`, worked out at the time of the read; `list_tasks` names it only on a
stalled task, and `stalled: true` lists only those. It is shown only: Ntasks
never frees a claim because time passed.

A task in progress has an **activity**, how recently its holder changed or
commented on it, worked out at the time of the read (`activityOf` in
[`packages/domain`](../packages/domain/src/task.ts)), and the Live page groups
tasks by it:

| Activity | The task in progress |
|---|---|
| `active` | Its holder changed or commented on it within the last hour |
| `quiet` | Neither active nor stalled: its holder last did so more than an hour ago, and less than a day ago |
| `stalled` | It is [stalled](#work-in-hand): held, with nothing from its holder for a day or ever |

Every task read answers `activity`, null on a task that is not in progress.
`list_tasks` with `activity` lists only the tasks in progress in those groups,
and its answer's `activities` counts the tasks in progress in each group that
its other filters match, before `activity` narrows them, so asking for some
groups still shows the size of the others. `activities` is answered when
`activity` is given or `status` names `in_progress`. An agent keeps watch on
work in progress with:

```json
{ "activity": ["quiet", "stalled"] }
```

A quiet task may be done and not closed, such as one whose pull request
merged; a stalled one has a holder that stopped, to pick up or free.

NoticeOS answered a change, a comment and a close with its task client's own
output; Ntasks answers them with the task or the comment, in the shapes the
reads use.

### A person's decisions

These routes take a person's own decision. Only a person may send one
(`tasks:decide`), signed in to the web app or through a connected app they
allowed `tasks:decide`, in a project they may change; any
other sender gets `403` with `insufficient_scope` and a `detail` saying so,
and nothing changes. Each takes one JSON object and the optional
`Idempotency-Key` header, as the other writes do, is one write, and answers
`{ task }`, the task as the decision left it. The task records the person as
the closer or the author of the comment, and its history records who decided
and when.

| Route | Body | What it does |
|---|---|---|
| `POST /api/tasks/:id/respond` | `projectId`, `response` (at most 4,086 characters), and optionally `proposalVersion` | Answers a task labelled `human` that is not closed and not an approval, in the person's words, recorded as given: a decision closes as `done` with the reason `Responded` and the comment `Response: <response>`, and any other task goes back to ready work: open, unassigned, without the `human` label, with the comment `Answered: <response>`. A reply never picks an option; `choose` does. |
| `POST /api/tasks/:id/choose` | `projectId`, `option` (`a` to `f`), and optionally `note` (at most 2,000 characters) and `proposalVersion` | Picks one of the task's options. The pick records the option, its label, the person and the time, with the comment `Chose (b) <label>.` and the note. A decision then closes with the reason `Chose (b) <label>`, past an open blocker or another holder; any other task goes back to ready work. A second pick is refused; the same person sending the same option again finishes a pick that stopped before its comment or its close. |
| `POST /api/tasks/:id/dismiss` | `projectId`, and optionally `reason` (at most 2,037 characters), `resolution` (any but `done`; `wont-do` when left out), `proposalVersion` and, with `duplicate` only, `duplicateOf` | Declines a task labelled `human`: it closes with the reason `Dismissed` or `Dismissed: <reason>`. A duplicate is linked to the task it duplicates as `related`. |
| `POST /api/gates/:id/steps` | `projectId`, `step` (its place, from 1), at least one of `done` (`true` ticks it, `false` unticks it), `note` (at most 1,024 characters; `null` takes it off) and `stuck` (why the person stopped there, at most 1,024 characters; `null` says they are past it), and optionally `proposalVersion` | Records the person's marks on one step of a request to do steps, in any order: each mark holds the person, the time and, through a [connected app](sign-in.md#connected-apps), the app's client id as `app`. A tick clears the step's `stuck`, and `stuck` clears its tick; `done: true` with `stuck` is refused. `stuck` also comments on each task waiting on the request, naming the step and the reason. When every step is ticked, the request closes as `done` with the person as its closer, and each task waiting on it gets a comment to check the result; each labelled `human` that is not a decision and offers no options goes back to ready work, open, unassigned and without the label. A step's text and command never change. |
| `POST /api/gates/:id/resolve` | `projectId`, and optionally `reason` and `proposalVersion` | Approves an approval: it closes as `done` with the reason, `Approved` when left out, and the tasks waiting on it are free of it. Each of them labelled `human` that is not a decision and offers no options goes back to ready work, open, unassigned and without the label, with a comment to keep within the approval, as after an approval an agent relays. The person's approval becomes the approval's recorded answer, so one an agent relayed before it can no longer be disputed. A request to do steps is refused: it takes ticks, not an approval. |
| `POST /api/tasks/:id/accept` | `projectId`, `met` (the numbers of the criteria that are met, from 1, each once; `[]` when none is), `proposalVersion`, and optionally `reason` (at most 2,048 characters) | Accepts a task as done on the person's call ([Done on a person's call](#done-on-a-persons-call)): it closes as `done` with the reason, `Accepted as done` when left out, and `closeAcceptance` records the person and each criterion, met or waived. Another holder does not refuse it. `proposalVersion` is required, so the criteria recorded are the ones the person read. A number the task has no criterion at is refused with `400` and `field: "met"`; an approval, a request to do steps, a closed task, and a task that waits on an open approval or has children that are not closed are refused with `409`. |
| `POST /api/tasks/:id/release` | `projectId`, `holder` (optional) | Frees a task someone holds, on the person's call: nobody holds it then, a task in progress is open again, and a blocked or deferred one keeps its status. A comment keeps who freed it and where the work stopped: the holder and its helper, its last activity, its work details and its last comment, cut to fit one comment. A task nobody holds, and a closed one, is refused with `409`. `holder` is the holder the person's page showed, which the web app always sends: a task someone else holds now is refused with `409` and nothing changes. An agent releases its own claim with `update_task`, sending `assignee: ""`, and `status: "open"` when the task is in progress, so a blocked or deferred one keeps its status; it frees a task someone else holds only with `reconcile_task` action `release` and its evidence. |
| `POST /api/tasks/:id/dispute` | `projectId` | Withdraws an approval or an acceptance as done that an agent relayed with `reconcile_task`. On an acceptance, the task opens again with its close kept in its history, and it and each task waiting on it get a comment; a person's own acceptance is refused. On an approval: its record loses its permission and names who disputed it, the approval opens again, and it and each task waiting on it get a comment saying the recorded action must stop until a new approval. Disputing it again changes nothing, and tells the waiting tasks nothing again. Once the person approves it directly, a dispute of it is refused. |

`proposalVersion` names the proposal version the person's page showed, as a
task read returned it. When the task's proposal has changed since, the
answer is refused with `409`, `task_refused` and `field: "proposalVersion"`,
and nothing is written; without it, the answer applies to the proposal as it
stands. An answer, a pick and an approval each become the task's recorded
`answer` ([above](#recording-an-owner-answer)), with `relayed: false`, the
person as `recordedBy`, the proposal version it answered, and the person's
words, note or reason as its quote.

A decision made through a connected app is recorded exactly as one made in
the web app, under the person's name, and also names the app's client id:
`app` in the pick (`choice`), in the recorded `answer`, which is `null` for
one made in the web app or relayed, and in a dispute's record. The task's
history shows each in the change it made.

A decision's close, after a pick or an answer, is refused while the decision
waits on an open approval or has children that are not closed. Each refusal
is `409` with
`task_refused` and a `detail` sentence, such as
`web-a1 offers (a), (b) and (c), not (e).` or
`web-a1 waits on approval web-b2. Approve it first.`

### Errors

A refusal from a route carries a `detail` sentence a person can read.

| Error | Answer |
|---|---|
| A parameter, the body or a field is missing, unknown, repeated or out of range | `400` with `{ "error": "invalid_request", "detail": … }`, and `field` naming the body field where a form shows the sentence |
| The sender reaches several workspaces and the request names none | `400` with `workspace_required` |
| The sender lacks the scope the route needs, such as a decision from an agent or a service | `403` with `insufficient_scope` |
| The sender may read the project but not change it, or a write comes from another site's page | `403` with `forbidden` |
| The workspace, the project or a task the request names does not exist, or the sender does not reach it | `404` with `{ "error": "not_found", "detail": … }` |
| A new project's prefix or key is another project's | `409` with `project_exists` |
| The task's state refuses the write, such as a close of a task someone else holds | `409` with `task_refused` |
| The `Idempotency-Key` was first used for a different write | `409` with `idempotency_conflict` |
| The task kept changing while the write was made | `503` with `unavailable` |
| The store changed during a backup | `409` with `store_changed` ([below](#backing-up-the-whole-store)) |
| A load into a store that is not empty, or that does not fit the store | `409` with the reason ([below](#loading-an-empty-store)) |
| A method the path does not take | `405` with an `allow` header naming the ones it takes |

## Reading changes instead of reloading

Every change to a task is an event with a sequence number that orders every
change in the workspace. `GET /api/changes?after=N` returns the events
after `N`, oldest first, and `lastSeq`, the number to ask after next. When
nothing changed it returns no events and the same `lastSeq`.

This is the cheapest read the API has. A client that shows a board starts
from the board's own `lastSeq`, asks for the changes after it, and reloads
the board only when an event arrives.

## Backing up the whole store

`GET /api/backup` hands out every row the request's workspace's task store
keeps, page by page: the rows of each table
[the task store](task-store.md#tables) lists, retry records included, exactly
as stored, so a backup loads into an empty store as the same rows. It holds
no row of any other workspace. It needs the `tasks:backup` scope, which the
workspace owner's browser session holds, and a service credential of the
workspace holds when its owner made it with `"backup": true`
([Sign-in](sign-in.md#routes)). It reads every project of the workspace,
whatever projects the sender was granted. Any other sender gets `403` with
`insufficient_scope`.

| Request | Answer |
|---|---|
| `GET /api/backup` | The first page |
| `GET /api/backup?page=<next>` | The page after the one whose `next` this is |

Each page is a JSON object:

| Field | Holds |
|---|---|
| `format` | `ntasks-backup-v1` |
| `takenAt` | When the first page was read. Every page holds the store as it stood then. |
| `migrations` | The names of the store's schema migrations. A backup loads only into a store with exactly these. |
| `table` | The table the rows are from. The tables come in the order the task store lists them. |
| `rows` | Rows of that table in primary key order, each with every column |
| `next` | The token that asks for the next page, or null after the last |

A page holds at most 500 rows, or rows holding about 512 KB of values,
whichever comes first, so one request stays well inside the free plan's
10 ms of CPU. A table's last page may be empty.

The pages of one backup fit together only if nothing is written while they
are read: a task written after its table was read would be missing from the
backup, though its history was in it. So every page after the first checks
that the store has changed no row since the first page, and has not
restarted. If it has, the page answers `409` with `store_changed`, and the
backup starts again from the first page. A busy store can refuse several
tries in a row; a backup succeeds when agents are quiet. A `page` the route
did not give gets `400` with `invalid_request`.

A whole backup reads each row once. A store of 100,000 rows costs about 2%
of the 5,000,000 rows the free plan reads in a day.
[`tools/migrate`](../tools/migrate/README.md#back-up-and-restore) writes the
pages to one file and restores the file into an empty store copy.

## Loading an empty store

`POST /api/restore` and the routes under it load rows into the request's
workspace's store while it holds none: an import from Beads, or a backup. The
rows arrive in pages, wait in the store, and are written together when the
load is committed, in one transaction. So a load lands whole or not at all,
and nobody reading the store sees part of one. They need the `tasks:restore`
scope, which the workspace owner's browser session holds, and a service
credential of the workspace holds when its owner made it with
`"restore": true` ([Sign-in](sign-in.md#routes)). Any other sender gets `403`
with `insufficient_scope`. Each takes one JSON object, of at most 1 MB, and no
query.

| Route | Body | Answer |
|---|---|---|
| `POST /api/restore` | `migrations`: the names of the store migrations the rows were made with | `{ load }`: the load's id. Refused unless the store holds no row in any table a backup holds, and has exactly these migrations. A load that was waiting is dropped. |
| `POST /api/restore/rows` | `load`, `table` and `rows`: 1 to 500 rows of that table, each an object holding exactly the table's columns, as GET /api/backup gives them | `{ table, page, rows }`: the page's number and its rows |
| `POST /api/restore/commit` | `load` and `counts`: the rows sent for each table | `{ rows, rowsWritten }`: the rows written, and the rows Cloudflare counts as written for them, index entries included |
| `POST /api/restore/abort` | `load` | `{ aborted: true }`: the waiting load and its pages are gone |

The commit writes nothing unless every check passes:

| Refusal | When |
|---|---|
| `409` with `store_not_empty` | The store held a row when the load began, or someone wrote one before the commit |
| `409` with `schema_mismatch` | The rows were made with other migrations than the store has; load them with the version of Ntasks the store runs |
| `409` with `counts_differ` | The pages that arrived do not hold the rows `counts` gives, such as when a page was lost |
| `409` with `load_refused` | A row breaks a rule of the store, such as a check or a link to a task the load does not hold. The load keeps waiting, to be aborted. |
| `409` with `no_such_load` | No load with this id is waiting |
| `500` with `load_failed` | The store could not write the load for a reason other than its rows, named in `detail`. Nothing was written, and the load keeps waiting. |
| `400` with `invalid_request` | A page names another table, holds no row or more than 500, or a row lacks a column, has one the table lacks, or holds a value that is not text, a number or null |

The commit runs in one request, within the 30 seconds of CPU time Cloudflare
gives a Durable Object request by default. A commit stopped at that limit
answers `500` with `internal_error` and writes nothing; the load keeps
waiting, to be aborted.

A load does not stop others from writing: the commit finds any row written
since the load began, and refuses. Cloudflare counts each index entry as a
row written, so a load writes about three times as many rows as it holds: a
hub of 40,000 rows, mostly history, comes to about 120,000, more than the
free plan's 100,000 a day. Such a one-time load fits the paid plan.
[`tools/migrate`](../tools/migrate/README.md#load-into-the-deployed-store)'s
`load` command checks the rows in a local copy first, sends the pages,
commits, and reads the store back to verify it.

## What a read costs

Cloudflare counts every row a query reads, and its free plan allows the task
store 5,000,000 rows read a day ([architecture](architecture.md#the-free-plan-budget)).

A board, a list of tasks, the epics or the project list that the store has
read since the last write comes from its memory and reads no rows. It stays
there until a write changes a task or a deferred task's time comes. The store
keeps at most 32 MB of answers, the oldest going first, and reads an answer
larger than 8 MB afresh each time, since the object has 128 MB in all. When the
store does read, each read reaches its rows through an index and returns a
task's labels, its links to other tasks and its external links in the same
query:

- a read of one task, its comments or its history reads a few dozen rows;
  what its parent holds for it is one statement more, which reads the
  parent's pinned comments, the 5 closed children it shows and one index
  entry for each other closed child, never the parent's other comments or
  its open children;
- a list or a board reads about ten rows for each task it returns;
- `list_tasks` and `GET /api/tasks/search` read the external links of the
  tasks on the page they return, in one statement after the board, and no
  other task's;
- a label read reads about fifteen rows for each task carrying the label in
  that project, however many tasks the project has;
- a task's custom field values are part of its row, so they cost no row of
  their own, and a filter by them tests the rows the read reaches anyway; it
  adds one statement, which reads the project's fields;
- agent statistics read one row for each task in progress, blocked or closed
  in the last eight weeks, in one statement over every project, however many
  tasks the projects hold;
- the wins feed reads one row for each task not closed and each closed in the
  last five weeks, in two statements over every project, and then the
  children of the epics it finds finished;
- the tasks a sender holds, which the instructions list when an agent
  connects, are one statement in each workspace it reaches, through the
  index of holders: a row for each task held;
- the statements a read runs do not grow with the number of projects or
  tasks: at most six, for a board filtered by a custom field.

[`read-cost.test.ts`](../workers/api/test/api/read-cost.test.ts) seeds a store
of eight projects and about 7,000 tasks and fails when a read goes over its
budget. Run it with `--silent=false` to print each read's statements and rows
read. [`store.test.ts`](../workers/api/test/store.test.ts) checks that a
repeated read reads no rows.
