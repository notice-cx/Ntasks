# The Shared Work Protocol over GitHub issues

`@ntasks/github-adapter` is a server that implements the
[Shared Work Protocol](../../spec/protocol.md)'s core level over a GitHub
repository's issues. Agents reach it through the protocol's
[MCP tool profile](../../spec/mcp-profile.md); people keep reading and
writing the same issues in GitHub. It is the protocol's second
implementation, after Ntasks, and shares no code with Ntasks's Worker.

| Level | Passes | How |
|---|---|---|
| Core | Yes, against a stand-in for GitHub's API | Every check of the [conformance suite](../../spec/conformance/README.md)'s core level, in CI, over [`conformance/fake-github.ts`](conformance/fake-github.ts). The suite has not been run against GitHub itself |
| Human decisions and approvals | Not implemented | `reconcile_task` takes only `release`; there is no approval or decision tool |
| Delivery | Not implemented | A close records its commit or pull request, but there is no `report_delivery` |
| Live work | Not implemented | Work details are recorded on a claim and a comment, but a connecting agent is not told the tasks it holds |

## How the protocol maps onto GitHub

A **project** is one repository's issues, or the issues of one that carry a
label, so one repository can hold several projects. A task's id is the
project's prefix and the issue number, as `web-42`. An issue filed in GitHub,
with the project's label when the project has one, is a task the adapter
lists and reads from GitHub; the first write through the adapter records it
in the ledger, with a `created` event naming the issue's GitHub author.

GitHub holds what people read there; the adapter's **ledger**, a JSON file
it alone writes, holds what GitHub cannot.

| The protocol's | In GitHub | In the ledger |
|---|---|---|
| Title, description | The issue's title and body | A copy, which reads answer |
| Labels | The issue's labels, beside the project's label | A copy |
| `open` and `closed` | The issue's state; a close as `done` sets the reason `completed`, any other `not_planned` | The status |
| `in_progress`, `blocked`, `deferred`, a defer date | — | The status and date |
| Type, priority, acceptance, notes, design, metadata | — | Each field |
| The holder, the helper, work in hand | — | Each field. Agents and services are not GitHub users, so no assignee is set |
| A comment | An issue comment, ending in a line naming its sender, such as `— agent:Claude Code` | The sender, by the comment's id |
| A close's reason, resolution and proof | A comment giving the resolution, the reason and the proof | Each field |
| Links (`blocks`, `related`, `discovered-from`, `duplicates`, `supersedes`, `merges-after`) and a parent | — | Each link, one between two tasks. A read of either task shows it: among `dependencies` on the task that holds it, among `dependents` on the other |
| Version, history, retry keys | — | Every change, its actor, model and time, and each write's first answer by its key |

Every write goes through one GitHub token, so GitHub names the token's
account as the author of every issue, edit and comment the adapter makes.
The ledger is what records who made each change, and the protocol's rules
are kept there:

- **Authority comes from the adapter's own sign-in.** Each sender has a
  token the configuration names by its SHA-256, and is an agent, a service
  or a person. Changes are recorded as `agent:<name>`, `service:<name>` or the
  person's name ([AUTH-2](../../spec/protocol.md#auth-2)). A sender reaches the
  projects its configuration grants, each for reading or for writing too
  ([AUTH-10](../../spec/protocol.md#auth-10)).
- **One claim wins, and no claim expires.** Writes run one after another, so
  of two claims sent at once one is refused as held
  ([INV-1](../../spec/protocol.md#inv-1)); a claim ends only when its holder
  releases it, the task closes, or another sender releases it with the
  evidence [AUTH-9](../../spec/protocol.md#auth-9) asks for.
- **A write and its history are kept together.** Each write checks its rules
  against the ledger, makes its GitHub calls, then writes the ledger with the
  change, its history event and its retry record. A write GitHub refuses
  leaves the ledger as it was ([INV-5](../../spec/protocol.md#inv-5)).
- **Only a person closes a task waiting on one.** A task labelled `human`
  waits on a person: an agent's or a service's close of it is refused, and a
  person closes it through the adapter, signed in as a `person` sender.

### Limits

- **Edits made in GitHub are not read back into the ledger.** Once the
  ledger records a task, reads answer its title, description, labels and
  status from the ledger, so an edit, close or reopen made in GitHub's own
  interface shows in GitHub only. Comments are the exception: reads list
  every comment on the issue, and one posted in GitHub reads as by its
  GitHub author.
- **Comments posted in GitHub can be edited or deleted there**, which the
  protocol does not allow ([INV-6](../../spec/protocol.md#inv-6)).
- **One process owns a ledger file.** Two adapters over one ledger would not
  see each other's writes.
- **A write GitHub takes but the ledger fails to save is not recovered.**
  When saving the ledger file fails after GitHub accepted a write, such as on
  a full disk, GitHub keeps the change without its ledger record, and the
  same call sent again can file a second issue.
- **Each project's tasks are listed from GitHub on every list**, so a
  repository with thousands of issues answers slowly.

## Run it

With Node.js 24 and `pnpm install` at the repository root:

```sh
GITHUB_TOKEN=… node packages/github-adapter/src/main.ts --config adapter.json --port 8790
```

It serves the MCP endpoint at `http://127.0.0.1:8790/mcp`. `GITHUB_TOKEN` may
read and write the configured repositories' issues; a fine-grained token
needs **Issues: Read and write** on each of them. The configuration file:

```json
{
  "githubApi": "https://api.github.com",
  "ledger": "./ledger.json",
  "projects": [
    { "projectId": "web", "key": "web", "name": "Website", "prefix": "web", "repository": "example/site" }
  ],
  "senders": [
    {
      "kind": "agent",
      "name": "Claude Code",
      "tokenSha256": "<the SHA-256 of the agent's bearer token, in hexadecimal>",
      "projects": { "web": "write" }
    }
  ]
}
```

| Field | Holds |
|---|---|
| `githubApi` | GitHub's API address |
| `ledger` | The ledger file, or `null` to keep the ledger in memory |
| `projects` | Each project: its `projectId`, `key`, `name`, `prefix` (lowercase letters and digits), `repository` (`owner/name`) and optionally `label` |
| `senders` | Each sender: `kind` (`agent`, `service` or `person`), `name`, `tokenSha256` and `projects`, each project's id with `read` or `write` |

An agent sends its token as `Authorization: Bearer <token>`. Make a token
and its hash with `openssl rand -base64 32` and
`printf %s "$TOKEN" | shasum -a 256`.

## Check it

```sh
pnpm --filter @ntasks/github-adapter test
pnpm --filter @ntasks/github-adapter run conformance
```

The tests run the conformance suite's core level against the adapter over
[`conformance/fake-github.ts`](conformance/fake-github.ts), a stand-in for
the GitHub API calls the adapter makes, so no run needs a GitHub token. They
also run the suite's [broken server](../../spec/conformance/fixtures/broken.ts)
in front of the adapter and expect each of its core-level defects to fail
exactly that rule's checks, and they check the issues and comments the
adapter writes. `run conformance` prints the suite's report.

The core level's pass rests on that stand-in: no run against GitHub itself
has been made. With `SWP_GITHUB_REPOSITORY=owner/name` and `GITHUB_TOKEN`,
`run conformance` runs against that repository on GitHub instead, filing over a hundred
issues and their comments, one write a second. Point it only at a repository made for the
run, and delete the repository afterwards.

## Files

| Path | Holds |
|---|---|
| `src/engine.ts` | The protocol's core rules over the ledger and GitHub |
| `src/ledger.ts` | The ledger and its file |
| `src/github.ts` | The GitHub REST calls |
| `src/mcp.ts`, `src/args.ts` | The MCP tools and their arguments |
| `src/server.ts`, `src/main.ts` | The HTTP server, its sign-in, and the command that runs it |
| `conformance/` | The stand-in for GitHub and the suite's run against the adapter |
| `test/` | The tests |
