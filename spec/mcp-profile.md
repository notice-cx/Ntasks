# 11. The MCP tool profile

Part of [the protocol](protocol.md). Draft, v0, 2026-11-09.

The MCP tool profile is a set of [MCP](https://modelcontextprotocol.io/specification/latest)
tools through which an agent reaches a server. Each tool below is one that
Ntasks serves today, at `/api/mcp`, mapped to the protocol's operations and
conformance levels. Ntasks's [API reference](../docs/api.md#the-mcp-endpoint)
gives every argument and answer in full; the tools' input schemas are in
[`workers/api/src/mcp/`](../workers/api/src/mcp/).

## 11.1 Transport and sign-in

| Setting | Ntasks |
|---|---|
| Transport | Streamable HTTP: `POST` of one JSON-RPC message, answered whole. No session, no streaming |
| Protocol revisions | 2026-07-28, where every request names its revision, and 2025-11-25, 2025-06-18 and 2025-03-26 through an `initialize` handshake |
| Sign-in | OAuth 2.1 with PKCE; the client finds the authorization server from `/.well-known/oauth-protected-resource/api/mcp` and registers itself (RFC 7591) |
| Server name | `ntasks`. The [Ntasks skill](../skills/ntasks/SKILL.md) names its tools by this server name |

**MCP-1.** <a id="mcp-1"></a>A server's instructions, which an agent reads
when it connects, MUST list the open tasks the sender holds
([INV-10](protocol.md#inv-10)) before any longer text, so that a client
that shows only the start of the instructions still shows them. Ntasks lists
at most ten, within the first 4,096 characters, one line each with the
task's id, title, helper, branch, next step and last activity, then a line
with how many more there are and the `list_tasks` call that lists them.

## 11.2 Arguments every tool shares

| Argument | Meaning |
|---|---|
| `workspace` | The workspace the call acts in, from `list_workspaces`. A sender that reaches one workspace may leave it out |
| `project` | A project by its id, key or prefix. A tool that names a task takes the project from the task id's prefix |
| `idempotency_key` | The caller's key for this change ([INV-3](protocol.md#inv-3)) |
| `model` | The model the agent runs as, recorded beside its actor ([INV-12](protocol.md#inv-12)) |
| `detail` | `full` to answer with the whole task; left out, a write answers with the task's id, its `version` and the fields it changed |

**MCP-2.** <a id="mcp-2"></a>A write sent without `idempotency_key` SHOULD
be answered once: Ntasks keys it by the SHA-256 of its workspace, its
sender, the tool and its arguments, and repeats the first answer only while
every task that answer wrote is unchanged since, and for a new task for 24
hours ([OQ-11](open-questions.md#oq-11)). Claiming, releasing and claiming
a task again therefore claims it twice.

## 11.3 Tools by level

### Core

| Contract operation | Tool | Notes |
|---|---|---|
| Choose a workspace | `list_workspaces` | Each workspace the sender reaches, its role and scopes there, and the guide's version |
| List projects | `list_projects` | `projectId`, `key`, `name`, `prefix`, `deploys` |
| List tasks, ready work | `list_tasks` | Most urgent first: open tasks and those closed in the last 7 days. `ready: true` for ready work ([STATE-3](protocol.md#state-3)), `assignee: "me"` for the sender's own, `stalled: true` for stalled tasks ([STATE-16](protocol.md#state-16)), `query` to search |
| Read a task | `get_task` | The task ([schema](schemas/task.schema.json)), its comments, its `proposal` and `proposalVersion`, and for an epic its `openChildren`. `tasks` reads up to 50 |
| Read history | `get_task_history` | Each change newest first ([schema](schemas/history-event.schema.json)); `snapshots` for whole versions |
| File | `create_task`, `create_tasks` | `claim: true` files it claimed; `done` files finished work closed as done, with its proof. `create_tasks` files up to 25, each refused or filed on its own |
| Change, release, hand over, reopen | `update_task` | `assignee: ""` releases; another `assignee` hands the task over, from its holder only ([STATE-6](protocol.md#state-6)); a `status` on a closed task reopens it ([STATE-8](protocol.md#state-8)) |
| Claim | `claim_task` | Refused as held when someone else holds the task ([INV-1](protocol.md#inv-1)) |
| Comment | `comment_on_task` | `tasks` comments on up to 50 |
| Link | `link_tasks` | Sets or, with `remove: true`, removes the one link between two tasks ([INV-11](protocol.md#inv-11)). Takes no key: asking again changes nothing |
| Close | `close_task` | `resolution` (`done` when left out), `reason`, `duplicate_of`, and the proof `commit`, `pr` or `link`. `tasks` closes several and `with_children` an epic's open tasks first, at most 50 in all; the answer lists `unblocked` |
| Release a task whose holder stopped | `reconcile_task`, action `release` | With `holder`, `inactive: true`, `activity_check` and `progress` ([AUTH-9](protocol.md#auth-9)). A person frees a task on their own call over HTTP |

### Human decisions and approvals

| Contract operation | Tool | Notes |
|---|---|---|
| Ask a person to choose | `create_task`, `update_task` with `choices` and the `human` label | Exactly one option `recommended` |
| Ask for an approval | `request_human_approval`, or `create_task` with `approval` | `title` and `description`, or `reason` alone, whose first line becomes the title. Answers the approval and `created`; the same request again returns the open one ([STATE-10](protocol.md#state-10)) |
| Record a relayed answer | `reconcile_task`, action `answer`, `declined` or `owner_performed` | `proposal_version`, `quote`, `source`, and `option` on a task with choices ([AUTH-3](protocol.md#auth-3)) |
| Record a relayed acceptance as done | `reconcile_task`, action `accepted` | `proposal_version`, `quote`, `source`, and `met`: the numbers of the criteria the person found met, `[]` when none is ([AUTH-11](protocol.md#auth-11)) |
| Retire a request with evidence | `reconcile_task`, action `completed`, `obsolete`, `superseded` or `duplicate` | `explanation` and `evidence`, and `duplicate_of` for a duplicate ([AUTH-7](protocol.md#auth-7)) |
| Take the `human` label off routine work | `reconcile_task`, action `routine` | `explanation` and `evidence` ([AUTH-8](protocol.md#auth-8)) |

A person's direct answers have no MCP tool: they are HTTP routes that only a
person signed in to the server's own interface may call
([A person's decisions](http-binding.md#a-persons-decisions)). An answer recorded
through the MCP endpoint is relayed, whoever sends it
([AUTH-3](protocol.md#auth-3)).

### Delivery

| Contract operation | Tool | Notes |
|---|---|---|
| Close with a commit or pull request | `close_task` with `commit` or `pr` | Starts the delivery at `built` ([STATE-12](protocol.md#state-12)) |
| Send a signal | `report_delivery` | `repository`, `stage` (`merged` or `live`), and up to 100 `pull_requests` and 100 `commits`. Answers each task it moved |
| List by stage | `list_tasks` with `stage` | Closed tasks at that stage, with a count of each stage |

### Live work

| Contract operation | Tool | Notes |
|---|---|---|
| Record work in hand | `claim_task`, `comment_on_task` with `for`, `session`, `worktree`, `branch`, `pr`, `commit`, `next` | From the holder only, while the task is open ([STATE-13](protocol.md#state-13)) |
| Claim by pull request | `claim_task` with `pr` and no `task` | The open task whose work details or `pull-request` external link name that pull request |
| Held tasks on connect | The server's instructions | [MCP-1](#mcp-1) |

### Outside the protocol

These Ntasks tools and answers are Ntasks's own. A server MAY offer them;
the protocol defines none of them.

| Tool or field | What it is |
|---|---|
| `get_task_guide` | Ntasks's rules for task work, as text with a version |
| `get_agent_stats` | Counts of agents' work by model |
| `list_fields`, `define_field`, `retire_field` | Custom fields ([EXT-2](protocol.md#ext-2)), which the protocol describes but no level requires |
| `card`, `change_class` arguments | Facts NoticeOS ranks tasks by ([EXT-4](protocol.md#ext-4)) |
| `lint`, `possibleDuplicates`, `warnings` in answers | Advice on a write: sections a task lacks, a title over 70 characters or holding a command, a file path or a commit hash, a command written inline in a description, a description that repeats its title, an ask to a person that names no place to act, open tasks with similar titles, texts that cite what a reader cannot check |

## 11.4 Refusals

**MCP-3.** <a id="mcp-3"></a>A refused call MUST answer with a tool result
marked as an error, and nothing of it is stored
([INV-5](protocol.md#inv-5)). In Ntasks its first line is one sentence that
starts with what kind of refusal it is:

| Start | Means |
|---|---|
| `invalid arguments: …` | An argument is missing, unknown or out of range, named by its path. An unknown argument is named with the one most likely meant ([EXT-3](protocol.md#ext-3)) |
| `refused: …` | The task's state, the sender's reach or a rule of the protocol stops the change, and what to do instead |
| `conflict: …` | The idempotency key was first used for a different change ([INV-3](protocol.md#inv-3)) |
| `unavailable: …` | The server did not complete the change |

Its last line names the task when the sentence does not, then says whether
a retry is safe: `Nothing was written; retrying is safe.`, or only after
`unavailable: …`, `The change may have been written; read the task before
retrying.`

## 11.5 Limits

The largest values Ntasks takes in a new write. A server SHOULD publish its
own.

| Value | At most |
|---|---|
| One MCP message | 256 KB |
| `title` | 512 characters |
| `description`, `acceptance`, `notes`, `design` | 8,192 characters each |
| A comment | 4,096 characters |
| A close's `reason` | 2,048 characters |
| An approval's `title` | 70 characters |
| An approval's `description` | 2,048 characters; `reason`, 400 |
| `labels` | 32, each 128 characters |
| `external_links` | 32; a URL 2,048 characters, a title 512 |
| `choices` | 2 to 6 options; question 400, label 120, detail 600 characters; a pick's note 2,000 |
| `for` | 64 characters |
| `session`, `worktree`, `next` / `branch` / `commit` / `pr` | 512 / 255 / 128 characters / a 2,048-character URL |
| Custom fields | 64 a project; 64 options a field |
| Tasks in one `create_tasks` / `get_task`, `comment_on_task` or `close_task` | 25 / 50 |
| Tasks in one page of `list_tasks` | 200 |
| Pull requests and commits in one signal | 100 of each |
