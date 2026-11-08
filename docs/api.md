# The API

The Worker answers under `/api` in two ways, both over the same task engine:

- **The MCP endpoint** at `/api/mcp` is for AI agents. The
  [Model Context Protocol](https://modelcontextprotocol.io) (MCP) is the
  standard way an agent calls the tools a server offers.
- **The HTTP routes** under `/api/tasks` and `/api/changes` are for the web
  app.

`/api/workspaces` lists the workspaces a sender reaches and creates one
([below](#workspaces)). Two more serve a workspace's store as a whole:
`/api/backup` hands it out for a backup
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
give the answers NoticeOS's task pages used, with the same additions.

## Signing in

Every request under `/api` names who sends it, and the Worker checks it
before anything else. Each request reaches one workspace
([below](#workspaces)). In it, a sender holds **scopes**, the kinds of call it
may make: `tasks:read` to read and `tasks:write` to change tasks. A person
signed in to the web app also holds `tasks:decide`, which a person's
decisions need; no agent or service holds it, whatever it was granted. A
workspace's owner also holds `tasks:backup`, `tasks:restore` and
`workspace:manage`, which creating a project needs.

| Answer | When |
|---|---|
| `401` | Nobody is signed in. |
| `403` with `insufficient_scope` | The sender lacks the scope an HTTP route needs in the request's workspace. An MCP tool refuses the same call with a sentence instead. A decision from anyone but a person signed in to the web app says so in `detail`, which a client relaying a person's click can show as it is. |

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
person's browser session, an agent's OAuth access token, or a service
credential. A request with none, or with one that is invalid, revoked or
expired, gets `401` with a bearer challenge that tells an MCP client where to
sign in. A service names the agent each request is for in the
`x-ntasks-on-behalf-of` header, and the request is recorded as that agent's
([A service acting for its agents](sign-in.md#a-service-acting-for-its-agents)). The sign-in routes under `/api/auth` and `/api/access` answer as
[Sign-in](sign-in.md#routes) describes.

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

`POST /api/workspaces` refuses a bad `name` or `workspaceId` with `400` and
`invalid_request`, and an id another workspace has with `409` and
`workspace_exists`; each refusal names the body field in `field`. These two
routes, like `GET /api/access/me`, do not read the `x-ntasks-workspace`
header, so a client that sends a workspace the sender no longer reaches still
gets its list. They are answered beside sign-in, so they count against its
limit of about 30 requests a minute from one address
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
start of the task guide and its rules for writing a task.

| Tool | What it returns | Arguments |
|---|---|---|
| `list_workspaces` | Every workspace the sender reaches, ordered by name, each with its `workspaceId`, `name`, `status`, the sender's `role` in NoticeOS's words (`owner` for its owner, otherwise `operator` with `tasks:write` or `viewer`) and `access`, the scopes the sender holds there; and the guide's version | none |
| `get_task_guide` | The rules for task work as Markdown, with a version that changes whenever the text does | none |
| `reconcile_task` | The task's `id`, `status`, `assignee`, `resolution`, `awaitingHuman` and `version`, and `replayed` ([below](#recording-an-owner-answer)) | `workspace`, `task`, `action`, `proposal`, `explanation`, `evidence`, as the action needs `response`, `owner`, `source`, `scope`, `answer_mode`, `question`, `approval_item`, `option`, `duplicate_of`, `holder`, `inactive`, `activity_check` and `progress`, and optionally `project`, `model`, `idempotency_key` and `detail` |
| `list_projects` | Each project's `projectId`, key, name and prefix, and `deploys`: whether its changes go live by a deploy | `workspace` |
| `get_agent_stats` | Agent statistics: `readAt`, `projects` (how many were read), `broken` (always empty: one store answers every project of a workspace) and `stats` ([below](#agent-statistics)) | `workspace`, and optionally `project`; without it, every project the sender reaches there |
| `list_tasks` | Tasks most urgent first: every open one and those closed in the last 7 days, as summaries, a page at a time | `workspace`, and optionally `project`, `query`, `status`, `ready`, `assignee` (`"me"` for your own), `parent`, `labels`, `type`, `created_after`, `created_before`, `updated_after`, `updated_before`, `closed_days` (1 to 56), `stage`, `limit` (1 to 200, default 50), `offset` and `fields` (with `project`) |
| `get_task` | One task in full, its comments, and the proposal an owner's answer is checked against; for an epic, also `openChildren` | `workspace`, `task`, and optionally `project` |
| `get_task_history` | The task's changes newest first, each field with its old and new value, or whole versions with `snapshots` | `workspace`, `task`, and optionally `project`, `limit` (1 to 200, default 50) and `snapshots` |
| `create_task` | The new task's `id`, `status` and `version`, `replayed`, the approval it opened if any, `lint` when it finds something, and `warnings` when a link was left out | `workspace`, `title`, and optionally `project`, `description`, `type`, `priority`, `labels`, `parent`, `acceptance`, `notes`, `design`, `estimate_minutes`, `depends_on`, `blocks`, `related`, `discovered_from`, `duplicates`, `supersedes`, `external_links`, `fields`, `approval`, `choices`, `card`, `change_class`, `metadata`, `model`, `idempotency_key` and `detail` |
| `create_tasks` | Each task filed, in order, with its `id`, `status`, `version` and `lint` when it finds something; `warnings` when a link was left out; the first task refused, if any, and how many were not tried | `workspace`, `tasks` (1 to 25, each with `create_task`'s task fields), and optionally `project`, `model` and `idempotency_key` |
| `claim_task` | The task's `id`, `status` (now `in_progress`), `assignee` (now the sender), `for` and `work` when the call names them, and `version`, and `replayed` | `workspace`, `task`, and optionally `project`, `model`, `for`, `session`, `worktree`, `branch`, `pr`, `commit`, `next`, `idempotency_key` and `detail` |
| `update_task` | The task's `id` and `version`, each field the call changed as `get_task` names it, except `description`, `acceptance`, `notes` and `design`, `replayed`, `lint` when it finds something, and `warnings` when a link was left out | `workspace`, `task`, at least one of `status`, `priority`, `title`, `description`, `assignee`, `parent`, `defer`, `acceptance`, `notes`, `design`, `estimate_minutes`, `add_labels`, `remove_labels`, `related`, `duplicates`, `supersedes`, `add_external_links`, `remove_external_links`, `fields`, `choices`, `card` and `change_class`, and optionally `project`, `model`, `idempotency_key` and `detail` |
| `comment_on_task` | The `task` and the comment's `commentId`, and `replayed`; with `detail: "full"`, the whole comment | `workspace`, `task`, `text`, and optionally `project`, `model`, `for`, `session`, `worktree`, `branch`, `pr`, `commit`, `next`, `idempotency_key` and `detail` |
| `add_dependency` | The link | `workspace`, `task`, `depends_on`, and optionally `project`, `model` and `type`: `blocks` (the default), `related` or `discovered-from`. A `duplicates` or `supersedes` link is added with `create_task` or `update_task` |
| `remove_dependency` | The link, removed | `workspace`, `task`, `depends_on`, and optionally `project` and `model` |
| `request_human_approval` | The approval the task now waits on, and `created`: whether this call opened it | `workspace`, `task`, `reason` (at most 400 characters), and optionally `project` and `model` |
| `close_task` | The task's `id`, `status` (now `closed`), `resolution`, `delivery` when the close records one, and `version`, and `replayed` | `workspace`, `task`, `reason`, and optionally `project`, `resolution` (`done` when left out), `duplicate_of`, `commit`, `pr`, `model`, `idempotency_key` and `detail` |
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
`list_tasks` returns `estimateMinutes`; like `description`, `notes` and
`design` are left out of `list_tasks`.

`for`, `session`, `worktree`, `branch`, `pr`, `commit` and `next` record the
holder's work in hand ([concepts](concepts.md#claiming-a-task)). `for` is one
line of at most 64 characters; `pr` is an http or https URL; the others are
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
those types.

A task links to another task once. A task named in two link arguments of
one `create_task`, `create_tasks` entry or `update_task` is linked once, as
the more specific kind: `depends_on` or `blocks`, then `discovered_from`,
`supersedes`, `duplicates` and `related`. The answer's `warnings` names each
link left out. A task named in both `depends_on` and `blocks` is refused,
since the two tasks would wait on each other.

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
In `create_tasks`, a parent or a link may name an earlier task of the same
call by its place, counting from zero: `#0` for the first, `#1` for the
second.

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
- **A dependency** keeps the type it was added with: asking for it with
  another type is refused, and asking for it again changes nothing. A
  `related`, `duplicates` or `supersedes` link may name a task in another
  project the sender reaches; every other link stays inside the project. A
  link that would make tasks wait on
  each other in a loop is refused. A dependency on a person's decision stays
  until the person decides.
- **An approval** asked again with the same reason returns the open one,
  with `created: false`.
- **Who did it**: the task records the sender's name as its filer, holder,
  closer or the author of a comment, and the `model` argument beside it. The
  server records who wrote a card and when, and a card's kill date is also the
  task's due date.
- **A custom field** is defined and retired by a sender who may change the
  project, as any write needs. Listing a project's fields needs only reading
  it.
- **Lint**: `create_task`, `create_tasks` and `update_task` return `lint`
  when it finds something: the sections the task's type expects that it still
  lacks, and advice, such as passing lettered options as `choices`. Nothing is
  refused for it.

## Recording an owner answer

`reconcile_task` records an answer the owner already gave, or maintains a
person's request (a **human request**: an approval, or a task labelled
`human`) with evidence. It never makes a decision itself: it refuses an
answer it cannot trace to the owner, and retiring a request grants no
permission. Its rules and sentences are NoticeOS's, and
[`owner-answers.ts`](../workers/api/src/owner-answers.ts) holds them. Each call
is one write: the record of the disposition, kept in the task's metadata as
`noticeos_maintenance` with every earlier one in its `events`, a comment
holding the evidence, the close or the hand-back, and the comments and
hand-backs of the tasks waiting on an approval.

| `action` | What it does |
|---|---|
| `answer` | Records the owner's answer. On an approval it closes the approval as `done`, records `permission: approved-scope-only` for exactly its scope, and hands back the tasks labelled `human` waiting on it. On a decision or a task labelled `human` it records the option a short reply picks, takes off the `human` label and returns the task to agents, unassigned; an agent then closes it with implementation evidence. |
| `declined` | On an approval only: closes it as `wont-do` and tells each task waiting on it that the action must not happen. |
| `owner_performed` | On an approval only: the owner did the action themselves. It closes the approval as `done` and grants nothing. |
| `completed`, `obsolete`, `superseded`, `duplicate` | Retires the request with evidence: `already-handled`, `no-longer-needed` or `duplicate`. A duplicate approval must ask exactly what the one it names asks, and the tasks waiting on it wait on that one instead. A decision is never retired as `completed`. |
| `routine` | Takes the `human` label off a task that needs no person, returning it to agents. |
| `release` | Releases a task whose holder stopped working on it: `holder` names the holder, `inactive: true`, `activity_check` how that was checked, and `progress` what they left. A task in progress becomes open; a blocked or deferred one keeps its status. |

An owner answer (`answer`, `declined` or `owner_performed`) names the owner's
exact words (`response`), the owner (`owner`), where they said it (`source`)
and what they authorized (`scope`; for an approval, exactly what it asks). It
counts in one of three ways:

- **Source-verified**: `source` is `comment:<id>`, a comment on the task that
  the owner wrote, holding exactly `response`. It counts only when the person
  the agent acts for wrote it, and only for the proposal the owner saw when
  they wrote it: if the task changed after the comment, its history must show
  the comment was written against the proposal the call names.
- **Direct** (`answer_mode: direct`): the owner answered in the agent's own
  chat. `source` is the conversation's `https://` or `codex://threads/` URL,
  and `question` the exact question asked.
- **Relayed** (`answer_mode: relayed`): the agent passes on an answer from
  `claude-code:session/<id>`, a conversation URL, or a comment quoting the
  question and the reply word for word.

Direct and relayed answers are recorded as the agent's
(`verification: agent-recorded`), not as independently authenticated. The
owner can dispute a relayed approval ([below](#a-persons-decisions)): the
approval opens again, the tasks waiting on it are told to stop, and the
disputed source cannot approve it again.

Every call names the `proposal` that `get_task` returned. A call whose
proposal is not the task's current one is refused, so a task edited after
the owner answered cannot borrow the answer. A reply that leaves the choice
unclear, such as `maybe` or a bare `yes` to a decision, is refused with a
sentence asking for one clarification. An approval is accepted only on a
plain assent (`yes`, `approve`, `yes, your recommendation`, a numbered batch
reply that leaves this item out, or a relayed `yes` naming steps the question
and scope hold), never on a conditional, negative or broader one.

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

A repository's automation sends the signals with a
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
`detail` left out. The same call sent again within seven days answers with
the first result and `replayed: true` and writes nothing; a call meant to
make the same change again names a new key.

`add_dependency`, `remove_dependency` and `request_human_approval` take no
key, because asking again changes nothing.

A write that another write beats to the same task reads the task again,
checks the rules again and tries again, up to three times. After that it
answers `unavailable: …`, or `503` over HTTP, and has changed nothing.

## The HTTP routes

Every route answers JSON with `cache-control: no-store`. Each acts in the
workspace the request reaches ([above](#workspaces)): a person or an agent who
reaches several names it in the `x-ntasks-workspace` header.

### Reads

A read refuses a query parameter it does not take, or one given twice, so a
misspelt filter fails instead of being ignored.

| Route | Parameters | Answer |
|---|---|---|
| `GET /api/tasks/projects` | none | `{ projects }`: each `projectId`, `logicalKey`, `displayName`, `prefix` and `deploys` |
| `GET /api/tasks/capabilities` | none | What the web app may offer: for a sender who holds `tasks:write` and may change some project, `writable: true`, the write `operations` (`create`, `update`, `comment`, `close`, and for a person signed in to the web app also `respond`, `dismiss`, `resolve`, `choose` and `dispute`) and the `editableFields` an update may change; for any other sender, `writable: false` and none |
| `GET /api/tasks` | `project`, optionally `status` (comma-separated), `closedDays` and `field.<key>` | A board: the project's tasks in those statuses and those closed in the last 7 days, the open epics with how many of their children are closed, `closedSince`, and `lastSeq`, the latest change the board reflects. `closedDays` (1 to 56) reaches further back and is taken only with `status=closed`. Each `field.<key>` parameter, such as `field.severity=high`, keeps only the tasks holding that value of the custom field, as `fields` in `list_tasks` does; a number field reads the parameter as a number, and a yes-no field reads `true` or `false`. |
| `GET /api/tasks` with `label` | `project` and `label` (one label), optionally `limit` (1 to 200, default 100) and `after` | Every task of the project carrying the label, in every status and closed at any time, ordered by id, with `label` and `next`. `next` is the last task's id when more remain, and null on the last page; ask again with `after` set to it. `status`, `closedDays` and `field.<key>` are refused with `label`, and `limit` and `after` without it. |
| `GET /api/tasks` with `stage` | `project` and `stage`, a comma-separated list of `built`, `merged` and `live`; optionally `status=closed` and `closedDays` | The board's answer, holding the project's closed tasks at those stages, whenever they closed unless `closedDays` is given ([delivery](#delivery)) |
| `GET /api/tasks/:id` | `project` | The task, its comments and its proposal |
| `GET /api/tasks/:id/history` | `project`, optionally `limit` (1 to 200, default 100) | `{ changes }`, newest first |
| `GET /api/changes` | optionally `after` (default 0), `limit` (1 to 200, default 100) and `project` | `{ events, lastSeq }` |
| `GET /api/fields` | `project` | `{ project, fields }`: the project's key and its custom fields, as `list_fields` lists them |
| `GET /api/tasks/agent-stats` | optionally `project` | `{ readAt, projects, broken, stats }`, as `get_agent_stats` answers ([agent statistics](#agent-statistics)): of the project, or of every project the sender reaches |

### Writes

Each write takes one JSON object of at most 32 KB, sent as
`application/json`, with no key twice, and no query. A browser may send one
only from the Worker's own origin. Each runs the same write as the MCP tool
that does the same thing, so it keeps [the same rules](#the-rules-a-write-keeps).

| Route | Body | Answer |
|---|---|---|
| `POST /api/tasks` | `projectId`, `title`, and optionally `description`, `type`, `priority`, `labels`, `parent`, `acceptance`, `notes`, `design`, `estimateMinutes`, `dueAt`, `externalLinks`, `fields`, `metadata`, `card` and `changeClass` | `{ id, project }`: the new task's id and its project's key |
| `PATCH /api/tasks/:id` | `projectId` and at least one of `status`, `priority`, `title`, `description`, `assignee`, `parent`, `defer`, `acceptance`, `notes`, `design`, `estimateMinutes`, `dueAt`, `addLabels`, `removeLabels`, `addExternalLinks`, `removeExternalLinks`, `fields`, `card` and `changeClass`; or `projectId` and `claim: true` to take the task, optionally with `for` and `work`, an object of the work details `claim_task` takes | `{ task }`, the task as changed |
| `POST /api/tasks/:id/comments` | `projectId`, `text` | `{ comment }` |
| `POST /api/tasks/:id/close` | `projectId`, `reason`, and optionally `resolution`, `duplicateOf`, `commit` and `pullRequest` | `{ task }`, the task as closed |
| `POST /api/delivery` | `repository`, `stage`, and at least one of `pullRequests` and `commits` | `{ moved }`: each task the signal moved, as `{ id, stage }` ([delivery](#delivery)) |
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
none.

A task answers its holder's work in hand as `for`, `work` and
`lastActivityAt`, as `get_task` does.

NoticeOS answered a change, a comment and a close with its task client's own
output; Ntasks answers them with the task or the comment, in the shapes the
reads use.

### A person's decisions

These routes take a person's own decision. Only a person signed in to the
web app may send one (`tasks:decide`), in a project they may change; any
other sender gets `403` with `insufficient_scope` and a `detail` saying so,
and nothing changes. Each takes one JSON object and the optional
`Idempotency-Key` header, as the other writes do, is one write, and answers
`{ task }`, the task as the decision left it. The task records the person as
the closer or the author of the comment, and its history records who decided
and when.

| Route | Body | What it does |
|---|---|---|
| `POST /api/tasks/:id/respond` | `projectId`, `response` (at most 4,086 characters) | Answers a task labelled `human` that is not closed and not an approval. A reply that names one of the task's options, such as `B`, `the recommendation` or an option's label, is that pick, as `choose` makes it. Otherwise a decision closes as `done` with the reason `Responded` and the comment `Response: <response>`, and any other task goes back to ready work: open, unassigned, without the `human` label, with the comment `Answered: <response>`. A reply that leaves the question open, such as `maybe` or a bare `yes` to a task with options, is refused. |
| `POST /api/tasks/:id/choose` | `projectId`, `option` (`a` to `f`), and optionally `note` (at most 2,000 characters) | Picks one of the task's options. The pick records the option, its label, the person and the time, with the comment `Chose (b) <label>.` and the note. A decision then closes with the reason `Chose (b) <label>`, past an open blocker or another holder; any other task goes back to ready work. A second pick is refused; the same person sending the same option again finishes a pick that stopped before its comment or its close. |
| `POST /api/tasks/:id/dismiss` | `projectId`, and optionally `reason` (at most 2,037 characters), `resolution` (any but `done`; `wont-do` when left out) and, with `duplicate` only, `duplicateOf` | Declines a task labelled `human`: it closes with the reason `Dismissed` or `Dismissed: <reason>`. A duplicate is linked to the task it duplicates as `related`. |
| `POST /api/gates/:id/resolve` | `projectId`, and optionally `reason` | Approves an approval: it closes as `done` with the reason, `Approved` when left out, and the tasks waiting on it are free of it. Each of them labelled `human` that is not a decision and offers no options goes back to ready work, open, unassigned and without the label, with a comment to keep within the approval, as after an approval an agent relays. An approval an agent relayed on it before can no longer be disputed. |
| `POST /api/tasks/:id/dispute` | `projectId` | Withdraws an approval an agent relayed with `reconcile_task`: its record loses its permission and names who disputed it, the approval opens again, and it and each task waiting on it get a comment saying the recorded action must stop until a new approval. Disputing it again changes nothing, and tells the waiting tasks nothing again. Once the person approves it directly, a dispute of it is refused. |

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
- a list or a board reads about ten rows for each task it returns;
- `list_tasks` reads the external links of the tasks on the page it returns,
  in one statement after the board, and no other task's;
- a label read reads about fifteen rows for each task carrying the label in
  that project, however many tasks the project has;
- a task's custom field values are part of its row, so they cost no row of
  their own, and a filter by them tests the rows the read reaches anyway; it
  adds one statement, which reads the project's fields;
- agent statistics read one row for each task in progress, blocked or closed
  in the last eight weeks, in one statement over every project, however many
  tasks the projects hold;
- the statements a read runs do not grow with the number of projects or
  tasks: at most six, for a board filtered by a custom field.

[`read-cost.test.ts`](../workers/api/test/api/read-cost.test.ts) seeds a store
of eight projects and about 7,000 tasks and fails when a read goes over its
budget. Run it with `--silent=false` to print each read's statements and rows
read. [`store.test.ts`](../workers/api/test/store.test.ts) checks that a
repeated read reads no rows.
